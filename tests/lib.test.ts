import { describe, expect, test } from "bun:test";
import type { ClipSelectedTabsResponse, PopupTab } from "../src/background.js";
import {
  clipMarkLabel,
  clipMarkTitle,
  clipSummary,
  computeDedupCount,
  extraTabIds,
  RAIL_MIN_THUMB,
  railScrollTop,
  railThumb,
  visibleGroups,
  type RailMetrics,
} from "../popup/lib.js";
import type { ClipMemoryEntry } from "../src/clip-memory.js";
import { defaults, type Settings } from "../src/storage.js";

function tab(id: number, host: string, overrides: Partial<PopupTab> = {}): PopupTab {
  return {
    id,
    title: `tab-${id}`,
    url: `https://${host}/${id}`,
    favIconUrl: undefined,
    lastAccessed: 0,
    active: false,
    pinned: false,
    windowId: 1,
    index: id,
    ...overrides,
  };
}

/** A duplicate of `url`, so the grouping key is shared but the tab is not. */
function copy(id: number, url: string, overrides: Partial<PopupTab> = {}): PopupTab {
  return tab(id, "unused", { url, ...overrides });
}

const settings: Settings = defaults();

describe("visibleGroups", () => {
  test("without sticky order, sorts by count descending then host A-Z", () => {
    const tabs = [
      tab(1, "x.com"),
      tab(2, "x.com"),
      tab(3, "x.com"),
      tab(4, "reddit.com"),
      tab(5, "reddit.com"),
      tab(6, "reddit.com"),
      tab(7, "reddit.com"),
      tab(8, "youtube.com"),
    ];
    const groups = visibleGroups(tabs, "", settings);
    expect(groups.map((g) => g.host)).toEqual(["reddit.com", "x.com", "youtube.com"]);
  });

  test("with sticky order, ranked groups appear in given order regardless of count", () => {
    const tabs = [
      tab(1, "x.com"),
      tab(2, "x.com"),
      tab(3, "x.com"),
      tab(4, "reddit.com"),
      tab(5, "reddit.com"),
    ];
    const groups = visibleGroups(tabs, "", settings, ["host:reddit.com", "host:x.com"]);
    expect(groups.map((g) => g.host)).toEqual(["reddit.com", "x.com"]);
  });

  test("hosts not in sticky order are appended in count-desc tiebreaker", () => {
    const tabs = [
      tab(1, "reddit.com"),
      tab(2, "x.com"),
      tab(3, "x.com"),
      tab(4, "x.com"),
      tab(5, "newsite.com"),
      tab(6, "newsite.com"),
    ];
    const groups = visibleGroups(tabs, "", settings, ["host:reddit.com"]);
    expect(groups.map((g) => g.host)).toEqual(["reddit.com", "x.com", "newsite.com"]);
  });

  test("sticky hosts with no remaining tabs are omitted", () => {
    const tabs = [tab(1, "x.com"), tab(2, "x.com")];
    const groups = visibleGroups(tabs, "", settings, ["host:reddit.com", "host:x.com"]);
    expect(groups.map((g) => g.host)).toEqual(["x.com"]);
  });

  test("empty sticky order falls back to default sort", () => {
    const tabs = [tab(1, "a.com"), tab(2, "b.com"), tab(3, "b.com")];
    const groups = visibleGroups(tabs, "", settings, []);
    expect(groups.map((g) => g.host)).toEqual(["b.com", "a.com"]);
  });

  test("null settings means no duplicate detection at all", () => {
    const tabs = [copy(1, "https://a.com/x"), copy(2, "https://a.com/x")];
    const groups = visibleGroups(tabs, "", null);
    expect(groups.map((g) => g.kind)).toEqual(["domain"]);
    expect(groups[0]!.tabs.length).toBe(2);
  });
});

