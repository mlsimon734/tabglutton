import { describe, expect, test } from "bun:test";
import {
  buildDigestView,
  digestId,
  digestUndoState,
  effectiveFate,
  exclusionFor,
  findCloseBatch,
  freshDigest,
  isSenderPage,
  observeReport,
  parseDigestStore,
  planDigestAction,
  recheckTarget,
  resolveDigestItems,
  retainDigests,
  summarizeDigest,
  withAction,
  DIGEST_FRESH_MS,
  DIGEST_STORE_VERSION,
  type DigestItemRecord,
  type DigestRecord,
  type LiveTab,
} from "../src/digest.js";
import type { DigestReportParams } from "../src/bridge-protocol.js";
import type { UndoBatch } from "../src/undo-log.js";

const opts = {};

function tab(id: number, url: string, extra: Partial<LiveTab> = {}): LiveTab {
  return {
    id,
    url,
    windowId: 1,
    incognito: false,
    pinned: false,
    active: false,
    hidden: false,
    discarded: false,
    ...extra,
  };
}

function rec(
  tabIdHint: number,
  url: string,
  extra: Partial<DigestItemRecord> = {},
): DigestItemRecord {
  return {
    url,
    title: url,
    fate: "close",
    reason: "r",
    tabIdHint,
    anchor: { windowId: 1, incognito: false },
    observed: { open: true },
    ...extra,
  };
}

function record(items: DigestItemRecord[], extra: Partial<DigestRecord> = {}): DigestRecord {
  return {
    id: "0".repeat(32),
    receivedAt: 1000,
    reporter: {},
    sitting: { sources: [] },
    items,
    closes: [],
    mirror: { state: "pending" },
    ...extra,
  };
}

describe("resolveDigestItems", () => {
  test("hint hit: id and URL agree", () => {
    const [r] = resolveDigestItems(
      [rec(5, "https://a.test/x")],
      [tab(5, "https://a.test/x")],
      opts,
    );
    expect(r).toEqual({ kind: "exact", tab: tab(5, "https://a.test/x") });
  });

  test("normalized match: the agent saw Gullet's shortened URL", () => {
    const [r] = resolveDigestItems(
      [rec(5, "https://a.test/x")],
      [tab(5, "https://www.a.test/x/?utm_source=feed")],
      opts,
    );
    expect(r?.kind).toBe("exact");
  });

  test("stale hint falls back to the one tab on that URL in the same window (Chrome discard)", () => {
    const [r] = resolveDigestItems(
      [rec(5, "https://a.test/x")],
      [tab(99, "https://a.test/x"), tab(5, "https://other.test/")],
      opts,
    );
    expect(r?.kind).toBe("fallback");
    expect(r && "tab" in r ? r.tab.id : null).toBe(99);
  });

  test("hint pointing at a navigated tab, with no other candidate, is gone", () => {
    const [r] = resolveDigestItems([rec(5, "https://a.test/x")], [tab(5, "https://b.test/")], opts);
    expect(r).toEqual({ kind: "gone" });
  });

  test("two candidates are ambiguous — never picked by recency", () => {
    const [r] = resolveDigestItems(
      [rec(5, "https://a.test/x")],
      [
        tab(7, "https://a.test/x", { lastAccessed: 10 }),
        tab(8, "https://a.test/x", { lastAccessed: 99 }),
      ],
      opts,
    );
    expect(r).toEqual({ kind: "ambiguous" });
  });

  test("a candidate in another window or privacy context does not count", () => {
    const other = resolveDigestItems(
      [rec(5, "https://a.test/x")],
      [tab(7, "https://a.test/x", { windowId: 2 })],
      opts,
    );
    expect(other[0]).toEqual({ kind: "ambiguous" });
    const privateTab = resolveDigestItems(
      [rec(5, "https://a.test/x")],
      [tab(7, "https://a.test/x", { incognito: true })],
      opts,
    );
    expect(privateTab[0]).toEqual({ kind: "ambiguous" });
  });

  test("no anchor means no fallback", () => {
    const [r] = resolveDigestItems(
      [rec(5, "https://a.test/x", { anchor: undefined })],
      [tab(7, "https://a.test/x")],
      opts,
    );
    expect(r).toEqual({ kind: "ambiguous" });
  });

  test("an uncommitted tab (empty url: Chrome pendingUrl, Gecko about:blank) matches nothing", () => {
    const [chrome] = resolveDigestItems([rec(5, "https://a.test/x")], [tab(5, "")], opts);
    expect(chrome).toEqual({ kind: "gone" });
    const [gecko] = resolveDigestItems([rec(5, "https://a.test/x")], [tab(5, "about:blank")], opts);
    expect(gecko).toEqual({ kind: "gone" });
  });

  test("two items on one page each keep their own tab", () => {
    const rs = resolveDigestItems(
      [rec(1, "https://a.test/x"), rec(2, "https://a.test/x")],
      [tab(1, "https://a.test/x"), tab(2, "https://a.test/x")],
      opts,
    );
    expect(rs.map((r) => ("tab" in r ? r.tab.id : r.kind))).toEqual([1, 2]);
  });

  test("a fallback cannot take a tab another item already holds exactly", () => {
    const rs = resolveDigestItems(
      [rec(1, "https://a.test/x"), rec(50, "https://a.test/x")],
      [tab(1, "https://a.test/x")],
      opts,
    );
    expect(rs.map((r) => r.kind)).toEqual(["exact", "ambiguous"]);
  });
});

