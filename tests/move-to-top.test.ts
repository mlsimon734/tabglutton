import { describe, expect, test } from "bun:test";
import { landedAtTop, restoreSequence, topIndex, type OrderTab } from "../src/move-to-top.js";

// `tabs.move(id, { index })` as measured on Chrome 148 and Firefox 154: the tab
// is taken out and reinserted so that it ends up at `index`.
function move(order: string[], id: string, index: number): string[] {
  const rest = order.filter((x) => x !== id);
  rest.splice(Math.min(index, rest.length), 0, id);
  return rest;
}

function listing(order: string[], pinned: number): OrderTab[] {
  return order.map((name, index) => ({ id: name.charCodeAt(0), index, pinned: index < pinned }));
}

describe("topIndex", () => {
  test("the first unpinned tab the listing shows", () => {
    expect(topIndex(listing(["P", "Q", "a", "b"], 2))).toBe(2);
    expect(topIndex(listing(["a", "b"], 0))).toBe(0);
    expect(topIndex(listing(["P"], 1))).toBeNull();
    // Zen: another workspace's tabs hold indexes the listing does not show.
    expect(
      topIndex([
        { id: 1, index: 0, pinned: true },
        { id: 2, index: 5, pinned: false },
        { id: 3, index: 6, pinned: false },
      ]),
    ).toBe(5);
  });
});

describe("landedAtTop", () => {
  test("only the moved tabs that lead the unpinned tabs count", () => {
    const tabs = listing(["P", "d", "f", "a", "b"], 1);
    expect([...landedAtTop(tabs, ["d".charCodeAt(0), "f".charCodeAt(0)])].sort()).toEqual(
      ["d".charCodeAt(0), "f".charCodeAt(0)].sort(),
    );
    // An engine that ignored the move for `b` leaves it below `a`.
    expect([...landedAtTop(tabs, ["d".charCodeAt(0), "b".charCodeAt(0)])]).toEqual([
      "d".charCodeAt(0),
    ]);
  });
});

describe("restoreSequence", () => {
  test("highest original index first, per window", () => {
    expect(
      restoreSequence([
        { tabId: 1, windowId: 1, index: 3 },
        { tabId: 2, windowId: 2, index: 1 },
        { tabId: 3, windowId: 1, index: 7 },
      ]).map((p) => p.tabId),
    ).toEqual([3, 1, 2]);
  });

  test("moving to the top and back restores the order exactly, for every choice of tabs", () => {
    const start = ["P", "Q", "a", "b", "c", "d", "e", "f", "g"];
    const pinned = 2;
    const unpinned = start.slice(pinned);
    // Every non-empty subset, moved in a scrambled order, as the digest's order may be.
    for (let mask = 1; mask < 1 << unpinned.length; mask++) {
      const chosen = unpinned.filter((_, i) => mask & (1 << i));
      const moveOrder = [...chosen].reverse();
      const from = moveOrder.map((name) => ({
        tabId: name.charCodeAt(0),
        windowId: 1,
        index: start.indexOf(name),
      }));
      const top = topIndex(listing(start, pinned)) ?? 0;
      let order = [...start];
      moveOrder.forEach((name, i) => {
        order = move(order, name, top + i);
      });
      expect(order.slice(pinned, pinned + chosen.length)).toEqual(moveOrder);
      for (const p of restoreSequence(from)) {
        order = move(order, String.fromCharCode(p.tabId), p.index);
      }
      expect(order).toEqual(start);
    }
  });
});
