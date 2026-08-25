import { describe, test, expect } from "bun:test";
import { planGrouping, plannedTabCount, type GroupableTab } from "../src/grouping.js";
import type { SiteRule } from "../src/site-rules.js";

function rule(partial: Partial<SiteRule> & Pick<SiteRule, "id" | "hostMatches">): SiteRule {
  return { subfolder: "", disposition: "devour", ...partial };
}

function tab(id: number, url: string, extra: Partial<GroupableTab> = {}): GroupableTab {
  return { id, url, pinned: false, windowId: 1, ...extra };
}

const GITHUB = rule({
  id: "gh",
  hostMatches: ["github.com"],
  group: { name: "GitHub", color: "blue" },
});
const SOCIAL = rule({
  id: "x",
  hostMatches: ["x.com", "twitter.com"],
  group: { name: "Social", color: "pink" },
});
const FOLDER_ONLY = rule({ id: "docs", hostMatches: ["developer.mozilla.org"], subfolder: "MDN" });

describe("planGrouping", () => {
  test("groups matches per rule group and leaves unmatched tabs alone", () => {
    const plan = planGrouping(
      [
        tab(1, "https://github.com/a/b"),
        tab(2, "https://github.com/c/d"),
        tab(3, "https://x.com/user"),
        tab(4, "https://example.com/"),
      ],
      [GITHUB, SOCIAL],
      [],
    );
    expect(plan.groups).toEqual([
      { name: "GitHub", color: "blue", windowId: 1, tabIds: [1, 2] },
      { name: "Social", color: "pink", windowId: 1, tabIds: [3] },
    ]);
    expect(plan.unmatched).toBe(1);
    expect(plannedTabCount(plan)).toBe(3);
  });

  test("a rule without a group claims its matches but plans nothing for them", () => {
    // First match wins overall: the folder-only rule claiming the tab means no
    // later rule may group it — one precedence order across every surface.
    const catchAll = rule({
      id: "all-mdn",
      hostMatches: ["developer.mozilla.org"],
      group: { name: "Docs", color: "green" },
    });
    const plan = planGrouping(
      [tab(1, "https://developer.mozilla.org/en-US/")],
      [FOLDER_ONLY, catchAll],
      [],
    );
    expect(plan.groups).toEqual([]);
    expect(plan.unmatched).toBe(1);
  });

  test("splits one rule's matches per window — grouping never moves a tab between windows", () => {
    const plan = planGrouping(
      [
        tab(1, "https://github.com/a/b", { windowId: 1 }),
        tab(2, "https://github.com/c/d", { windowId: 2 }),
      ],
      [GITHUB],
      [],
    );
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups.map((g) => g.windowId).sort()).toEqual([1, 2]);
  });

  test("two rules writing one group name become one planned group, first colour wins", () => {
    const alsoGitHub = rule({
      id: "gists",
      hostMatches: ["gist.github.com"],
      group: { name: "GitHub", color: "red" },
    });
    const plan = planGrouping(
      [tab(1, "https://github.com/a/b"), tab(2, "https://gist.github.com/x")],
      [GITHUB, alsoGitHub],
      [],
    );
    expect(plan.groups).toEqual([{ name: "GitHub", color: "blue", windowId: 1, tabIds: [1, 2] }]);
  });

  test("pinned matches are excluded and counted — grouping silently unpins (#33)", () => {
    const plan = planGrouping(
      [tab(1, "https://github.com/a/b", { pinned: true }), tab(2, "https://github.com/c/d")],
      [GITHUB],
      [],
    );
    expect(plan.groups).toEqual([{ name: "GitHub", color: "blue", windowId: 1, tabIds: [2] }]);
    expect(plan.pinnedExcluded).toBe(1);
  });

  test("the skip list parks matches whatever the rules say", () => {
    const plan = planGrouping(
      [tab(1, "https://github.com/a/b"), tab(2, "https://x.com/user")],
      [GITHUB, SOCIAL],
      ["x.com"],
    );
    expect(plan.groups).toEqual([{ name: "GitHub", color: "blue", windowId: 1, tabIds: [1] }]);
    expect(plan.skippedBySkipList).toBe(1);
  });

  test("non-http and url-less tabs are unmatched, never grouped", () => {
    const plan = planGrouping(
      [tab(1, "about:blank"), { id: 2, pinned: false, windowId: 1 }],
      [GITHUB],
      [],
    );
    expect(plan.groups).toEqual([]);
    expect(plan.unmatched).toBe(2);
  });
});