describe("visibleGroups duplicates", () => {
  test("duplicate sets lead the list, ahead of a larger domain group", () => {
    const tabs = [
      tab(1, "big.com"),
      tab(2, "big.com"),
      tab(3, "big.com"),
      copy(4, "https://dup.com/a"),
      copy(5, "https://dup.com/a"),
    ];
    const groups = visibleGroups(tabs, "", settings);
    expect(groups.map((g) => g.kind)).toEqual(["duplicate", "domain"]);
    expect(groups[0]!.label).toBe("dup.com/a");
    expect(groups[0]!.tabs.map((t) => t.id).sort()).toEqual([4, 5]);
  });

  test("a duplicated tab is not also rendered in its domain group", () => {
    const tabs = [
      copy(1, "https://a.com/one"),
      copy(2, "https://a.com/one"),
      copy(3, "https://a.com/two"),
    ];
    const groups = visibleGroups(tabs, "", settings);
    expect(groups.map((g) => g.kind)).toEqual(["duplicate", "domain"]);
    expect(groups[1]!.tabs.map((t) => t.id)).toEqual([3]);
    const rendered = groups.flatMap((g) => g.tabs.map((t) => t.id));
    expect(rendered.sort()).toEqual([1, 2, 3]);
  });

  test("the keeper is the most recently used copy and leads its set", () => {
    const tabs = [
      copy(1, "https://a.com/x", { lastAccessed: 10 }),
      copy(2, "https://a.com/x", { lastAccessed: 99 }),
      copy(3, "https://a.com/x", { lastAccessed: 50 }),
    ];
    const [set] = visibleGroups(tabs, "", settings);
    expect(set!.keeperId).toBe(2);
    expect(set!.tabs.map((t) => t.id)).toEqual([2, 1, 3]);
    expect(extraTabIds([set!])).toEqual([1, 3]);
  });

  test("canonicalisation decides duplicates, not the raw URL", () => {
    const tabs = [
      copy(1, "https://www.a.com/x/"),
      copy(2, "https://a.com/x?utm_source=newsletter"),
    ];
    const groups = visibleGroups(tabs, "", settings);
    expect(groups.map((g) => g.kind)).toEqual(["duplicate"]);
    expect(groups[0]!.label).toBe("a.com/x");
  });

  test("a filter hides the sets nothing in it matches", () => {
    const tabs = [
      copy(1, "https://a.com/keep", { title: "keep me" }),
      copy(2, "https://a.com/keep", { title: "keep me" }),
      copy(3, "https://b.com/other", { title: "other" }),
      copy(4, "https://b.com/other", { title: "other" }),
    ];
    const groups = visibleGroups(tabs, "keep", settings);
    expect(groups.map((g) => g.label)).toEqual(["a.com/keep"]);
  });

  test("a matched set is shown whole, so `keep` never names a copy Dedup closes", () => {
    // Same URL, different titles, and the newest — the real keeper — does not
    // match the filter. Dedup is not filtered, so the set must not be either.
    const tabs = [
      copy(1, "https://a.com/x", { title: "alpha", lastAccessed: 10 }),
      copy(2, "https://a.com/x", { title: "alpha", lastAccessed: 20 }),
      copy(3, "https://a.com/x", { title: "beta", lastAccessed: 99 }),
    ];
    const [set] = visibleGroups(tabs, "alpha", settings);
    expect(set!.kind).toBe("duplicate");
    expect(set!.tabs.map((t) => t.id)).toEqual([3, 1, 2]);
    expect(set!.keeperId).toBe(3);
    expect(extraTabIds([set!])).toEqual([1, 2]);
  });

  test("a single tab matching a filter is still just a tab", () => {
    const tabs = [copy(1, "https://a.com/x", { title: "alpha" }), tab(2, "b.com")];
    const groups = visibleGroups(tabs, "alpha", settings);
    expect(groups.map((g) => g.kind)).toEqual(["domain"]);
  });

  test("extraTabIds counts every copy but the keeper, across sets", () => {
    const tabs = [
      copy(1, "https://a.com/x"),
      copy(2, "https://a.com/x"),
      copy(3, "https://b.com/y"),
      copy(4, "https://b.com/y"),
      copy(5, "https://b.com/y"),
    ];
    const groups = visibleGroups(tabs, "", settings);
    expect(extraTabIds(groups).length).toBe(3);
    // The section and the Dedup button have to agree on the number.
    expect(extraTabIds(groups).length).toBe(computeDedupCount(tabs, settings));
  });
});

function summary(partial: Partial<ClipSelectedTabsResponse> = {}): ClipSelectedTabsResponse {
  return {
    failed: 0,
    obsidianSaved: 0,
    fileSaved: 0,
    zoteroSaved: 0,
    ruleClosed: 0,
    ruleClosedRestorable: [],
    failures: [],
    ...partial,
  };
}

function neverDevourFailure(tabId: number) {
  return {
    tabId,
    title: "t",
    url: "https://example.com",
    reason: "never-devour" as const,
  };
}

