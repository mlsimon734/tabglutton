// Task queues and pools: how many callers may touch a shared resource at once.
//
// The bridge serves requests concurrently — `bridge-client.ts` dispatches every
// incoming frame as its own `void this.onMessage(...)`, and the hub deliberately
// lets several agent sessions share one browser connection — so any bridge
// method touching a resource that belongs to the *browser* rather than to the
// request has to say so. Today that is the undo log in `storage.local` (a
// read-modify-write two closes can interleave and lose) and the OS clipboard the
// Obsidian handoff borrows.
//
// Not every shared resource wants one caller, though. The Zotero Connector
// serves concurrent saves by design — each carries its own session — so what its
// dispatch needs is a ceiling rather than a queue, and `createTaskPool` is that
// ceiling with `createTaskQueue`'s contract otherwise intact.
//
// Pure, so the ordering and error-isolation rules are unit-testable.

/** Runs tasks one at a time, in call order. See `createTaskQueue`. */
export type TaskQueue = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs tasks with a bounded number in flight. See `createTaskPool`. */
export type TaskPool = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A queue that runs each task to completion before starting the next, in the
 * order they were enqueued.
 *
 * A rejecting task is delivered to its own caller and to nobody else: the queue
 * keeps running, and the next task starts as if the failure had been a success.
 * That matters because these guard shared state — one clip that cannot reach the
 * clipboard must not wedge every later clip, and one close that fails to record
 * must not strand the undo log behind it.
 */
export function createTaskQueue(): TaskQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task);
    // Swallowed here rather than at the call site: `tail` exists only to order
    // the next task, so a rejection travelling down it would both stop the queue
    // and surface as an unhandled rejection nobody can act on. The caller still
    // sees the real one, through `next`.
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
}

/**
 * A pool that keeps at most `limit` tasks running, starting them in call order.
 *
 * `createTaskQueue()` is the `limit === 1` case, and the rest of its contract is
 * unchanged: a rejecting task is delivered to its own caller and to nobody else,
 * and it frees its slot exactly as a fulfilling one does.
 *
 * A freed slot is handed straight to the longest-waiting caller rather than
 * released and re-taken. Releasing it first would let a caller arriving in the
 * same tick claim it ahead of that waiter and put `limit + 1` tasks in flight —
 * which is the one thing a caller passes a limit to prevent.
 */
export function createTaskPool(limit: number): TaskPool {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`A task pool needs a positive whole limit, not ${limit}.`);
  }
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < limit) {
      running += 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/** Here rather than beside its callers because both halves import it — the
 * Obsidian handoff pacing in the extension, the election loop in the sidecar —
 * and this module is the one they already share. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
