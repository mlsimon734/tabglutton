import { describe, expect, test } from "bun:test";

import { createTaskPool, createTaskQueue, delay } from "../src/serialize.js";

/** A promise plus the handles to settle it later, so a test can control timing. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createTaskQueue", () => {
  test("does not start a task until the previous one has finished", async () => {
    const queue = createTaskQueue();
    const first = deferred<void>();
    const started: string[] = [];

    const a = queue(async () => {
      started.push("a");
      await first.promise;
      return "a";
    });
    const b = queue(async () => {
      started.push("b");
      return "b";
    });

    // `b` was enqueued while `a` was still running, so it must not have begun.
    await Promise.resolve();
    expect(started).toEqual(["a"]);

    first.resolve();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(started).toEqual(["a", "b"]);
  });

  test("runs tasks in the order they were enqueued, not the order they resolve", async () => {
    const queue = createTaskQueue();
    const finished: number[] = [];
    // Descending delays: without the queue, 3 would land first.
    const tasks = [30, 20, 10].map((ms, i) =>
      queue(async () => {
        await new Promise((r) => setTimeout(r, ms));
        finished.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(finished).toEqual([0, 1, 2]);
  });

  test("this is the interleave that loses an undo batch without it", async () => {
    // The exact shape of the bug: read, await, write. Two callers reading the
    // same array before either writes means the first write is lost.
    let stored: string[] = [];
    const readModifyWrite = async (value: string): Promise<void> => {
      const log = [...stored];
      await new Promise((r) => setTimeout(r, 5)); // the storage round trip
      stored = [value, ...log];
    };

    await Promise.all([readModifyWrite("batch-a"), readModifyWrite("batch-b")]);
    expect(stored).toEqual(["batch-b"]); // batch-a is gone

    stored = [];
    const queue = createTaskQueue();
    await Promise.all([
      queue(() => readModifyWrite("batch-a")),
      queue(() => readModifyWrite("batch-b")),
    ]);
    expect(stored).toEqual(["batch-b", "batch-a"]);
  });

  test("a rejecting task reaches its own caller and no one else", async () => {
    const queue = createTaskQueue();
    const boom = queue(async () => {
      throw new Error("nope");
    });
    const after = queue(async () => "still here");

    expect(boom).rejects.toThrow("nope");
    expect(await after).toBe("still here");
  });

  test("keeps running after a rejection rather than wedging", async () => {
    const queue = createTaskQueue();
    const order: string[] = [];
    const results = await Promise.allSettled([
      queue(async () => {
        order.push("one");
        throw new Error("one failed");
      }),
      queue(async () => {
        order.push("two");
        return 2;
      }),
      queue(async () => {
        order.push("three");
        return 3;
      }),
    ]);
    expect(order).toEqual(["one", "two", "three"]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });

  test("a task queued from inside a completed one still runs", async () => {
    // The undo log does this: recordClosed is reached from a method that may
    // itself have been queued behind another.
    const queue = createTaskQueue();
    const seen: string[] = [];
    await queue(async () => {
      seen.push("outer");
    });
    await queue(async () => {
      seen.push("inner");
    });
    expect(seen).toEqual(["outer", "inner"]);
  });

  test("independent queues do not block each other", async () => {
    const undoLog = createTaskQueue();
    const handoff = createTaskQueue();
    const blocked = deferred<void>();
    void undoLog(() => blocked.promise);
    // The handoff queue is a different resource, so it runs regardless.
    expect(await handoff(async () => "clipped")).toBe("clipped");
    blocked.resolve();
  });
});

describe("createTaskPool", () => {
  test("keeps at most `limit` tasks running", async () => {
    const pool = createTaskPool(3);
    const gate = deferred<void>();
    let running = 0;
    let peak = 0;

    const tasks = Array.from({ length: 10 }, () =>
      pool(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    expect(peak).toBe(3);
    gate.resolve();
    await Promise.all(tasks);
    expect(peak).toBe(3);
  });

  test("starts waiting tasks in call order as slots free up", async () => {
    const pool = createTaskPool(2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];

    const tasks = gates.map((gate, i) =>
      pool(async () => {
        started.push(i);
        await gate.promise;
      }),
    );

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve();
    await tasks[1];
    expect(started).toEqual([0, 1, 2]);
    gates[0]?.resolve();
    await tasks[0];
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2]?.resolve();
    gates[3]?.resolve();
    await Promise.all(tasks);
  });

  test("stays under the limit when new tasks arrive while it is draining", async () => {
    // Devour dispatches every save up front, but a bridge-shaped caller enqueues
    // as it goes — so the ceiling has to hold against tasks arriving one at a
    // time into a pool that is already handing slots back.
    const pool = createTaskPool(2);
    let running = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(20);
      running -= 1;
    };

    // Each task outlives several arrivals, so the pool is always both draining
    // and being enqueued into.
    const inFlight: Promise<void>[] = [];
    for (let i = 0; i < 8; i += 1) {
      inFlight.push(pool(task));
      await delay(1);
    }
    await Promise.all(inFlight);
    expect(peak).toBe(2);
    expect(running).toBe(0);
  });

  test("a rejecting task frees its slot and reaches only its own caller", async () => {
    const pool = createTaskPool(2);
    const results = await Promise.allSettled([
      pool(async () => {
        throw new Error("nope");
      }),
      pool(async () => "b"),
      pool(async () => "c"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });

  test("a limit of one runs strictly one at a time, like the queue", async () => {
    const pool = createTaskPool(1);
    const order: string[] = [];
    const slow = pool(async () => {
      await delay(5);
      order.push("slow");
    });
    const fast = pool(async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });

  test("refuses a limit that is not a positive whole number", () => {
    expect(() => createTaskPool(0)).toThrow(RangeError);
    expect(() => createTaskPool(-1)).toThrow(RangeError);
    expect(() => createTaskPool(1.5)).toThrow(RangeError);
  });
});
