import { describe, test, expect } from "bun:test";
import { groupDuplicates, pickKeeper, type Tab } from "../src/dedup.js";

function makeTab(partial: Partial<Tab>): Tab {
  return partial as Tab;
}

describe("groupDuplicates", () => {
  test("returns [] for empty input", () => {
    expect(groupDuplicates([], {})).toEqual([]);
  });

  test("returns [] when no duplicates exist", () => {
    const tabs = [
      makeTab({ id: 1, url: "https://example.com/a" }),
      makeTab({ id: 2, url: "https://example.com/b" }),
    ];
    expect(groupDuplicates(tabs, {})).toEqual([]);
  });

  test("returns [] for a single tab", () => {
    const tabs = [makeTab({ id: 1, url: "https://example.com/a" })];
    expect(groupDuplicates(tabs, {})).toEqual([]);
  });

  test("skips tabs whose URL normalizes to null", () => {
    const tabs = [
      makeTab({ id: 1, url: undefined }),
      makeTab({ id: 2, url: "not a url" }),
      makeTab({ id: 3, url: "https://example.com/a" }),
    ];
    expect(groupDuplicates(tabs, {})).toEqual([]);
  });

  test("never groups non-web URLs, such as Zen's synced-window stand-ins", () => {
    const tabs = [
      makeTab({ id: 1, url: "about:blank", discarded: true }),
      makeTab({ id: 2, url: "about:blank", discarded: true }),
      makeTab({ id: 3, url: "about:newtab" }),
      makeTab({ id: 4, url: "about:newtab" }),
      makeTab({ id: 5, url: "file:///tmp/a.pdf" }),
      makeTab({ id: 6, url: "file:///tmp/a.pdf" }),
    ];
    expect(groupDuplicates(tabs, {})).toEqual([]);
  });

  test("groups two tabs with the same canonical URL", () => {
    const t1 = makeTab({ id: 1, url: "https://example.com/a" });
    const t2 = makeTab({ id: 2, url: "https://www.example.com/a/" });
    const groups = groupDuplicates([t1, t2], {});
    expect(groups.length).toBe(1);
    expect(groups[0]!.key).toBe("example.com/a");
    expect(groups[0]!.tabs.map((t) => t.id)).toEqual([1, 2]);
  });

  test("groups tabs even when differing tracking params are present", () => {
    const t1 = makeTab({ id: 1, url: "https://example.com/p?utm_source=hn" });
    const t2 = makeTab({ id: 2, url: "https://example.com/p?fbclid=xyz" });
    const groups = groupDuplicates([t1, t2], {});
    expect(groups.length).toBe(1);
    expect(groups[0]!.tabs.length).toBe(2);
  });

  test("groups across reordered query parameters", () => {
    const t1 = makeTab({ id: 1, url: "https://example.com/p?a=1&b=2" });
    const t2 = makeTab({ id: 2, url: "https://example.com/p?b=2&a=1" });
    const groups = groupDuplicates([t1, t2], {});
    expect(groups.length).toBe(1);
  });

  test("respects stripFragment: false to split otherwise-equal URLs", () => {
    const t1 = makeTab({ id: 1, url: "https://example.com/p#one" });
    const t2 = makeTab({ id: 2, url: "https://example.com/p#two" });
    expect(groupDuplicates([t1, t2], {})).toHaveLength(1);
    expect(groupDuplicates([t1, t2], { stripFragment: false })).toEqual([]);
  });

  test("returns multiple disjoint groups", () => {
    const tabs = [
      makeTab({ id: 1, url: "https://example.com/a" }),
      makeTab({ id: 2, url: "https://example.com/a" }),
      makeTab({ id: 3, url: "https://example.com/b" }),
      makeTab({ id: 4, url: "https://example.com/b" }),
      makeTab({ id: 5, url: "https://example.com/c" }),
    ];
    const groups = groupDuplicates(tabs, {});
    expect(groups.length).toBe(2);
    const keys = groups.map((g) => g.key).sort();
    expect(keys).toEqual(["example.com/a", "example.com/b"]);
  });

  test("does not include groups of size 1 alongside duplicates", () => {
    const tabs = [
      makeTab({ id: 1, url: "https://example.com/a" }),
      makeTab({ id: 2, url: "https://example.com/a" }),
      makeTab({ id: 3, url: "https://example.com/unique" }),
    ];
    const groups = groupDuplicates(tabs, {});
    expect(groups.length).toBe(1);
    expect(groups[0]!.tabs.map((t) => t.id)).toEqual([1, 2]);
  });
});

