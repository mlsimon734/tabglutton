import { describe, expect, test } from "bun:test";
import type { ClosedTabEntry } from "../src/bridge-protocol.js";
import {
  parseDigestStore,
  DIGEST_STORE_VERSION,
  type DigestActionRecord,
  type DigestItemRecord,
  type DigestRecord,
} from "../src/digest.js";
import {
  digestReceipt,
  receiptSegments,
  reopenWatchList,
  reviewSpan,
  withReopen,
  withUndone,
  REOPEN_WINDOW_MS,
} from "../src/digest-receipt.js";
import { normalizeUrl } from "../src/normalize.js";
import type { UndoBatch } from "../src/undo-log.js";

const opts = {};
const MIN = 60_000;
const T = 1_700_000_000_000;

function rec(url: string, extra: Partial<DigestItemRecord> = {}): DigestItemRecord {
  return {
    url,
    title: url,
    fate: "close",
    reason: "r",
    tabIdHint: 1,
    anchor: { windowId: 1, incognito: false },
    observed: { open: true },
    ...extra,
  };
}

function record(items: DigestItemRecord[], extra: Partial<DigestRecord> = {}): DigestRecord {
  return {
    id: "d".repeat(32),
    receivedAt: T,
    reporter: {},
    sitting: { sources: [] },
    items,
    closes: [],
    mirror: { state: "pending" },
    ...extra,
  };
}

function close(at: number, closed: number[], extra: Partial<DigestActionRecord> = {}) {
  return {
    startedAt: at,
    at,
    batchId: "b1",
    outcomes: closed.map((index) => ({ index, outcome: "closed" as const })),
    ...extra,
  };
}

function entry(url: string): ClosedTabEntry {
  return { url, title: url, windowId: 1, index: 0, pinned: false, incognito: false };
}

function key(url: string): string {
  const k = normalizeUrl(url, opts);
  if (k === null) throw new Error(`not a page: ${url}`);
  return k;
}

const A = "https://a.test/x";
const B = "https://b.test/y";
const C = "https://c.test/z";

describe("digestReceipt", () => {
  test("nothing until a Close has taken something", () => {
    expect(digestReceipt(record([rec(A)]), T)).toBeNull();
    const refused = record([rec(A)], {
      closes: [{ startedAt: T, at: T, outcomes: [{ index: 0, outcome: "active" }] }],
    });
    expect(digestReceipt(refused, T)).toBeNull();
  });

  test("counts the close, the review time, and the user's moves by section", () => {
    const r = record(
      [
        rec(A),
        rec(B),
        rec(C, { fate: "worth-it", userFate: "close" }),
        rec("https://d.test/", { fate: "worth-it", userFate: "close" }),
        rec("https://e.test/", { fate: "close", userFate: "could-not-read" }),
      ],
      { openedAt: T, closes: [close(T + 4 * MIN, [0, 1, 2, 3])] },
    );
    expect(digestReceipt(r, T + 5 * MIN)).toEqual({
      closed: 4,
      reopened: 0,
      undone: 0,
      moved: 3,
      moves: [
        { from: "worth-it", to: "close", count: 2 },
        { from: "close", to: "could-not-read", count: 1 },
      ],
      reviewMs: 4 * MIN,
      watching: true,
    });
  });

  test("review time runs to the first Close, not the latest", () => {
    const r = record([rec(A), rec(B)], {
      openedAt: T,
      closes: [close(T + 30 * MIN, [1], { batchId: "b2" }), close(T + 2 * MIN, [0])],
    });
    expect(digestReceipt(r, T + 31 * MIN)?.reviewMs).toBe(2 * MIN);
    expect(digestReceipt(r, T + 31 * MIN)?.closed).toBe(2);
  });

  test("review time runs to the first Close that took anything", () => {
    const r = record([rec(A)], {
      openedAt: T,
      closes: [
        close(T + 60 * MIN, [0], { batchId: "b2" }),
        { startedAt: T + MIN, at: T + MIN, outcomes: [{ index: 0, outcome: "failed" }] },
      ],
    });
    expect(digestReceipt(r, T + 61 * MIN)?.reviewMs).toBe(60 * MIN);
  });

  test("counts only what the held closes took, so nothing exceeds closed", () => {
    // Older closes fall off the record (`withClose` keeps the newest few); their
    // reopens and undos must not outnumber what the record still says closed.
    const r = record([rec(A), rec(B), rec(C)], {
      closes: [close(T, [0])],
      use: {
        reopened: [
          { index: 0, at: T + MIN },
          { index: 1, at: T - MIN },
          { index: 2, at: T - MIN },
        ],
        undone: [{ at: T - 2 * MIN, indexes: [1, 2] }],
      },
    });
    expect(digestReceipt(r, T + 2 * MIN)).toMatchObject({ closed: 1, reopened: 1, undone: 0 });
  });

  test("no review time without a first look", () => {
    const r = record([rec(A)], { closes: [close(T, [0])] });
    expect(digestReceipt(r, T)?.reviewMs).toBeUndefined();
  });

  test("the watch ends 48 hours after the close", () => {
    const r = record([rec(A)], { closes: [close(T, [0])] });
    expect(digestReceipt(r, T + REOPEN_WINDOW_MS - 1)?.watching).toBe(true);
    expect(digestReceipt(r, T + REOPEN_WINDOW_MS)?.watching).toBe(false);
  });
});