describe("observeReport", () => {
  const items: DigestReportParams["items"] = [
    { tabId: 1, url: "https://a.test/", title: "A", fate: "close", reason: "r" },
    { tabId: 2, url: "https://b.test/", title: "B", fate: "worth-it", reason: "r" },
    { tabId: 3, url: "https://c.test/", title: "C", fate: "close", reason: "r" },
  ];
  test("records exact matches, their anchor, and the sitting's span", () => {
    const observed = observeReport(
      items,
      [
        tab(1, "https://a.test/", { lastAccessed: 500, discarded: true }),
        tab(2, "https://b.test/", { lastAccessed: 200, windowId: 4, pinned: true }),
        tab(3, "https://elsewhere.test/"),
      ],
      opts,
    );
    expect(observed.unmatched).toEqual([2]);
    expect(observed.firstAccessed).toBe(200);
    expect(observed.lastAccessed).toBe(500);
    expect(observed.items[0]).toMatchObject({
      tabIdHint: 1,
      anchor: { windowId: 1, incognito: false },
      observed: { open: true, lastAccessed: 500, discarded: true },
    });
    expect(observed.items[1]?.observed).toEqual({ open: true, lastAccessed: 200, pinned: true });
    expect(observed.items[2]).toMatchObject({ tabIdHint: 3, observed: { open: false } });
    expect(observed.items[2]?.anchor).toBeUndefined();
    expect("tabId" in (observed.items[0] ?? {})).toBe(false);
  });
});

describe("planDigestAction and recheck", () => {
  test("close excludes pinned and active; keep excludes pinned and hidden", () => {
    expect(exclusionFor(tab(1, "u", { pinned: true }), "keep")).toBe("pinned");
    expect(exclusionFor(tab(1, "u", { active: true }), "close")).toBe("active");
    expect(exclusionFor(tab(1, "u", { active: true }), "keep")).toBeNull();
    expect(exclusionFor(tab(1, "u", { hidden: true }), "keep")).toBe("hidden");
    expect(exclusionFor(tab(1, "u", { hidden: true }), "close")).toBeNull();
  });

  test("plans only the section's rows, counting moved rows in their new section", () => {
    const r = record([
      rec(1, "https://a.test/"),
      rec(2, "https://b.test/", { fate: "worth-it", userFate: "close" }),
      rec(3, "https://c.test/", { userFate: "worth-it" }),
      rec(4, "https://d.test/"),
      rec(5, "https://e.test/"),
      rec(6, "https://f.test/"),
    ]);
    const live = [
      tab(1, "https://a.test/"),
      tab(2, "https://b.test/"),
      tab(3, "https://c.test/"),
      tab(4, "https://d.test/", { pinned: true }),
      tab(5, "https://e.test/", { active: true }),
    ];
    const plan = planDigestAction(r, "close", live, opts);
    expect(plan.targets.map((t) => t.index)).toEqual([0, 1]);
    expect(plan.skipped).toEqual([
      { index: 3, outcome: "pinned" },
      { index: 4, outcome: "active" },
      { index: 5, outcome: "gone" },
    ]);
    const keep = planDigestAction(r, "keep", live, opts);
    expect(keep.targets.map((t) => t.index)).toEqual([2]);
  });

  test("recheck refuses a tab that navigated or got pinned since planning", () => {
    const target = { index: 0, tabId: 1, windowId: 1, url: "https://a.test/" };
    expect(recheckTarget(target, tab(1, "https://a.test/"), "close", opts)).toBeNull();
    expect(recheckTarget(target, tab(1, "https://b.test/"), "close", opts)).toBe("changed");
    expect(recheckTarget(target, tab(1, ""), "close", opts)).toBe("changed");
    expect(recheckTarget(target, tab(1, "https://a.test/", { pinned: true }), "keep", opts)).toBe(
      "pinned",
    );
    expect(recheckTarget(target, null, "close", opts)).toBe("gone");
  });
});

