import { describe, test, expect } from "bun:test";
import type { ClosedTabEntry } from "../src/bridge-protocol.js";
import {
  appendBatch,
  findBatch,
  parseUndoLog,
  removeBatch,
  retainEntries,
  UNDO_LOG_KEY,
  type UndoBatch,
} from "../src/undo-log.js";

function entry(url: string): ClosedTabEntry {
  return { url, title: url, pinned: false, windowId: 1, index: 0 };
}

function batch(id: string, count = 1, closedAt = 0): UndoBatch {
  return {
    id,
    closedAt,
    entries: Array.from({ length: count }, (_, i) => entry(`https://x/${id}/${i}`)),
  };
}

describe("appendBatch()", () => {
  test("puts the newest batch first so undo with no id means 'the last one'", () => {
    const log = appendBatch(appendBatch([], batch("a")), batch("b"));
    expect(log.map((b) => b.id)).toEqual(["b", "a"]);
  });

  test("does not mutate the input log", () => {
    const original: UndoBatch[] = [batch("a")];
    appendBatch(original, batch("b"));
    expect(original.map((b) => b.id)).toEqual(["a"]);
  });

  test("drops the oldest batches past the batch cap", () => {
    let log: UndoBatch[] = [];
    for (let i = 0; i < 5; i++)
      log = appendBatch(log, batch(`b${i}`), { maxBatches: 3, maxEntries: 100 });
    expect(log.map((b) => b.id)).toEqual(["b4", "b3", "b2"]);
  });

  test("drops the oldest batches past the entry cap", () => {
    let log: UndoBatch[] = [];
    log = appendBatch(log, batch("old", 5), { maxBatches: 10, maxEntries: 8 });
    log = appendBatch(log, batch("new", 5), { maxBatches: 10, maxEntries: 8 });
    expect(log.map((b) => b.id)).toEqual(["new"]);
  });

  test("keeps a single oversized batch whole — a partial undo is worse", () => {
    const log = appendBatch([], batch("huge", 50), { maxBatches: 10, maxEntries: 8 });
    expect(log).toHaveLength(1);
    expect(log[0]?.entries).toHaveLength(50);
  });

  test("keeps older batches that still fit under the entry cap", () => {
    let log: UndoBatch[] = [];
    log = appendBatch(log, batch("a", 2), { maxBatches: 10, maxEntries: 5 });
    log = appendBatch(log, batch("b", 2), { maxBatches: 10, maxEntries: 5 });
    expect(log.map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("findBatch()", () => {
  const log = [batch("b"), batch("a")];

  test("returns the newest batch when no id is given", () => {
    expect(findBatch(log)?.id).toBe("b");
  });

  test("returns the named batch", () => {
    expect(findBatch(log, "a")?.id).toBe("a");
  });

  test("returns null for an unknown id", () => {
    expect(findBatch(log, "zzz")).toBeNull();
  });

  test("returns null on an empty log", () => {
    expect(findBatch([])).toBeNull();
  });
});

describe("removeBatch()", () => {
  test("removes only the named batch", () => {
    expect(removeBatch([batch("a"), batch("b")], "a").map((b) => b.id)).toEqual(["b"]);
  });

  test("is a no-op for an unknown id", () => {
    expect(removeBatch([batch("a")], "zzz").map((b) => b.id)).toEqual(["a"]);
  });
});

describe("retainEntries()", () => {
  test("drops the batch when every tab came back", () => {
    expect(retainEntries([batch("a"), batch("b")], "a", []).map((b) => b.id)).toEqual(["b"]);
  });

  test("keeps the tabs that failed to reopen, so undo can be retried", () => {
    const stuck = entry("https://x/stuck");
    const log = retainEntries([batch("a", 3), batch("b")], "a", [stuck]);
    expect(log.map((b) => b.id)).toEqual(["a", "b"]);
    expect(log[0]?.entries).toEqual([stuck]);
  });

  test("leaves other batches and the batch's own id and time alone", () => {
    const log = retainEntries([batch("a", 2, 99)], "a", [entry("https://x/stuck")]);
    expect(log[0]).toMatchObject({ id: "a", closedAt: 99 });
  });

  test("is a no-op when the batch has already been evicted", () => {
    expect(retainEntries([batch("b")], "gone", [entry("https://x/1")]).map((b) => b.id)).toEqual([
      "b",
    ]);
  });
});

describe("parseUndoLog()", () => {
  test("round-trips a well-formed log", () => {
    const log = [batch("a", 2, 123)];
    expect(parseUndoLog(JSON.parse(JSON.stringify(log)))).toEqual(log);
  });

  test("returns an empty log for junk stored under the key", () => {
    expect(parseUndoLog(undefined)).toEqual([]);
    expect(parseUndoLog("nope")).toEqual([]);
    expect(parseUndoLog({ id: "a" })).toEqual([]);
  });

  test("drops malformed batches rather than failing the whole undo", () => {
    const good = batch("good");
    expect(parseUndoLog([good, { id: "no-entries" }, { entries: [] }])).toEqual([good]);
  });

  test("drops batches whose entries are not tab records", () => {
    expect(parseUndoLog([{ id: "a", closedAt: 0, entries: [{ nope: true }] }])).toEqual([]);
  });
});

describe("UNDO_LOG_KEY", () => {
  test("is namespaced so it cannot collide with a Settings field", () => {
    expect(UNDO_LOG_KEY).toBe("bridgeUndoLog");
  });
});
