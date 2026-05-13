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
