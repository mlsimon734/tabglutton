import { describe, expect, test } from "bun:test";
import {
  FOCUS_RANK,
  blockKey,
  layoutFrom,
  nextMove,
  orderTarget,
  planMoves,
  restoreTarget,
  sameLayout,
  stripIndexes,
  type OrderBlock,
  type OrderDirection,
  type OrderTab,
} from "../src/tab-order.js";

// --- a window, and the two engines' measured move rules -----------------------

interface SimTab {
  id: number;
  groupId: number;
  pinned: boolean;
  hidden: boolean;
  /** Holds an index without appearing in the listing (Zen's hidden empty tab). */
  unlisted?: boolean;
}

type EngineRule = "gecko" | "chromium";

/**
 * `tabs.move` and `tabGroups.move` as measured on Chrome 148, Firefox 154 and
 * Zen 1.23.3b: the first moved tab ends up at `index`. On Gecko a moved tab
 * takes the group of the tab that held `index` before the move (its right-hand
 * neighbour when it moves left, its left-hand one when it moves right, the
 * window's end included); on Chromium it joins only a group on both sides.
 */
class SimWindow {
  tabs: SimTab[];
  joins = 0;
  constructor(
    tabs: SimTab[],
    private readonly rule: EngineRule,
  ) {
    this.tabs = tabs.map((t) => ({ ...t }));
  }

  listing(): OrderTab[] {
    return this.tabs
      .map((t, index) => ({ t, index }))
      .filter(({ t }) => !t.unlisted)
      .map(({ t, index }) => ({
        id: t.id,
        index,
        pinned: t.pinned,
        hidden: t.hidden,
        groupId: t.groupId,
      }));
  }

  moveTab(id: number, index: number): void {
    const held = this.tabs[index];
    const at = this.tabs.findIndex((t) => t.id === id);
    const [tab] = this.tabs.splice(at, 1);
    if (!tab) throw new Error("no tab");
    this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
    const left = this.tabs[index - 1];
    const right = this.tabs[index + 1];
    const group =
      this.rule === "gecko"
        ? held && held !== tab
          ? held.groupId
          : -1
        : left && right && left.groupId === right.groupId
          ? left.groupId
          : -1;
    if (group !== tab.groupId) this.joins++;
    tab.groupId = group;
  }

  moveGroup(groupId: number, index: number): void {
    const members = this.tabs.filter((t) => t.groupId === groupId);
    this.tabs = this.tabs.filter((t) => t.groupId !== groupId);
    this.tabs.splice(Math.min(index, this.tabs.length), 0, ...members);
  }

  /** Run the background's loop: next move, make it, read back, compare. */
  arrange(target: string[]): { moves: number; complete: boolean } {
    const limit = planMoves(stripIndexes(layoutFrom(this.listing())), target)?.length ?? 0;
    for (let moves = 0; moves <= limit; moves++) {
      const next = nextMove(layoutFrom(this.listing()), target);
      if (!next) return { moves, complete: true };
      const { block, index } = next.move;
      if (block.groupId !== undefined) this.moveGroup(block.groupId, index);
      else this.moveTab(block.tabIds[0] as number, index);
      if (!sameLayout(stripIndexes(layoutFrom(this.listing())), next.expect)) {
        return { moves: moves + 1, complete: false };
      }
    }
    return { moves: limit + 1, complete: false };
  }

  layout(): OrderBlock[] {
    return stripIndexes(layoutFrom(this.listing()));
  }
}

/** A small window spec: `a`-`z` ungrouped, `[g:abc]` a group, `^` pinned, `~` hidden, `_` unlisted. */
function build(spec: string): { tabs: SimTab[]; id: (name: string) => number } {
  const tabs: SimTab[] = [];
  const ids = new Map<string, number>();
  let group = -1;
  let nextGroup = 100;
  let pinned = false;
  let hidden = false;
  for (const ch of spec) {
    if (ch === " ") continue;
    if (ch === "[") {
      group = nextGroup++;
      continue;
    }
    if (ch === "]") {
      group = -1;
      continue;
    }
    if (ch === "^") {
      pinned = true;
      continue;
    }
    if (ch === "~") {
      hidden = true;
      continue;
    }
    if (ch === "_") {
      tabs.push({
        id: 9000 + tabs.length,
        groupId: -1,
        pinned: false,
        hidden: false,
        unlisted: true,
      });
      continue;
    }
    const id = tabs.length + 1;
    ids.set(ch, id);
    tabs.push({ id, groupId: group, pinned, hidden });
    pinned = false;
    hidden = false;
  }
  return { tabs, id: (name) => ids.get(name) ?? -1 };
}