/**
 * One measured tab: `name` is the `?zcopy=` page a copy reports (`blank` for
 * `about:blank`, `ext` for the options page), and `title` is its tab title.
 */
function zen(
  id: number,
  windowId: number,
  index: number,
  name: string,
  title: string,
  lastAccessed: number,
  discarded: boolean,
  { pinned = false, groupId = -1, active = false } = {},
): Tab {
  const url =
    name === "blank"
      ? "about:blank"
      : name === "ext"
        ? "moz-extension://uuid/options/options.html"
        : `https://example.com/?zcopy=${name}`;
  return {
    id,
    windowId,
    index,
    url,
    title,
    lastAccessed,
    discarded,
    pinned,
    groupId,
    active,
  } as Tab;
}

const G = { groupId: 1792573549272089 };

/**
 * Zen 1.23.3b, two synced windows, as `browser.tabs.query({ hidden: false })`
 * listed them (#117, 2026-10-21 run 3, fields as measured; the local test
 * server's origin is spelled example.com here). Window 17 holds most pages;
 * window 65 holds P2N, P6, P7 and D3. Copies of a page share an index and
 * nothing else reliably: ESS, PIN, P5 and D2 were navigated in window 17 and
 * their window-65 copies still report the old address (ids 14, 15, 17, 16), and
 * P2 moved to window 65 and then navigated, leaving id 4 on P2 with P2N's title.
 * Id 30 is P2 opened again. The only real duplicate is D (id 11) and D3 (id 28).
 */
const ZEN_SYNCED: Tab[] = [
  zen(10, 17, 0, "ESSN", "Page ESSN", 1792573544920, false, { pinned: true }),
  zen(9, 17, 1, "PINN", "Page PINN", 1792573544910, false, { pinned: true }),
  zen(30, 17, 3, "P2", "Page P2", 1792573597462, false),
  zen(29, 17, 4, "blank", "about:blank", 1792573580848, true),
  zen(27, 17, 5, "blank", "about:blank", 1792573580832, true),
  zen(12, 17, 6, "D2N", "Page D2N", 1792573544958, false),
  zen(4, 17, 7, "P2", "Page P2N", 1792573544832, false),
  zen(2, 17, 8, "ext", "Tabglutton — Settings", 1792573601483, false, { active: true }),
  zen(1, 17, 9, "blank", "New Tab", 1792573535396, false),
  zen(5, 17, 10, "P3", "Page P3", 1792573544838, false),
  zen(11, 17, 11, "D", "Page D", 1792573544932, false),
  zen(7, 17, 12, "P5N", "Page P5N", 1792573544890, false, G),
  zen(8, 17, 13, "blank", "Page P6", 1792573544899, false, G),
  zen(3, 17, 14, "P1", "Page P1", 1792573544819, true, G),
  zen(6, 17, 15, "P4", "Page P4", 1792573544850, true, G),
  zen(14, 65, 0, "ESS", "Page ESS", 1792573544920, true, { pinned: true }),
  zen(15, 65, 1, "PIN", "Page PIN", 1792573544910, true, { pinned: true }),
  zen(31, 65, 3, "blank", "about:blank", 1792573597467, true),
  zen(28, 65, 4, "D", "Page D", 1792573580843, false),
  zen(26, 65, 5, "P7", "Page P7", 1792573580827, false),
  zen(16, 65, 6, "D", "Page D", 1792573544958, true),
  zen(20, 65, 7, "P2N", "Page P2N", 1792573575800, false),
  zen(21, 65, 8, "ext", "Tabglutton — Settings", 1792573551532, true),
  zen(22, 65, 9, "blank", "about:blank", 1792573535396, true),
  zen(24, 65, 10, "blank", "Page P3", 1792573544838, true),
  zen(23, 65, 11, "blank", "Page D", 1792573544932, true),
  zen(17, 65, 12, "P5", "Page P5", 1792573544890, true, G),
  zen(18, 65, 13, "P6", "Page P6", 1792573601483, false, { ...G, active: true }),
  zen(25, 65, 14, "blank", "Page P1", 1792573544819, true, G),
  zen(19, 65, 15, "P4", "Page P4", 1792573544850, false, G),
];