describe("close and undo state come from the undo log", () => {
  const items = [rec(1, "https://a.test/"), rec(2, "https://b.test/")];
  const batch = (id: string, urls: string[], closedAt = 2000): UndoBatch => ({
    id,
    closedAt,
    entries: urls.map((url) => ({ url, title: url, pinned: false, windowId: 1, index: 0 })),
  });

  test("by batch id", () => {
    const r = withAction(record(items), "close", {
      startedAt: 1500,
      batchId: "b1",
      outcomes: [],
    });
    const log = [batch("b1", ["https://a.test/", "https://b.test/"])];
    expect(digestUndoState(r, log, opts)).toEqual({ batchId: "b1", restorable: 2, closedAt: 2000 });
    // Undone (or evicted): the batch has left the log, so Undo goes away.
    expect(digestUndoState(r, [], opts)).toBeNull();
  });

  test("a lost batch-id write is recovered by shape", () => {
    const r = record(items, { closes: [{ startedAt: 1500, outcomes: [] }] });
    const log = [
      batch("later-other", ["https://zzz.test/"], 3000),
      batch("ours", ["https://a.test/"], 1600),
      batch("before", ["https://a.test/"], 1000),
    ];
    const close = r.closes[0];
    expect(close && findCloseBatch(r, close, log, opts)?.id).toBe("ours");
    expect(digestUndoState(r, log, opts)?.batchId).toBe("ours");
  });

  test("the newest restorable close wins, and history is capped", () => {
    let r = record(items);
    for (let i = 0; i < 7; i++) {
      r = withAction(r, "close", { startedAt: i, batchId: `b${i}`, outcomes: [] });
    }
    expect(r.closes.map((c) => c.batchId)).toEqual(["b6", "b5", "b4", "b3", "b2"]);
    const log = [batch("b4", ["https://a.test/"]), batch("b2", ["https://b.test/"])];
    expect(digestUndoState(r, log, opts)?.batchId).toBe("b4");
  });
});

describe("digestId", () => {
  test("stable across key order and reporter, sensitive to content", async () => {
    const a: DigestReportParams = {
      sitting: { label: "L", sources: ["x.com"] },
      items: [{ tabId: 1, url: "https://a.test/", title: "A", fate: "close", reason: "r" }],
      reporter: { client: "one" },
    };
    const b = {
      items: [{ reason: "r", fate: "close", title: "A", url: "https://a.test/", tabId: 1 }],
      sitting: { sources: ["x.com"], label: "L" },
      reporter: { client: "two" },
    } as DigestReportParams;
    const id = await digestId(a);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await digestId(b)).toBe(id);
    expect(await digestId({ ...a, items: [{ ...a.items[0]!, reason: "different" }] })).not.toBe(id);
  });
});