describe("reopenWatchList", () => {
  test("watches each closed item by its normalized page and privacy context", () => {
    const r = record([rec(A), rec(B, { anchor: { windowId: 2, incognito: true } }), rec(C)], {
      closes: [close(T, [0, 1])],
    });
    expect(reopenWatchList([r], opts, T + MIN)).toEqual([
      {
        digestId: r.id,
        index: 0,
        key: key(A),
        incognito: false,
      },
      {
        digestId: r.id,
        index: 1,
        key: key(B),
        incognito: true,
      },
    ]);
  });

  test("an item stops being watched once reopened, undone, or past the window", () => {
    const r = record([rec(A), rec(B), rec(C)], {
      closes: [close(T, [0, 1, 2])],
      use: { reopened: [{ index: 0, at: T + MIN }], undone: [{ at: T + 2 * MIN, indexes: [1] }] },
    });
    expect(reopenWatchList([r], opts, T + 3 * MIN).map((w) => w.index)).toEqual([2]);
    expect(reopenWatchList([r], opts, T + REOPEN_WINDOW_MS)).toEqual([]);
  });

  test("closing it again after an Undo watches it again, from the new close", () => {
    const r = record([rec(A)], {
      closes: [close(T + 10 * MIN, [0], { batchId: "b2" }), close(T, [0])],
      use: { reopened: [], undone: [{ at: T + MIN, indexes: [0] }] },
    });
    expect(reopenWatchList([r], opts, T + 11 * MIN)).toEqual([
      { digestId: r.id, index: 0, key: key(A), incognito: false },
    ]);
    // Watched for 48 hours from the second close, not the first.
    expect(reopenWatchList([r], opts, T + REOPEN_WINDOW_MS + 5 * MIN)).toHaveLength(1);
    expect(reopenWatchList([r], opts, T + 10 * MIN + REOPEN_WINDOW_MS)).toEqual([]);
  });
});

describe("withReopen", () => {
  const closed = record([rec(A), rec(B)], { closes: [close(T, [0])] });

  test("counts a closed item once", () => {
    const once = withReopen(closed, 0, T + MIN);
    expect(once?.use?.reopened).toEqual([{ index: 0, at: T + MIN }]);
    expect(once && withReopen(once, 0, T + 2 * MIN)).toBeNull();
  });

  test("refuses an item no close took, one Undo put back, and one past the window", () => {
    expect(withReopen(closed, 1, T + MIN)).toBeNull();
    const undone = { ...closed, use: { reopened: [], undone: [{ at: T + MIN, indexes: [0] }] } };
    expect(withReopen(undone, 0, T + 2 * MIN)).toBeNull();
    expect(withReopen(closed, 0, T + REOPEN_WINDOW_MS)).toBeNull();
  });
});

