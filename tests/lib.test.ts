import { describe, expect, test } from "bun:test";
import type { PopupTab } from "../src/background.js";
import { visibleGroups } from "../popup/lib.js";

function tab(id: number, host: string): PopupTab {
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
  };
}

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
    const groups = visibleGroups(tabs, "");
    expect(groups.map((g) => g.host)).toEqual(["reddit.com", "x.com", "youtube.com"]);
  });

  test("with sticky order, ranked hosts appear in given order regardless of count", () => {
    const tabs = [
      tab(1, "x.com"),
      tab(2, "x.com"),
      tab(3, "x.com"),
      tab(4, "reddit.com"),
      tab(5, "reddit.com"),
    ];
    const groups = visibleGroups(tabs, "", ["reddit.com", "x.com"]);
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
    const groups = visibleGroups(tabs, "", ["reddit.com"]);
    expect(groups.map((g) => g.host)).toEqual(["reddit.com", "x.com", "newsite.com"]);
  });

  test("sticky hosts with no remaining tabs are omitted", () => {
    const tabs = [tab(1, "x.com"), tab(2, "x.com")];
    const groups = visibleGroups(tabs, "", ["reddit.com", "x.com"]);
    expect(groups.map((g) => g.host)).toEqual(["x.com"]);
  });

  test("empty sticky order falls back to default sort", () => {
    const tabs = [tab(1, "a.com"), tab(2, "b.com"), tab(3, "b.com")];
    const groups = visibleGroups(tabs, "", []);
    expect(groups.map((g) => g.host)).toEqual(["b.com", "a.com"]);
  });
});
