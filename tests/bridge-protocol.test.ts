import { describe, test, expect } from "bun:test";
import {
  BRIDGE_PROTO,
  BRIDGE_PORT_CANDIDATES,
  BRIDGE_PROBE_BODY_PREFIX,
  BridgeRequestError,
  DEFAULT_BRIDGE_PORT,
  classifyBridgeProbe,
  deriveProof,
  generateToken,
  filterTabs,
  groupTabsByDomain,
  isBridgeMethod,
  matchesTabQuery,
  orderedBridgePortCandidates,
  parseMessage,
  parseTabClipParams,
  parseTabReadParams,
  parseTabsCloseParams,
  parseTabsListParams,
  parseTabsLoadParams,
  parseUndoCloseParams,
  selectTabs,
  tabDomain,
  TABS_LIST_DEFAULT_GROUP_LIMIT,
  TABS_LIST_DEFAULT_LIMIT,
  TABS_LIST_MAX_LIMIT,
  TABS_LOAD_MAX_BATCH,
  proofsMatch,
  randomNonce,
  type BridgeTab,
} from "../src/bridge-protocol.js";

/** A listing entry with only the fields a case actually exercises. */
function makeTab(fields: Partial<BridgeTab> & Pick<BridgeTab, "id" | "url">): BridgeTab {
  return { title: "", windowId: 1, index: 0, ...fields };
}

describe("constants", () => {
  test("port and proto are the documented values", () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(4589);
    expect(BRIDGE_PORT_CANDIDATES).toEqual([4589, 20317, 17483, 27613, 24193]);
    expect(BRIDGE_PORT_CANDIDATES[0]).toBe(DEFAULT_BRIDGE_PORT);
    expect(BRIDGE_PROTO).toBe(1);
  });
});

describe("automatic bridge discovery", () => {
  test("puts a valid cached port first without disturbing the canonical remainder", () => {
    expect(orderedBridgePortCandidates(17483)).toEqual([17483, 4589, 20317, 27613, 24193]);
  });

  test("ignores stale or unknown cached ports", () => {
    expect(orderedBridgePortCandidates(5000)).toEqual([...BRIDGE_PORT_CANDIDATES]);
    expect(orderedBridgePortCandidates()).toEqual([...BRIDGE_PORT_CANDIDATES]);
  });

  test("requires the current protocol marker before a candidate is compatible", () => {
    expect(classifyBridgeProbe(String(BRIDGE_PROTO), "")).toBe("compatible");
    expect(classifyBridgeProbe("2", BRIDGE_PROBE_BODY_PREFIX)).toBe("incompatible");
    expect(classifyBridgeProbe(null, `${BRIDGE_PROBE_BODY_PREFIX}\nForbidden`)).toBe("compatible");
    expect(classifyBridgeProbe(null, "tabglutton-bridge\nlegacy")).toBe("incompatible");
    expect(classifyBridgeProbe(null, "some other service")).toBe("foreign");
  });
});