describe("clipSummary", () => {
  // Pins the wording the Obsidian and Zotero destinations had before the file
  // destination existed: adding a third destination must not restate the first.
  test("Obsidian alone stays a bare count", () => {
    expect(clipSummary(summary({ obsidianSaved: 3 }))).toBe("Saved 3");
    expect(clipSummary(summary({ obsidianSaved: 3, failed: 2 }))).toBe("Saved 3, 2 failed");
  });

  test("Zotero is named, alone or alongside Obsidian", () => {
    expect(clipSummary(summary({ zoteroSaved: 3 }))).toBe("Saved 3 to Zotero");
    expect(clipSummary(summary({ zoteroSaved: 3, obsidianSaved: 1 }))).toBe(
      "Saved 3 to Zotero, 1 to Obsidian",
    );
  });

  test("nothing saved still reads as a count", () => {
    expect(clipSummary(summary())).toBe("Saved 0");
  });

  test("the file destination is named", () => {
    expect(clipSummary(summary({ fileSaved: 4 }))).toBe("Saved 4 to files");
    expect(clipSummary(summary({ fileSaved: 4, zoteroSaved: 1 }))).toBe(
      "Saved 1 to Zotero, 4 to files",
    );
  });

  test("rule-driven outcomes are named apart from failures", () => {
    expect(clipSummary(summary({ obsidianSaved: 2, ruleClosed: 3 }))).toBe(
      "Saved 2, closed 3 by rule",
    );
    expect(
      clipSummary(summary({ obsidianSaved: 2, failed: 1, failures: [neverDevourFailure(1)] })),
    ).toBe("Saved 2, 1 kept by rule");
    expect(
      clipSummary(
        summary({
          obsidianSaved: 2,
          ruleClosed: 1,
          failed: 2,
          failures: [
            neverDevourFailure(1),
            { tabId: 2, title: "t", url: "u", reason: "extract-failed" as const },
          ],
        }),
      ),
    ).toBe("Saved 2, closed 1 by rule, 1 kept by rule, 1 failed");
  });
});

describe("the clip filter", () => {
  const clipped = (id: number, host: string): PopupTab =>
    tab(id, host, { clipped: { at: 1, destination: "obsidian" } });

  test("narrows to remembered pages, or to the ones with no record", () => {
    const tabs = [clipped(1, "a.com"), tab(2, "b.com")];
    expect(
      visibleGroups(tabs, "", settings, null, "all").flatMap((g) => g.tabs.map((t) => t.id)),
    ).toEqual([1, 2]);
    expect(
      visibleGroups(tabs, "", settings, null, "clipped").flatMap((g) => g.tabs.map((t) => t.id)),
    ).toEqual([1]);
    expect(
      visibleGroups(tabs, "", settings, null, "unclipped").flatMap((g) => g.tabs.map((t) => t.id)),
    ).toEqual([2]);
  });

  // Same rule the text filter follows: a duplicate set is found across the whole
  // scope and shown whole, so the `keep` pill never lands on a copy Dedup would
  // close. A set with one clipped copy would otherwise split in half.
  test("shows a duplicate set whole when one copy matches", () => {
    const tabs = [
      copy(1, "https://a.com/x", { clipped: { at: 1, destination: "file", verifiedAt: 1 } }),
      copy(2, "https://a.com/x"),
    ];
    const groups = visibleGroups(tabs, "", settings, null, "clipped");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("duplicate");
    expect(groups[0]?.tabs.map((t) => t.id).sort()).toEqual([1, 2]);
  });

  test("combines with the text filter rather than replacing it", () => {
    const tabs = [clipped(1, "a.com"), clipped(2, "b.com"), tab(3, "a.com")];
    const groups = visibleGroups(tabs, "a.com", settings, null, "clipped");
    expect(groups.flatMap((g) => g.tabs.map((t) => t.id))).toEqual([1]);
  });
});

