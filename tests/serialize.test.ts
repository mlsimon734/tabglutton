import { describe, expect, test } from "bun:test";

import { createTaskQueue } from "../src/serialize.js";

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