describe("store parsing and retention", () => {
  test("round-trips a valid store, newest first", () => {
    const older = record([rec(1, "https://a.test/")], { id: "a".repeat(32), receivedAt: 1 });
    const newer = record([rec(1, "https://a.test/")], { id: "b".repeat(32), receivedAt: 2 });
    const parsed = parseDigestStore({ v: DIGEST_STORE_VERSION, digests: [older, newer] });
    expect(parsed.digests.map((d) => d.id)).toEqual(["b".repeat(32), "a".repeat(32)]);
  });

  test("drops malformed records whole", () => {
    const good = record([rec(1, "https://a.test/")]);
    const bad = { ...good, id: 5 };
    const badItem = record([{ ...rec(1, "https://a.test/"), fate: "explode" } as never]);
    const badMirror = { ...good, mirror: { state: "written" } };
    expect(
      parseDigestStore({ v: 1, digests: [good, bad, badItem, badMirror] }).digests,
    ).toHaveLength(1);
  });

  test("an unknown version yields nothing and names the version", () => {
    expect(parseDigestStore({ v: 2, digests: [] })).toEqual({ digests: [], unknownVersion: 2 });
    expect(parseDigestStore("junk")).toEqual({ digests: [], unknownVersion: "string" });
    expect(parseDigestStore(undefined)).toEqual({ digests: [] });
  });

  test("retainDigests keeps the newest N", () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      record([rec(1, "https://a.test/")], { receivedAt: i }),
    );
    expect(retainDigests(list).map((d) => d.receivedAt)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(retainDigests(list, 3)).toHaveLength(3);
  });
});

describe("views", () => {
  test("effectiveFate prefers the user's move", () => {
    expect(effectiveFate({ fate: "close" })).toBe("close");
    expect(effectiveFate({ fate: "close", userFate: "worth-it" })).toBe("worth-it");
  });

  test("buildDigestView merges live state, outcomes, and undo", () => {
    const r = withAction(
      record([
        rec(1, "https://www.a.test/x", { fate: "worth-it" }),
        rec(2, "https://b.test/"),
        rec(3, "https://c.test/", { observed: { open: false }, anchor: undefined }),
      ]),
      "keep",
      { startedAt: 1, at: 2, outcomes: [{ index: 0, outcome: "grouped" }] },
    );
    const view = buildDigestView(
      r,
      [tab(1, "https://a.test/x", { favIconUrl: "https://a.test/f.ico", pinned: true })],
      [],
      opts,
    );
    expect(view.items[0]).toMatchObject({
      host: "a.test",
      live: "open",
      tabId: 1,
      pinned: true,
      favIconUrl: "https://a.test/f.ico",
      outcome: "grouped",
      unmatchedAtReport: false,
    });
    expect(view.items[1]).toMatchObject({ live: "gone" });
    expect(view.items[1]?.tabId).toBeUndefined();
    expect(view.items[2]?.unmatchedAtReport).toBe(true);
    expect(view.undo).toBeNull();
  });

  test("summary and the popup's freshness rule", () => {
    const r = record([rec(1, "https://a.test/", { fate: "worth-it" }), rec(2, "https://b.test/")], {
      sitting: { sources: ["x.com", "reddit.com"] },
      receivedAt: 10,
    });
    const summary = summarizeDigest(r);
    expect(summary).toMatchObject({ label: "x.com · reddit.com", items: 2, worthIt: 1 });
    expect(freshDigest([summary], 20)).toEqual(summary);
    expect(freshDigest([{ ...summary, openedAt: 15 }], 20)).toBeNull();
    expect(freshDigest([summary], 10 + DIGEST_FRESH_MS)).toBeNull();
    expect(freshDigest([], 0)).toBeNull();
  });
});

describe("isSenderPage", () => {
  const page = "moz-extension://abc/popup/devour.html";
  test("exact page only, hash and query ignored", () => {
    expect(isSenderPage("moz-extension://abc/popup/devour.html#digest", page)).toBe(true);
    expect(isSenderPage("moz-extension://abc/popup/devour.html?x=1", page)).toBe(true);
  });
  test("refuses other pages, other extensions, and web pages", () => {
    expect(isSenderPage("moz-extension://abc/notice/dup-notice.html", page)).toBe(false);
    expect(isSenderPage("moz-extension://abc/popup/popup.html", page)).toBe(false);
    expect(isSenderPage("moz-extension://evil/popup/devour.html", page)).toBe(false);
    expect(isSenderPage("https://abc/popup/devour.html", page)).toBe(false);
    expect(isSenderPage("moz-extension://abc/popup/devour.html/../x", page)).toBe(false);
    expect(isSenderPage(undefined, page)).toBe(false);
    expect(isSenderPage("::", page)).toBe(false);
  });
});