/** What Dedup would close: every tab of a set but its keeper. */
function closes<T extends Tab>(groups: { tabs: T[] }[]): number[] {
  return groups
    .flatMap((g) => g.tabs.filter((t) => t.id !== pickKeeper(g.tabs).id).map((t) => t.id!))
    .sort((a, b) => a - b);
}

describe("groupDuplicates with Zen's synced windows", () => {
  test("without the synced listing, the measured copies make duplicates of pages that have none", () => {
    // The pre-fix behaviour, kept for Firefox. Beside D's extra (11) it closes
    // P2N, D2N and P4 through their copies (4, 16, 19): the three pages lost in
    // the measured press.
    expect(closes(groupDuplicates(ZEN_SYNCED, {}))).toEqual([4, 11, 16, 19]);
  });

  test("closes only the real duplicate, one tab for the page", () => {
    const groups = groupDuplicates(ZEN_SYNCED, {}, ZEN_SYNCED);
    expect(groups.map((g) => g.key)).toEqual(["example.com/?zcopy=D"]);
    expect(groups[0]!.tabs.map((t) => t.id)).toEqual([11, 28]);
    expect(closes(groups)).toEqual([11]);
  });

  test("a current-window scope still sees the stale copies through the other window", () => {
    const window17 = ZEN_SYNCED.filter((t) => t.windowId === 17);
    // Window 17 alone holds P2 (id 30) and P2N's copy still saying P2 (id 4).
    expect(closes(groupDuplicates(window17, {}))).toEqual([4]);
    expect(groupDuplicates(window17, {}, ZEN_SYNCED)).toEqual([]);
  });

  test("after a session restore every copy reports its page, and only RD's extra page closes", () => {
    // Measured: both windows restored with every copy discarded on its real
    // address and equal lastAccessed. RD is open twice in each window.
    const page = (index: number, name: string, lastAccessed: number, pinned = false) => [
      zen(100 + index, 3, index, name, `Page ${name}`, lastAccessed, true, { pinned }),
      zen(200 + index, 9, index, name, `Page ${name}`, lastAccessed, true, { pinned }),
    ];
    const restored = [
      ...page(0, "RP", 1792574234762, true),
      ...page(4, "RD", 1792574216581),
      ...page(5, "RD", 1792574216571),
      ...page(6, "R4", 1792574216524),
      ...page(7, "R3", 1792574230058),
      ...page(8, "R2", 1792574216509),
      ...page(9, "R1", 1792574216499),
    ];
    // Pre-fix: one copy of every page, and a copy of RD's keeper with its extra.
    expect(closes(groupDuplicates(restored, {}))).toEqual([105, 200, 204, 205, 206, 207, 208, 209]);
    expect(closes(groupDuplicates(restored, {}, restored))).toEqual([105]);
  });

  test("of a real duplicate's four synced tabs, any single one is a correct close", () => {
    // Measured (3 runs each): closing any one leaves one D page; closing a copy
    // of each page (293 and 296) leaves none. Pre-fix Dedup closes three
    // tabs, 295 among them, a copy of its own keeper; now it names one.
    const four = [
      zen(293, 17, 1, "D", "Page D", 1792575541454, true),
      zen(292, 17, 2, "D", "Page D", 1792575541449, true),
      zen(295, 891, 1, "D", "Page D", 1792575541454, true),
      zen(296, 891, 2, "D", "Page D", 1792575541449, true),
    ];
    expect(closes(groupDuplicates(four, {}))).toEqual([292, 295, 296]);
    expect(closes(groupDuplicates(four, {}, four))).toEqual([292]);
  });

  test("an unsynced window paired by position only hides duplicates", () => {
    // Zen opens a link sent to a new window unsynced, so its tabs are not
    // copies; pairing them by index is the mistake the rule allows.
    const tabs = [
      makeTab({ id: 1, windowId: 1, index: 0, url: "https://example.com/a" }),
      makeTab({ id: 2, windowId: 1, index: 1, url: "https://example.com/a" }),
      makeTab({ id: 3, windowId: 2, index: 0, url: "https://example.com/b" }),
      makeTab({ id: 4, windowId: 2, index: 5, url: "https://example.com/c" }),
      makeTab({ id: 5, windowId: 1, index: 5, url: "https://example.com/c" }),
    ];
    // Index 0 now holds a and b, so a's first tab is left out; index 5's two
    // c tabs read as one page. Nothing closes, and nothing closes wrongly.
    expect(groupDuplicates(tabs, {})).toHaveLength(2);
    expect(groupDuplicates(tabs, {}, tabs)).toEqual([]);
  });
});

