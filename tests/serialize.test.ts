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

  test("holds the limit against a task arriving as a slot is handed over", async () => {
    // The handoff window: between a slot being freed and the waiting task
    // resuming, a caller arriving in that gap must not be able to take the slot
    // out from under the waiter and put `limit + 1` in flight.
    //
    // Where that window falls depends on how many microtask turns the pool takes
    // to get from a finished task to a resumed waiter, so the arrival is swept
    // across turns rather than pinned to one — a pool whose internals shift
    // would otherwise start passing this vacuously. Measured: an implementation
    // that releases the slot before waking the waiter peaks at 3 here.
    for (let turnsBeforeArrival = 0; turnsBeforeArrival <= 5; turnsBeforeArrival += 1) {
      const pool = createTaskPool(2);
      const finish = deferred<void>();
      const hold = deferred<void>();
      let running = 0;
      let peak = 0;
      const track = (until: Promise<void>) => async (): Promise<void> => {
        running += 1;
        peak = Math.max(peak, running);
        await until;
        running -= 1;
      };

      const first = pool(track(finish.promise));
      const second = pool(track(hold.promise));
      const waiter = pool(track(hold.promise));

      finish.resolve();
      for (let turn = 0; turn < turnsBeforeArrival; turn += 1) await Promise.resolve();
      const latecomer = pool(track(hold.promise));

      hold.resolve();
      await Promise.all([first, second, waiter, latecomer]);
      expect(peak).toBe(2);
      expect(running).toBe(0);
    }
  });

  test("a rejecting task frees its slot rather than wedging the pool", async () => {
    // A limit of one, and the next task enqueued only after the rejection has
    // been delivered: with more slots or an earlier enqueue the survivor would
    // inherit some *other* task's slot and a leak would go unnoticed.
    const pool = createTaskPool(1);
    await expect(
      pool(async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    const ran = await Promise.race([pool(async () => "ran"), delay(200).then(() => "wedged")]);
    expect(ran).toBe("ran");
  });

  test("a rejection reaches its own caller and nobody else", async () => {
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

  test("a limit of one runs strictly one at a time, in call order", async () => {
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