describe("deriveProof()", () => {
  test("is deterministic for the same token and nonce", async () => {
    expect(await deriveProof("tok", "nonce")).toBe(await deriveProof("tok", "nonce"));
  });

  test("is a 64-char hex sha-256 digest", async () => {
    expect(await deriveProof("tok", "nonce")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("differs when the token differs", async () => {
    expect(await deriveProof("a", "n")).not.toBe(await deriveProof("b", "n"));
  });

  test("differs when the nonce differs — a replayed proof is useless", async () => {
    expect(await deriveProof("tok", "n1")).not.toBe(await deriveProof("tok", "n2"));
  });

  test("token and nonce are not confusable across the separator", async () => {
    expect(await deriveProof("a:b", "c")).not.toBe(await deriveProof("a", "b:c"));
  });
});

describe("proofsMatch()", () => {
  test("accepts identical strings", () => {
    expect(proofsMatch("abc", "abc")).toBe(true);
  });

  test("rejects differing strings of equal length", () => {
    expect(proofsMatch("abc", "abd")).toBe(false);
  });

  test("rejects differing lengths", () => {
    expect(proofsMatch("abc", "abcd")).toBe(false);
  });

  test("rejects empty against non-empty", () => {
    expect(proofsMatch("", "a")).toBe(false);
  });
});

describe("token and nonce generation", () => {
  test("tokens are 48 hex chars and unique", () => {
    const a = generateToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(generateToken());
  });

  test("nonces are 32 hex chars and unique", () => {
    const a = randomNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(randomNonce());
  });
});

describe("isBridgeMethod()", () => {
  test("accepts every shipped method", () => {
    for (const m of [
      "tabs_list",
      "tabs_load",
      "tab_read",
      "tab_clip",
      "tabs_close",
      "undo_close",
    ]) {
      expect(isBridgeMethod(m)).toBe(true);
    }
  });

  test("rejects tools the trust boundary excludes", () => {
    for (const m of ["navigate", "click", "type", "evaluate", ""]) {
      expect(isBridgeMethod(m)).toBe(false);
    }
  });

  test("rejects non-strings", () => {
    expect(isBridgeMethod(null)).toBe(false);
    expect(isBridgeMethod(42)).toBe(false);
  });
});

describe("parseMessage()", () => {
  test("returns a typed message for a known envelope", () => {
    expect(parseMessage('{"type":"ping","t":1}')).toEqual({ type: "ping", t: 1 });
  });

  test("returns null on malformed JSON", () => {
    expect(parseMessage("{not json")).toBeNull();
  });

  test("returns null for an unknown type", () => {
    expect(parseMessage('{"type":"navigate","url":"http://x"}')).toBeNull();
  });

  test("returns null for non-objects and arrays", () => {
    expect(parseMessage('"hello"')).toBeNull();
    expect(parseMessage("[1,2]")).toBeNull();
    expect(parseMessage("null")).toBeNull();
  });
});

describe("parseTabsListParams()", () => {
  test("defaults to every window, hidden included, newest first, capped", () => {
    expect(parseTabsListParams(undefined)).toEqual({
      scope: "all",
      includeHidden: true,
      sort: "recent",
      limit: TABS_LIST_DEFAULT_LIMIT,
    });
  });

  // A domain histogram has a long tail of one-tab domains, so it gets a tighter
  // default than a tab listing. An explicit limit still governs both.
  test("defaults groupBy to its own smaller limit", () => {
    expect(parseTabsListParams({ groupBy: "domain" }).limit).toBe(TABS_LIST_DEFAULT_GROUP_LIMIT);
    expect(parseTabsListParams({ groupBy: "domain", limit: 5 }).limit).toBe(5);
  });

  test("accepts the documented values", () => {
    expect(
      parseTabsListParams({
        scope: "current-window",
        includeHidden: false,
        query: "github",
        limit: 5,
        sort: "oldest",
        groupBy: "domain",
      }),
    ).toEqual({
      scope: "current-window",
      includeHidden: false,
      query: "github",
      limit: 5,
      sort: "oldest",
      groupBy: "domain",
    });
  });

  test("rejects an unknown scope", () => {
    expect(() => parseTabsListParams({ scope: "everything" })).toThrow(BridgeRequestError);
  });

  test("rejects a non-boolean includeHidden", () => {
    expect(() => parseTabsListParams({ includeHidden: "yes" })).toThrow(BridgeRequestError);
  });

  test("rejects an unknown sort or groupBy", () => {
    expect(() => parseTabsListParams({ sort: "alphabetical" })).toThrow(BridgeRequestError);
    expect(() => parseTabsListParams({ groupBy: "window" })).toThrow(BridgeRequestError);
  });

  test("rejects a limit that is not a positive integer within the ceiling", () => {
    expect(() => parseTabsListParams({ limit: 0 })).toThrow(BridgeRequestError);
    expect(() => parseTabsListParams({ limit: 1.5 })).toThrow(BridgeRequestError);
    expect(() => parseTabsListParams({ limit: TABS_LIST_MAX_LIMIT + 1 })).toThrow(
      BridgeRequestError,
    );
  });

  // A query of only whitespace would otherwise reach `selectTabs` as a filter
  // that matches everything, and be reported back as if it had narrowed.
  test("drops a blank query rather than carrying it", () => {
    expect(parseTabsListParams({ query: "   " })).not.toHaveProperty("query");
    expect(parseTabsListParams({ query: "  github  " }).query).toBe("github");
  });
});

describe("tabDomain()", () => {
  test("strips www but keeps the subdomain that distinguishes a service", () => {
    expect(tabDomain("https://www.github.com/a/b")).toBe("github.com");
    expect(tabDomain("https://mail.google.com/")).toBe("mail.google.com");
    expect(tabDomain("https://docs.google.com/")).toBe("docs.google.com");
  });

  test("falls back to the scheme when there is no host, and to empty when unparseable", () => {
    expect(tabDomain("about:blank")).toBe("about");
    expect(tabDomain("file:///Users/x/n.md")).toBe("file");
    expect(tabDomain("not a url")).toBe("");
  });
});

describe("matchesTabQuery()", () => {
  const tab = makeTab({ id: 1, title: "Pull request #42", url: "https://github.com/o/r/pull/42" });

  test("matches case-insensitively across title and url", () => {
    expect(matchesTabQuery(tab, "PULL REQUEST")).toBe(true);
    expect(matchesTabQuery(tab, "github.com")).toBe(true);
  });

  test("requires every term, but lets them land in different fields", () => {
    expect(matchesTabQuery(tab, "github pull")).toBe(true);
    expect(matchesTabQuery(tab, "github issue")).toBe(false);
  });
});

describe("selectTabs()", () => {
  const tabs = [
    makeTab({ id: 1, title: "old", url: "https://x.com/a", lastAccessed: 100 }),
    makeTab({ id: 2, title: "new", url: "https://x.com/b", lastAccessed: 300 }),
    makeTab({ id: 3, title: "mid", url: "https://news.example/c", lastAccessed: 200 }),
    makeTab({ id: 4, title: "unknown", url: "https://x.com/d" }),
  ];

  test("defaults to most recent first", () => {
    expect(selectTabs(tabs, {}).tabs.map((t) => t.id)).toEqual([2, 3, 1, 4]);
  });

  test("sorts oldest first without floating unknowns to the top", () => {
    // A tab with no lastAccessed is unknown, not ancient — putting it first
    // would hand an agent hunting stale tabs a page it knows nothing about.
    expect(selectTabs(tabs, { sort: "oldest" }).tabs.map((t) => t.id)).toEqual([1, 3, 2, 4]);
  });

  test("filters on query and reports what the filter hit", () => {
    const result = selectTabs(tabs, { query: "x.com" });
    expect(result.tabs.map((t) => t.id)).toEqual([2, 1, 4]);
    expect(result.matched).toBe(3);
    expect(result.truncated).toBeUndefined();
  });

  test("flags truncation so a partial answer is never read as a complete one", () => {
    const result = selectTabs(tabs, { limit: 2 });
    expect(result.tabs.map((t) => t.id)).toEqual([2, 3]);
    expect(result.matched).toBe(4);
    expect(result.truncated).toBe(true);
  });

  test("counts matches before the limit, not after", () => {
    expect(selectTabs(tabs, { query: "x.com", limit: 1 }).matched).toBe(3);
  });

  test("drops hidden tabs only when asked", () => {
    const withHidden = [...tabs, makeTab({ id: 5, url: "https://h/", hidden: true })];
    expect(selectTabs(withHidden, { includeHidden: false }).tabs.map((t) => t.id)).not.toContain(5);
    expect(selectTabs(withHidden, {}).tabs.map((t) => t.id)).toContain(5);
  });
});

describe("groupTabsByDomain()", () => {
  const tabs = [
    makeTab({ id: 1, url: "https://x.com/a", lastAccessed: 100, discarded: true }),
    makeTab({ id: 2, url: "https://www.x.com/b", lastAccessed: 300 }),
    makeTab({ id: 3, url: "https://x.com/c", discarded: true }),
    makeTab({ id: 4, url: "https://news.example/d", lastAccessed: 200 }),
  ];

  test("counts per domain, busiest first", () => {
    const result = groupTabsByDomain(tabs, 10);
    expect(result.groups).toEqual([
      { domain: "x.com", tabs: 3, discarded: 2, newest: 300 },
      { domain: "news.example", tabs: 1, discarded: 0, newest: 200 },
    ]);
    expect(result).toMatchObject({ domains: 2, matched: 4 });
    expect(result.truncated).toBeUndefined();
  });

  test("omits newest when no tab in the group reported one", () => {
    const [group] = groupTabsByDomain([makeTab({ id: 1, url: "https://q/" })], 10).groups;
    expect(group).not.toHaveProperty("newest");
  });

  test("truncates groups but still counts every tab behind them", () => {
    const result = groupTabsByDomain(tabs, 1);
    expect(result.groups.map((g) => g.domain)).toEqual(["x.com"]);
    expect(result).toMatchObject({ domains: 2, matched: 4, truncated: true });
  });

  // Regression, caught live against an 874-tab browser: grouping ran on the
  // unfiltered set, so `{ query, groupBy }` counted the whole backlog. The
  // filter has to be applied by the caller, which is what `filterTabs` is for.
  test("counts only what the filter kept, when the caller filters first", () => {
    const result = groupTabsByDomain(filterTabs(tabs, { query: "x.com" }), 10);
    expect(result).toMatchObject({ domains: 1, matched: 3 });
    expect(result.groups.map((g) => g.domain)).toEqual(["x.com"]);
  });
});

describe("filterTabs()", () => {
  const tabs = [
    makeTab({ id: 1, url: "https://x.com/a", title: "keep" }),
    makeTab({ id: 2, url: "https://y.com/b", title: "drop" }),
    makeTab({ id: 3, url: "https://z.com/c", title: "keep", hidden: true }),
  ];

  test("applies query and includeHidden without sorting or truncating", () => {
    expect(filterTabs(tabs, { query: "keep" }).map((t) => t.id)).toEqual([1, 3]);
    expect(filterTabs(tabs, { query: "keep", includeHidden: false }).map((t) => t.id)).toEqual([1]);
    expect(filterTabs(tabs, {}).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  test("returns a new array, so the caller can sort in place", () => {
    const out = filterTabs(tabs, {});
    expect(out).not.toBe(tabs as unknown as typeof out);
  });
});

describe("parseTabReadParams()", () => {
  test("accepts an integer tabId", () => {
    expect(parseTabReadParams({ tabId: 7 })).toEqual({ tabId: 7 });
  });

  test("rejects a missing, fractional, or string tabId", () => {
    expect(() => parseTabReadParams({})).toThrow(BridgeRequestError);
    expect(() => parseTabReadParams({ tabId: 1.5 })).toThrow(BridgeRequestError);
    expect(() => parseTabReadParams({ tabId: "7" })).toThrow(BridgeRequestError);
  });

  test("reports bad-request so the agent can correct itself", () => {
    try {
      parseTabReadParams({});
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as BridgeRequestError).code).toBe("bad-request");
    }
  });
});

describe("parseTabClipParams()", () => {
  test("defaults close to false — closing stays an explicit act", () => {
    expect(parseTabClipParams({ tabId: 3 })).toEqual({ tabId: 3, close: false });
  });

  test("honours close: true", () => {
    expect(parseTabClipParams({ tabId: 3, close: true })).toEqual({ tabId: 3, close: true });
  });

  test("rejects a non-boolean close", () => {
    expect(() => parseTabClipParams({ tabId: 3, close: 1 })).toThrow(BridgeRequestError);
  });

  test("omits vault entirely when not overridden", () => {
    expect(parseTabClipParams({ tabId: 3 })).not.toHaveProperty("vault");
  });

  test("accepts a vault override and trims it", () => {
    expect(parseTabClipParams({ tabId: 3, vault: "  Hyphae  " })).toEqual({
      tabId: 3,
      close: false,
      vault: "Hyphae",
    });
  });

  // A blank override must not fall through to the configured vault: the agent
  // would be told it filed somewhere it did not. It must not reach Obsidian
  // either, where an absent `vault=` means "whichever vault is open".
  test("rejects an empty or whitespace vault rather than falling back", () => {
    expect(() => parseTabClipParams({ tabId: 3, vault: "" })).toThrow(BridgeRequestError);
    expect(() => parseTabClipParams({ tabId: 3, vault: "   " })).toThrow(BridgeRequestError);
  });

  test("rejects a path where a vault name belongs", () => {
    expect(() => parseTabClipParams({ tabId: 3, vault: "~/Notes" })).toThrow(BridgeRequestError);
    expect(() => parseTabClipParams({ tabId: 3, vault: "/Users/m/Notes" })).toThrow(
      BridgeRequestError,
    );
    expect(() => parseTabClipParams({ tabId: 3, vault: "Notes/Sub" })).toThrow(BridgeRequestError);
  });

  test("rejects a non-string vault", () => {
    expect(() => parseTabClipParams({ tabId: 3, vault: 7 })).toThrow(BridgeRequestError);
  });
});

describe("parseTabsCloseParams()", () => {
  test("accepts an array of integers", () => {
    expect(parseTabsCloseParams({ tabIds: [1, 2] })).toEqual({ tabIds: [1, 2] });
  });

  test("rejects an empty array rather than closing nothing silently", () => {
    expect(() => parseTabsCloseParams({ tabIds: [] })).toThrow(BridgeRequestError);
  });

  test("deduplicates repeated ids — one tab, one close, one undo entry", () => {
    expect(parseTabsCloseParams({ tabIds: [1, 2, 1, 2, 1] })).toEqual({ tabIds: [1, 2] });
  });

  test("rejects non-array and non-integer members", () => {
    expect(() => parseTabsCloseParams({ tabIds: 5 })).toThrow(BridgeRequestError);
    expect(() => parseTabsCloseParams({ tabIds: [1, "2"] })).toThrow(BridgeRequestError);
  });
});

describe("parseTabsLoadParams()", () => {
  test("accepts an array of integers", () => {
    expect(parseTabsLoadParams({ tabIds: [1, 2] })).toEqual({ tabIds: [1, 2] });
  });

  test("deduplicates rather than loading the same tab twice", () => {
    expect(parseTabsLoadParams({ tabIds: [4, 4, 5] })).toEqual({ tabIds: [4, 5] });
  });

  test("rejects an empty array and non-integer members", () => {
    expect(() => parseTabsLoadParams({ tabIds: [] })).toThrow(BridgeRequestError);
    expect(() => parseTabsLoadParams({ tabIds: [1, 1.5] })).toThrow(BridgeRequestError);
  });

  test("caps the batch so one call cannot outrun its own deadline", () => {
    const ids = Array.from({ length: TABS_LOAD_MAX_BATCH + 1 }, (_, i) => i + 1);
    expect(() => parseTabsLoadParams({ tabIds: ids })).toThrow(BridgeRequestError);
    expect(parseTabsLoadParams({ tabIds: ids.slice(0, -1) }).tabIds).toHaveLength(
      TABS_LOAD_MAX_BATCH,
    );
  });

  test("the cap applies after dedup — a repetitive batch is not oversized", () => {
    const ids = Array.from({ length: TABS_LOAD_MAX_BATCH * 2 }, (_, i) => (i % 3) + 1);
    expect(parseTabsLoadParams({ tabIds: ids })).toEqual({ tabIds: [1, 2, 3] });
  });
});

describe("parseUndoCloseParams()", () => {
  test("an absent batchId means the most recent batch", () => {
    expect(parseUndoCloseParams({})).toEqual({});
    expect(parseUndoCloseParams(undefined)).toEqual({});
  });

  test("accepts a string batchId", () => {
    expect(parseUndoCloseParams({ batchId: "b1" })).toEqual({ batchId: "b1" });
  });

  test("rejects a non-string batchId", () => {
    expect(() => parseUndoCloseParams({ batchId: 1 })).toThrow(BridgeRequestError);
  });
});

describe("BridgeRequestError", () => {
  test("converts to the wire error shape", () => {
    const err = new BridgeRequestError("tab-discarded", "unloaded");
    expect(err.toBridgeError()).toEqual({ code: "tab-discarded", message: "unloaded" });
  });
});