function names(sim: SimWindow, id: (name: string) => number, all: string): string {
  const byId = new Map([...all].map((c) => [id(c), c] as const));
  let out = "";
  let group = -1;
  for (const t of sim.tabs) {
    if (t.unlisted) continue;
    if (t.groupId !== group) {
      if (group !== -1) out += "]";
      if (t.groupId !== -1) out += "[";
      group = t.groupId;
    }
    out += byId.get(t.id) ?? "?";
  }
  return group !== -1 ? `${out}]` : out;
}

function ranks(id: (name: string) => number, fates: Record<string, keyof typeof FOCUS_RANK>) {
  const byId = new Map(Object.entries(fates).map(([n, f]) => [id(n), FOCUS_RANK[f]] as const));
  return (tabId: number) => byId.get(tabId) ?? FOCUS_RANK.neutral;
}

// A seeded generator, so a failing permutation can be replayed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// --- layout -------------------------------------------------------------------

describe("layoutFrom", () => {
  test("ungrouped tabs, whole groups, and fixed blocks for pinned, hidden and folders", () => {
    const { tabs, id } = build("^p [^q^r] _ a [bc] ~h d");
    const layout = layoutFrom(new SimWindow(tabs, "gecko").listing());
    expect(layout.map((b) => [b.tabIds, b.fixed === true])).toEqual([
      [[id("p")], true],
      [[id("q"), id("r")], true],
      [[id("a")], false],
      [[id("b"), id("c")], false],
      [[id("h")], true],
      [[id("d")], false],
    ]);
    // The unlisted tab's index is skipped, never counted.
    expect(layout[2]?.start).toBe(4);
  });

  test("a group the listing shows in two pieces is fixed", () => {
    const layout = layoutFrom([
      { id: 1, index: 0, pinned: false, hidden: false, groupId: 7 },
      { id: 2, index: 1, pinned: false, hidden: false },
      { id: 3, index: 2, pinned: false, hidden: false, groupId: 7 },
    ]);
    expect(layout.map((b) => b.fixed === true)).toEqual([true, false, true]);
  });
});

// --- the plan ------------------------------------------------------------------

describe("orderTarget", () => {
  const spec = "^p a b c d e f g h";
  const fates = {
    a: "close",
    b: "worth-it",
    c: "file",
    d: "could-not-read",
    e: "close",
    g: "worth-it",
    h: "file",
  } as const;

  test("Focus: worth-it, could-not-read, neutral, file, close; ties keep their order", () => {
    const { tabs, id } = build(spec);
    const sim = new SimWindow(tabs, "gecko");
    sim.arrange(orderTarget(sim.layout(), ranks(id, fates), "focus"));
    expect(names(sim, id, "pabcdefgh")).toBe("pbgdfchae");
  });

  test("Clear reverses the buckets and keeps the order inside each", () => {
    const { tabs, id } = build(spec);
    const sim = new SimWindow(tabs, "gecko");
    sim.arrange(orderTarget(sim.layout(), ranks(id, fates), "clear"));
    expect(names(sim, id, "pabcdefgh")).toBe("paechfdbg");
  });

  test("a group moves whole, ranked by its best member, its inside untouched", () => {
    const { tabs, id } = build("a [bcd] e [fg] h");
    const fates = {
      a: "file",
      b: "close",
      c: "worth-it",
      d: "close",
      f: "close",
      g: "close",
      h: "worth-it",
    } as const;
    for (const rule of ["gecko", "chromium"] as const) {
      const focus = new SimWindow(tabs, rule);
      focus.arrange(orderTarget(focus.layout(), ranks(id, fates), "focus"));
      // [bcd] holds a worth-it tab, so it leads; neutral e; file a; [fg] is all close.
      expect(names(focus, id, "abcdefgh")).toBe("[bcd]hea[fg]");
      const clear = new SimWindow(tabs, rule);
      clear.arrange(orderTarget(clear.layout(), ranks(id, fates), "clear"));
      expect(names(clear, id, "abcdefgh")).toBe("[fg]ae[bcd]h");
      expect(focus.joins + clear.joins).toBe(0);
    }
  });

  test("tabs with no verdict are neutral, and a group of them ranks neutral", () => {
    const { tabs, id } = build("a [bc] d e");
    const sim = new SimWindow(tabs, "gecko");
    sim.arrange(orderTarget(sim.layout(), ranks(id, { a: "close", e: "could-not-read" }), "focus"));
    expect(names(sim, id, "abcde")).toBe("e[bc]da");
  });

  test("pinned, hidden and folder blocks stay put, and each run sorts on its own", () => {
    const { tabs, id } = build("^p [^q^r] a b ~h c [d~x] e f");
    const fates = {
      a: "close",
      b: "worth-it",
      c: "close",
      e: "close",
      f: "worth-it",
      x: "worth-it",
    } as const;
    const sim = new SimWindow(tabs, "gecko");
    const before = sim.layout();
    sim.arrange(orderTarget(before, ranks(id, fates), "focus"));
    expect(names(sim, id, "pqrabhcdxef")).toBe("p[qr]bahc[dx]fe");
    const after = sim.layout();
    for (const i of [0, 1, 4, 6]) expect(after[i]).toEqual(before[i] as OrderBlock);
  });
});