describe("the clip mark", () => {
  const CLIPPED_AT = Date.parse("2026-03-12T10:00:00Z");
  const entry = (state: "launched" | "verified"): ClipMemoryEntry => ({
    at: CLIPPED_AT,
    destination: "obsidian",
    ...(state === "verified" ? { verifiedAt: CLIPPED_AT } : {}),
  });

  // The whole naming constraint in one assertion: the extension can say a page
  // was clipped and never that it is in the vault, because a refused
  // obsidian:// launch is indistinguishable from a taken one.
  test("says clipped, never vault", () => {
    for (const state of ["launched", "verified"] as const) {
      expect(clipMarkLabel(entry(state))).toStartWith("clipped");
      expect(clipMarkTitle(entry(state)).toLowerCase()).not.toInclude("vault");
    }
  });

  test("distinguishes the two states in the pill and in the hover text", () => {
    expect(clipMarkLabel(entry("launched"))).not.toBe(clipMarkLabel(entry("verified")));
    expect(clipMarkTitle(entry("launched"))).toInclude("nothing could confirm");
    expect(clipMarkTitle(entry("verified"))).toInclude("seen on disk");
  });

  // The failure this shape exists to prevent: a page verified as a file in
  // March, re-clipped to Obsidian today, must not report that an Obsidian note
  // was seen today. Nothing looked today, and nothing ever looked in Obsidian.
  test("never attributes an old sighting to a newer clip", () => {
    const title = clipMarkTitle({
      at: Date.parse("2026-08-20T10:00:00Z"),
      destination: "obsidian",
      verifiedAt: Date.parse("2026-03-12T10:00:00Z"),
    });
    expect(title).toInclude("Clipped to Obsidian on Aug 20, 2026");
    expect(title).toInclude("seen on disk on Mar 12, 2026");
    expect(title).not.toInclude("seen on disk then");
  });

  // Neither state is a claim about disk *now*: notes get moved and deleted.
  test("both states disclaim the present", () => {
    for (const state of ["launched", "verified"] as const) {
      expect(clipMarkTitle(entry(state))).toInclude("moved or deleted since");
    }
  });
});

describe("railThumb", () => {
  /** A 600px band over a list four screens tall. */
  function metrics(overrides: Partial<RailMetrics> = {}): RailMetrics {
    return { track: 600, clientHeight: 800, scrollHeight: 3200, scrollTop: 0, ...overrides };
  }

  test("thumb is proportional to how much of the list is on screen", () => {
    expect(railThumb(metrics())).toEqual({ height: 150, offset: 0 });
  });

  test("offset runs the thumb's own travel, not the track", () => {
    const range = 3200 - 800;
    expect(railThumb(metrics({ scrollTop: range }))?.offset).toBe(600 - 150);
    expect(railThumb(metrics({ scrollTop: range / 2 }))?.offset).toBe(Math.round((600 - 150) / 2));
  });

  // A thumb sized honestly on a 5000-tab list is a couple of pixels tall.
  test("a very long list still gets a grabbable thumb", () => {
    const thumb = railThumb(metrics({ scrollHeight: 400_000 }));
    expect(thumb?.height).toBe(RAIL_MIN_THUMB);
    expect(railThumb(metrics({ scrollHeight: 400_000, scrollTop: 399_200 }))?.offset).toBe(
      600 - RAIL_MIN_THUMB,
    );
  });

  // Nothing to scroll means no rail at all: a full-length thumb reads as stuck.
  test("nothing to scroll answers null", () => {
    expect(railThumb(metrics({ scrollHeight: 800 }))).toBeNull();
    expect(railThumb(metrics({ scrollHeight: 801 }))).toBeNull();
    expect(railThumb(metrics({ track: 0 }))).toBeNull();
  });

  // Gecko's elastic overscroll reports a scrollTop past the end mid-bounce.
  test("overscroll cannot push the thumb off either end", () => {
    expect(railThumb(metrics({ scrollTop: -120 }))?.offset).toBe(0);
    expect(railThumb(metrics({ scrollTop: 99_999 }))?.offset).toBe(600 - 150);
  });
});

describe("railScrollTop", () => {
  function metrics(overrides: Partial<RailMetrics> = {}): RailMetrics {
    return { track: 600, clientHeight: 800, scrollHeight: 3200, scrollTop: 0, ...overrides };
  }

  test("dragging the thumb the length of its travel reaches the end", () => {
    expect(railScrollTop(metrics(), 150, 600 - 150)).toBe(2400);
    expect(railScrollTop(metrics(), 150, 0)).toBe(0);
  });

  // The clamp to RAIL_MIN_THUMB makes the mapping non-proportional, so a drag
  // has to divide by the thumb's real travel or it undershoots the end.
  test("a clamped thumb still reaches the end of a long list", () => {
    const m = metrics({ scrollHeight: 400_000 });
    expect(railScrollTop(m, RAIL_MIN_THUMB, 600 - RAIL_MIN_THUMB)).toBe(399_200);
  });

  test("a drag past either end of the track clamps", () => {
    expect(railScrollTop(metrics(), 150, -500)).toBe(0);
    expect(railScrollTop(metrics(), 150, 9999)).toBe(2400);
  });

  test("an unscrollable list stays at the top", () => {
    expect(railScrollTop(metrics({ scrollHeight: 800 }), 600, 300)).toBe(0);
  });
});