describe("withUndone", () => {
  const batch: UndoBatch = { id: "b1", closedAt: T, entries: [entry(A), entry(B), entry(C)] };

  test("marks what came back and withdraws reopens the Undo itself caused", () => {
    const r = record([rec(A), rec(B), rec(C)], {
      closes: [close(T, [0, 1, 2])],
      use: {
        // A was reopened by the user before the Undo; B's count is the Undo's own tab.
        reopened: [
          { index: 0, at: T + MIN },
          { index: 1, at: T + 5 * MIN + 1 },
        ],
        undone: [],
      },
    });
    // C failed to reopen, so it stays closed and watched.
    const next = withUndone(
      r,
      batch,
      [entry(A), entry("https://www.b.test/y")],
      T + 5 * MIN,
      T + 6 * MIN,
      opts,
    );
    expect(next?.use).toEqual({
      reopened: [{ index: 0, at: T + MIN }],
      undone: [{ at: T + 6 * MIN, indexes: [0, 1] }],
    });
    expect(next && digestReceipt(next, T + 7 * MIN)).toMatchObject({ reopened: 1, undone: 2 });
  });

  test("ignores a batch that is not one of this digest's closes", () => {
    const r = record([rec(A)], { closes: [close(T, [0], { batchId: "other" })] });
    expect(withUndone(r, batch, [entry(A)], T, T + MIN, opts)).toBeNull();
  });

  test("finds the batch by shape when the write after the close was lost", () => {
    const intent = record([rec(A)], { closes: [{ startedAt: T - 1, outcomes: [] }] });
    // The intent record names no item, so there is nothing of this digest to mark.
    expect(
      withUndone(intent, { ...batch, entries: [entry(A)] }, [entry(A)], T, T + MIN, opts),
    ).toBeNull();
  });
});

describe("the stored record", () => {
  test("keeps a well-formed use record and drops a digest whose use is malformed", () => {
    const good = record([rec(A)], {
      closes: [close(T, [0])],
      use: { reopened: [{ index: 0, at: T }], undone: [{ at: T, indexes: [0] }] },
    });
    const bad = {
      ...good,
      id: "e".repeat(32),
      use: { reopened: [{ index: "0", at: T }], undone: [] },
    };
    const parsed = parseDigestStore({ v: DIGEST_STORE_VERSION, digests: [good, bad] });
    expect(parsed.digests.map((d) => d.id)).toEqual([good.id]);
    expect(parsed.digests[0]?.use).toEqual(good.use);
  });
});

describe("receipt text", () => {
  test("reviewSpan reads at a glance", () => {
    expect(reviewSpan(30_000)).toBe("under a minute");
    expect(reviewSpan(4 * MIN + 59_000)).toBe("4 min");
    expect(reviewSpan(80 * MIN)).toBe("1 h 20 min");
    expect(reviewSpan(120 * MIN)).toBe("2 h");
    expect(reviewSpan(26 * 60 * MIN)).toBe("1 day");
    expect(reviewSpan(73 * 60 * MIN)).toBe("3 days");
  });

  test("reopened is always said; undo and moves only when they happened", () => {
    const flat = (r: Parameters<typeof receiptSegments>[0]) =>
      receiptSegments(r)
        .map((s) => `${s.lead}${s.n}${s.tail}`)
        .join(" · ");
    const base = { closed: 14, reopened: 0, undone: 0, moved: 0, moves: [], watching: true };
    expect(flat({ ...base, reviewMs: 4 * MIN })).toBe(
      "Closed 14, 4 min after opening · reopened 0 so far",
    );
    expect(flat({ ...base, reopened: 2, undone: 1, moved: 3, watching: false })).toBe(
      "Closed 14 · reopened 2 · undone 1 · you moved 3",
    );
  });
});