// --- the moves -------------------------------------------------------------------

describe("nextMove", () => {
  test("a block moving left lands where the slot starts, by the listing's indexes", () => {
    const { tabs, id } = build("^p _ a b c");
    const sim = new SimWindow(tabs, "gecko");
    const next = nextMove(
      layoutFrom(sim.listing()),
      orderTarget(sim.layout(), ranks(id, { c: "worth-it" }), "focus"),
    );
    expect(next?.move.block.tabIds).toEqual([id("c")]);
    expect(next?.move.index).toBe(2);
  });

  test("a tab lands only beside a tab, on the side it comes from; groups move after", () => {
    const { tabs, id } = build("[bc] a d");
    const sim = new SimWindow(tabs, "gecko");
    const target = orderTarget(sim.layout(), ranks(id, { d: "worth-it" }), "focus");
    // a moves right, behind d: the tab whose index it takes is d, not the group.
    const next = nextMove(layoutFrom(sim.listing()), target);
    expect(next?.move.block.tabIds).toEqual([id("a")]);
    expect(next?.move.index).toBe(3);
    // Then [bc] moves in behind d.
    expect(sim.arrange(target)).toEqual({ moves: 2, complete: true });
    expect(names(sim, id, "abcd")).toBe("d[bc]a");
    expect(sim.joins).toBe(0);
  });

  test("one tab far from its place costs one move, however many tabs it passes", () => {
    const { tabs, id } = build("a [bc] d e f g h i j k [lm] n");
    const sim = new SimWindow(tabs, "gecko");
    const target = orderTarget(sim.layout(), ranks(id, { a: "close" }), "focus");
    expect(sim.arrange(target)).toEqual({ moves: 1, complete: true });
    expect(names(sim, id, "abcdefghijklmn")).toBe("[bc]defghijk[lm]na");
    const back = new SimWindow(tabs, "gecko");
    expect(back.arrange(orderTarget(back.layout(), ranks(id, { n: "worth-it" }), "focus"))).toEqual(
      {
        moves: 1,
        complete: true,
      },
    );
    expect(sim.joins + back.joins).toBe(0);
  });

  test("every permutation reaches its target and comes back, on both engines' rules", () => {
    const random = rng(112);
    let windows = 0;
    for (let n = 0; n < 400; n++) {
      // A pinned prefix, then ungrouped tabs and groups, the odd hidden tab, and
      // sometimes Zen's unlisted empty tab after the pinned block.
      let spec = "";
      const pins = Math.floor(random() * 3);
      for (let i = 0; i < pins; i++) spec += `^${String.fromCharCode(65 + i)}`;
      if (random() < 0.3) spec += "_";
      let letter = 97;
      const blocks = 3 + Math.floor(random() * 9);
      for (let b = 0; b < blocks; b++) {
        const r = random();
        if (r < 0.25) {
          const size = 1 + Math.floor(random() * 3);
          spec += "[";
          for (let k = 0; k < size; k++) spec += String.fromCharCode(letter++);
          spec += "]";
        } else if (r < 0.3) {
          spec += `~${String.fromCharCode(letter++)}`;
        } else {
          spec += String.fromCharCode(letter++);
        }
      }
      const { tabs } = build(spec);
      const fates = ["worth-it", "could-not-read", "neutral", "file", "close"] as const;
      const rank = new Map(tabs.map((t) => [t.id, FOCUS_RANK[fates[Math.floor(random() * 5)]!]]));
      const rankOf = (tabId: number) => rank.get(tabId) ?? FOCUS_RANK.neutral;
      for (const rule of ["gecko", "chromium"] as const) {
        for (const direction of ["focus", "clear"] as OrderDirection[]) {
          const sim = new SimWindow(tabs, rule);
          const before = sim.layout();
          const target = orderTarget(before, rankOf, direction);
          const res = sim.arrange(target);
          expect(res.complete).toBe(true);
          expect(res.moves).toBe(planMoves(before, target)?.length ?? -1);
          // Each block moves at most once.
          expect(res.moves).toBeLessThanOrEqual(before.length);
          const after = sim.layout();
          expect(after.map(blockKey)).toEqual(target);
          // Nothing joined or left a group, and no group changed inside.
          expect(sim.joins).toBe(0);
          for (const b of before) {
            expect(after.find((x) => blockKey(x) === blockKey(b))).toEqual(b);
          }
          // Repeating the action is a no-op.
          expect(planMoves(after, orderTarget(after, rankOf, direction))).toEqual([]);
          // Undo: back to the exact start.
          const back = restoreTarget(after, before);
          expect(back).not.toBeNull();
          expect(sim.arrange(back as string[]).complete).toBe(true);
          expect(sameLayout(sim.layout(), before)).toBe(true);
          expect(sim.joins).toBe(0);
          windows++;
        }
      }
    }
    expect(windows).toBe(1600);
  });

  test("a 600-tab window with a scattered digest takes one move per misplaced block at most", () => {
    const random = rng(600);
    let spec = "";
    for (let i = 0; i < 600; i++) {
      // Every 50th position opens a three-tab group.
      if (i % 50 === 10) spec += "[";
      spec += String.fromCharCode(0x4e00 + i);
      if (i % 50 === 12) spec += "]";
    }
    const { tabs } = build(spec);
    const fates = ["worth-it", "could-not-read", "file", "close"] as const;
    // A 40-item digest scattered through the window; the rest are neutral.
    const rank = new Map<number, number>();
    while (rank.size < 40) {
      const tab = tabs[Math.floor(random() * tabs.length)] as SimTab;
      rank.set(tab.id, FOCUS_RANK[fates[Math.floor(random() * 4)] as (typeof fates)[number]]);
    }
    const rankOf = (tabId: number) => rank.get(tabId) ?? FOCUS_RANK.neutral;
    for (const rule of ["gecko", "chromium"] as const) {
      const sim = new SimWindow(tabs, rule);
      const before = sim.layout();
      const res = sim.arrange(orderTarget(before, rankOf, "focus"));
      expect(res.complete).toBe(true);
      expect(res.moves).toBeLessThanOrEqual(40);
      expect(sim.joins).toBe(0);
    }
  });

  test("Undo restores every permutation of a window exactly (the shortlist restore did not)", () => {
    const { tabs, id } = build("^p a [bc] d [ef] g");
    const start = new SimWindow(tabs, "gecko").layout();
    const movable = start.slice(1);
    const perms = (xs: OrderBlock[]): OrderBlock[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
          );
    let count = 0;
    for (const perm of perms(movable)) {
      for (const rule of ["gecko", "chromium"] as const) {
        const sim = new SimWindow(tabs, rule);
        // Arrange the window into this permutation, then ask Undo for `start`.
        expect(sim.arrange([blockKey(start[0]!), ...perm.map(blockKey)]).complete).toBe(true);
        const back = restoreTarget(sim.layout(), start);
        expect(back).not.toBeNull();
        expect(sim.arrange(back as string[]).complete).toBe(true);
        expect(names(sim, id, "pabcdefg")).toBe("pa[bc]d[ef]g");
        expect(sim.joins).toBe(0);
        count++;
      }
    }
    expect(count).toBe(240);
  });

  test("Clear after Focus is Clear from the start: the buckets keep their inner order", () => {
    const random = rng(7);
    for (let n = 0; n < 100; n++) {
      const { tabs } = build("a b [cd] e f [gh] i j k");
      const rank = new Map(tabs.map((t) => [t.id, Math.floor(random() * 5)]));
      const rankOf = (tabId: number) => rank.get(tabId) ?? FOCUS_RANK.neutral;
      const direct = new SimWindow(tabs, "gecko");
      direct.arrange(orderTarget(direct.layout(), rankOf, "clear"));
      const chained = new SimWindow(tabs, "gecko");
      chained.arrange(orderTarget(chained.layout(), rankOf, "focus"));
      chained.arrange(orderTarget(chained.layout(), rankOf, "clear"));
      expect(chained.layout()).toEqual(direct.layout());
    }
  });
});