describe("pickKeeper", () => {
  test("returns the only tab when given one", () => {
    const only = makeTab({ id: 1, url: "https://example.com/a" });
    expect(pickKeeper([only])).toBe(only);
  });

  test("picks the tab with the highest lastAccessed", () => {
    const a = makeTab({ id: 1, lastAccessed: 100 });
    const b = makeTab({ id: 2, lastAccessed: 500 });
    const c = makeTab({ id: 3, lastAccessed: 300 });
    expect(pickKeeper([a, b, c])).toBe(b);
  });

  test("treats missing lastAccessed as 0", () => {
    const a = makeTab({ id: 1 });
    const b = makeTab({ id: 2, lastAccessed: 1 });
    expect(pickKeeper([a, b])).toBe(b);
  });

  test("on tie, active beats inactive", () => {
    const a = makeTab({ id: 1, lastAccessed: 100, active: false });
    const b = makeTab({ id: 2, lastAccessed: 100, active: true });
    expect(pickKeeper([a, b])).toBe(b);
  });

  test("on tie with both inactive, pinned beats unpinned", () => {
    const a = makeTab({ id: 1, lastAccessed: 100, active: false, pinned: false });
    const b = makeTab({ id: 2, lastAccessed: 100, active: false, pinned: true });
    expect(pickKeeper([a, b])).toBe(b);
  });

  test("on tie with both active and both pinned, first wins (deterministic)", () => {
    const a = makeTab({ id: 1, lastAccessed: 100, active: true, pinned: true });
    const b = makeTab({ id: 2, lastAccessed: 100, active: true, pinned: true });
    expect(pickKeeper([a, b])).toBe(a);
  });

  test("higher lastAccessed wins even if losing tab is active+pinned", () => {
    const stale = makeTab({ id: 1, lastAccessed: 999_999, active: false, pinned: false });
    const fresh = makeTab({ id: 2, lastAccessed: 1, active: true, pinned: true });
    expect(pickKeeper([fresh, stale])).toBe(stale);
  });

  test("deterministic across input order for identical inputs", () => {
    const a = makeTab({ id: 1, lastAccessed: 100 });
    const b = makeTab({ id: 2, lastAccessed: 100 });
    const c = makeTab({ id: 3, lastAccessed: 100 });
    expect(pickKeeper([a, b, c])).toBe(a);
    expect(pickKeeper([c, b, a])).toBe(c);
  });
});