// --- Undo's checks ------------------------------------------------------------------

describe("sameLayout and restoreTarget", () => {
  const base = (): { sim: SimWindow; id: (n: string) => number } => {
    const { tabs, id } = build("^p a [bc] d e");
    return { sim: new SimWindow(tabs, "gecko"), id };
  };

  test("a drag, an added or closed tab, a pin, or a regroup all read as changed", () => {
    const { sim, id } = base();
    const after = sim.layout();
    const dragged = new SimWindow(sim.tabs, "chromium");
    dragged.moveTab(id("e"), 1);
    expect(sameLayout(dragged.layout(), after)).toBe(false);

    const added = new SimWindow(
      [...sim.tabs, { id: 99, groupId: -1, pinned: false, hidden: false }],
      "gecko",
    );
    expect(sameLayout(added.layout(), after)).toBe(false);

    const closed = new SimWindow(
      sim.tabs.filter((t) => t.id !== id("d")),
      "gecko",
    );
    expect(sameLayout(closed.layout(), after)).toBe(false);

    const pinned = new SimWindow(
      sim.tabs.map((t) => (t.id === id("a") ? { ...t, pinned: true } : t)),
      "gecko",
    );
    expect(sameLayout(pinned.layout(), after)).toBe(false);

    const regrouped = new SimWindow(
      sim.tabs.map((t) => (t.groupId === 100 ? { ...t, groupId: 101 } : t)),
      "gecko",
    );
    expect(sameLayout(regrouped.layout(), after)).toBe(false);
    const ungroupedOne = new SimWindow(
      sim.tabs.map((t) => (t.id === id("c") ? { ...t, groupId: -1 } : t)),
      "gecko",
    );
    expect(sameLayout(ungroupedOne.layout(), after)).toBe(false);
    expect(sameLayout(sim.layout(), after)).toBe(true);
  });

  test("no exact way back: a closed, added or regrouped tab, a pin, or a run crossed", () => {
    const { sim, id } = base();
    const before = sim.layout();
    expect(restoreTarget(sim.layout(), before)).toEqual(before.map(blockKey));
    expect(
      restoreTarget(
        new SimWindow(
          sim.tabs.filter((t) => t.id !== id("d")),
          "gecko",
        ).layout(),
        before,
      ),
    ).toBeNull();
    expect(
      restoreTarget(
        new SimWindow(
          [...sim.tabs, { id: 99, groupId: -1, pinned: false, hidden: false }],
          "gecko",
        ).layout(),
        before,
      ),
    ).toBeNull();
    expect(
      restoreTarget(
        new SimWindow(
          sim.tabs.map((t) => (t.id === id("c") ? { ...t, groupId: -1 } : t)),
          "gecko",
        ).layout(),
        before,
      ),
    ).toBeNull();
    // `e` hidden now: a fixed block where `before` had a movable one.
    expect(
      restoreTarget(
        new SimWindow(
          sim.tabs.map((t) => (t.id === id("e") ? { ...t, hidden: true } : t)),
          "gecko",
        ).layout(),
        before,
      ),
    ).toBeNull();
    // `a` dragged across a hidden tab into another run.
    const { tabs: split, id: sid } = build("a ~h b");
    const start = new SimWindow(split, "gecko");
    const from = start.layout();
    start.moveTab(sid("a"), 2);
    expect(restoreTarget(start.layout(), from)).toBeNull();
  });
});
