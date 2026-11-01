// Order by priority (#112): the Digest panel's Focus and Clear reorder the one
// window the panel was invoked from by the digest's verdicts, and Undo puts
// that window back exactly or refuses. Pure, so the plan, the move sequence and
// the layout comparison are unit-tested; the browser half is `readOrderLayout`
// and `moveOrderBlock` in `background.ts`.
//
// Measured on Chrome for Testing 148, Firefox 154 and Zen 1.23.3b
// (docs/ENGINEERING.md §Order by priority):
// - `tabs.move(id, { index })` and `tabGroups.move(id, { index })` put the
//   first moved tab at `index` after the move, leftward or rightward, and a
//   group moves whole with its inner order intact.
// - A tab moved into a group's span joins the group. On Gecko a tab moved to a
//   group's edge does too: it takes the group of the tab whose index it takes,
//   the one on its right when it moves left and the one on its left when it
//   moves right. So an ungrouped tab only ever lands beside another ungrouped
//   tab, on that side (`nextStep`). Chrome does not need this, and does not
//   mind it.
// - A batch move whose tabs start on both sides of its target lands one slot
//   early on Zen, so every move here is one tab or one group.
// - The target index is read from the listing, never counted: an index inside
//   the pinned block is clamped by Chrome and ignored by Firefox, and on Zen a
//   hidden empty tab holds an index the listing does not show.

import type { DigestFate } from "./bridge-protocol.js";

export type OrderDirection = "focus" | "clear";

/** Focus order, best first. Clear reverses the buckets and keeps the order inside each. */
export const FOCUS_RANK: Readonly<Record<DigestFate | "neutral", number>> = {
  "worth-it": 0,
  "could-not-read": 1,
  neutral: 2,
  file: 3,
  close: 4,
};

/** The slice of a live tab the layout needs. */
export interface OrderTab {
  id: number;
  index: number;
  pinned: boolean;
  hidden: boolean;
  /** Absent (or -1) for an ungrouped tab. */
  groupId?: number;
}

/** What the order moves: one ungrouped tab, or one whole tab group. */
export interface OrderBlock {
  /** In index order. */
  tabIds: number[];
  /** Set for a tab group. */
  groupId?: number;
  /**
   * Pinned, hidden, or a group with a pinned or hidden member (a Zen folder):
   * never moved, and the edge of the run it sits in.
   */
  fixed?: true;
}

/** A block where the listing shows it now. */
export interface PlacedBlock extends OrderBlock {
  start: number;
  end: number;
}

/** One move, for the browser half: `tabs.move` for a tab, `tabGroups.move` for a group. */
export interface OrderMove {
  block: PlacedBlock;
  /** Where the block's first tab ends up. */
  index: number;
}

/**
 * A block's name in a target. A fixed block goes by its first tab, so the two
 * pieces of a group the listing shows split never share a name.
 */
export function blockKey(block: OrderBlock): string {
  return block.groupId !== undefined && !block.fixed
    ? `g${block.groupId}`
    : `t${block.tabIds[0] ?? -1}`;
}

/** The window's tabs as blocks, in index order. */
export function layoutFrom(tabs: readonly OrderTab[]): PlacedBlock[] {
  const blocks: PlacedBlock[] = [];
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    const groupId = tab.groupId !== undefined && tab.groupId !== -1 ? tab.groupId : undefined;
    const held = tab.pinned || tab.hidden;
    const last = blocks[blocks.length - 1];
    if (groupId !== undefined && last?.groupId === groupId) {
      last.tabIds.push(tab.id);
      last.end = tab.index;
      if (held) last.fixed = true;
      continue;
    }
    blocks.push({
      tabIds: [tab.id],
      ...(groupId !== undefined ? { groupId } : {}),
      ...(held ? { fixed: true as const } : {}),
      start: tab.index,
      end: tab.index,
    });
  }
  // A group the listing shows in two pieces cannot be moved as one block.
  const pieces = new Map<number, number>();
  for (const b of blocks) {
    if (b.groupId !== undefined) pieces.set(b.groupId, (pieces.get(b.groupId) ?? 0) + 1);
  }
  for (const b of blocks) {
    if (b.groupId !== undefined && (pieces.get(b.groupId) ?? 0) > 1) b.fixed = true;
  }
  return blocks;
}

/** The layout without the listing's indexes, as it is stored. */
export function stripIndexes(layout: readonly OrderBlock[]): OrderBlock[] {
  return layout.map((b) => ({
    tabIds: [...b.tabIds],
    ...(b.groupId !== undefined ? { groupId: b.groupId } : {}),
    ...(b.fixed ? { fixed: true as const } : {}),
  }));
}

function sameBlock(a: OrderBlock, b: OrderBlock): boolean {
  return (
    a.groupId === b.groupId &&
    (a.fixed === true) === (b.fixed === true) &&
    a.tabIds.length === b.tabIds.length &&
    a.tabIds.every((id, i) => id === b.tabIds[i])
  );
}

/** Same blocks, same members, same order: nothing was dragged, added, closed, pinned or regrouped. */
export function sameLayout(a: readonly OrderBlock[], b: readonly OrderBlock[]): boolean {
  return a.length === b.length && a.every((block, i) => sameBlock(block, b[i] as OrderBlock));
}

/**
 * The block order Focus or Clear asks for. Fixed blocks stay where they are and
 * split the window into runs; each run is sorted on its own, stably, by
 * bucket. A group ranks by its best member's Focus bucket in both directions,
 * so a group holding a worth-it tab sorts first under Focus and last under Clear.
 */
export function orderTarget(
  layout: readonly OrderBlock[],
  rankOf: (tabId: number) => number,
  direction: OrderDirection,
): string[] {
  const keys: string[] = [];
  let run: Array<{ key: string; rank: number; at: number }> = [];
  const flush = (): void => {
    run.sort((a, b) => (direction === "focus" ? a.rank - b.rank : b.rank - a.rank) || a.at - b.at);
    keys.push(...run.map((r) => r.key));
    run = [];
  };
  layout.forEach((block, at) => {
    if (block.fixed) {
      flush();
      keys.push(blockKey(block));
      return;
    }
    run.push({ key: blockKey(block), rank: Math.min(...block.tabIds.map(rankOf)), at });
  });
  flush();
  return keys;
}

/** Each block's run: how many fixed blocks precede it. Fixed blocks have none. */
function runs(layout: readonly OrderBlock[]): Map<string, number> {
  const out = new Map<string, number>();
  let run = 0;
  for (const block of layout) {
    if (block.fixed) run++;
    else out.set(blockKey(block), run);
  }
  return out;
}

/**
 * Undo's target: `before`'s order, when `live` holds exactly the same blocks
 * with the same members, the fixed ones where they were and every other one in
 * the run it started in. Otherwise null: no sequence of moves gets back to
 * `before` exactly.
 */
export function restoreTarget(
  live: readonly OrderBlock[],
  before: readonly OrderBlock[],
): string[] | null {
  if (live.length !== before.length) return null;
  const liveByKey = new Map(live.map((b) => [blockKey(b), b] as const));
  if (liveByKey.size !== live.length) return null;
  for (let i = 0; i < before.length; i++) {
    const want = before[i] as OrderBlock;
    const now = live[i] as OrderBlock;
    if ((want.fixed || now.fixed) && !sameBlock(want, now)) return null;
    const match = liveByKey.get(blockKey(want));
    if (!match || !sameBlock(match, want)) return null;
  }
  const liveRuns = runs(live);
  for (const [key, run] of runs(before)) {
    if (liveRuns.get(key) !== run) return null;
  }
  return before.map(blockKey);
}

/**
 * Undo's whole check, shared by the panel's button and the action: the window
 * must still be exactly as the order left it, and `before` reachable from there.
 */
export function undoTarget(
  live: readonly OrderBlock[],
  before: readonly OrderBlock[],
  after: readonly OrderBlock[],
): string[] | null {
  return sameLayout(live, after) ? restoreTarget(live, before) : null;
}

type Step = { from: number; to: number; after: boolean };

/** Positions of one longest strictly increasing subsequence of `values`. */
function increasingRun(values: readonly number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = [];
  values.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((values[tails[mid] as number] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? (tails[lo - 1] as number) : -1;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (
    let i = tails.length ? (tails[tails.length - 1] as number) : -1;
    i >= 0;
    i = prev[i] as number
  ) {
    out.push(i);
  }
  return out.reverse();
}

/** The first position in `stays` (in target order) whose block belongs after `want`. */
function firstAfter(stays: readonly number[], posOf: (i: number) => number, want: number): number {
  let lo = 0;
  let hi = stays.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (posOf(stays[mid] as number) < want) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The next move toward `target`, as positions in `layout`: the block at `from`
 * goes immediately before or after the block at `to`. Two passes, each with the
 * fewest moves of its kind, so one far-off tab costs one move rather than one
 * for every tab behind it:
 *
 * 1. Ungrouped tabs, until they stand in target order among themselves. In each
 *    run the longest sequence of them already in order stays, and every other
 *    one moves once, beside a tab that stays: moving left it lands in front of
 *    one, moving right it lands behind one, so the tab whose index it takes is
 *    never in a group. A tab that could go neither way would already be in
 *    order, so one of the two always applies.
 * 2. Groups, which land anywhere: every ungrouped tab stays, with the longest
 *    sequence of groups already in order between them, and every other group
 *    moves once, beside a block that stays.
 *
 * Null when `layout` already is `target`, or cannot reach it: a block missing,
 * a fixed block out of place, or a block in another run.
 */
function nextStep(layout: readonly OrderBlock[], target: readonly string[]): Step | null {
  const keys = layout.map(blockKey);
  if (keys.length !== target.length || keys.every((k, i) => k === target[i])) return null;
  const pos = new Map(target.map((k, i) => [k, i] as const));
  if (pos.size !== target.length) return null;
  const posOf = (i: number): number => pos.get(keys[i] as string) as number;
  // Fixed blocks hold the same places in both, so a position's run is the same in both.
  const runAt: number[] = [];
  let run = 0;
  for (const block of layout) runAt.push(block.fixed ? ++run : run);
  const runs: number[][] = [];
  for (let i = 0; i < keys.length; i++) {
    const block = layout[i] as OrderBlock;
    const at = pos.get(keys[i] as string);
    if (at === undefined || runAt[at] !== runAt[i]) return null;
    if (block.fixed !== (layout[at] as OrderBlock).fixed || (block.fixed && at !== i)) return null;
    if (block.fixed) continue;
    if (runs.length === 0 || runAt[i] !== runAt[(runs[runs.length - 1] as number[])[0] as number]) {
      runs.push([]);
    }
    (runs[runs.length - 1] as number[]).push(i);
  }
  const isTab = (i: number): boolean => (layout[i] as OrderBlock).groupId === undefined;

  for (const blocks of runs) {
    const tabs = blocks.filter(isTab);
    const stays = increasingRun(tabs.map(posOf)).map((j) => tabs[j] as number);
    if (stays.length === tabs.length) continue;
    const staying = new Set(stays);
    for (const i of tabs) {
      if (staying.has(i)) continue;
      const k = firstAfter(stays, posOf, posOf(i));
      const before = stays[k];
      const after = stays[k - 1];
      if (before !== undefined && before < i) return { from: i, to: before, after: false };
      if (after !== undefined && after > i) return { from: i, to: after, after: true };
    }
    return null;
  }

  for (const blocks of runs) {
    const stays: number[] = [];
    let floor = -1;
    let gap: number[] = [];
    // The groups between two staying tabs that already belong between them.
    const close = (ceiling: number): void => {
      const fits = gap.filter((i) => posOf(i) > floor && posOf(i) < ceiling);
      stays.push(...increasingRun(fits.map(posOf)).map((j) => fits[j] as number));
      gap = [];
    };
    for (const i of blocks) {
      if (!isTab(i)) {
        gap.push(i);
        continue;
      }
      close(posOf(i));
      stays.push(i);
      floor = posOf(i);
    }
    close(Infinity);
    if (stays.length === blocks.length) continue;
    const staying = new Set(stays);
    const i = blocks.find((b) => !staying.has(b)) as number;
    const k = firstAfter(stays, posOf, posOf(i));
    const after = stays[k - 1];
    return after !== undefined
      ? { from: i, to: after, after: true }
      : { from: i, to: stays[k] as number, after: false };
  }
  return null;
}

/** `layout` after one step: the moved block taken out and put back beside its anchor. */
function applyStep<T extends OrderBlock>(
  layout: readonly T[],
  step: { from: number; to: number; after: boolean },
): T[] {
  const moving = layout[step.from] as T;
  const anchor = layout[step.to] as T;
  const rest = layout.filter((_, i) => i !== step.from);
  const at = rest.indexOf(anchor);
  rest.splice(step.after ? at + 1 : at, 0, moving);
  return rest;
}

/**
 * The next browser move toward `target`, with the index the engine needs, and
 * the layout the read-back must then show; null when the window is in order.
 * The index comes from the listing: a block moving left lands where its new
 * right-hand neighbour starts; a block moving right lands where its new
 * left-hand neighbour ends, less its own size.
 */
export function nextMove(
  layout: readonly PlacedBlock[],
  target: readonly string[],
): { move: OrderMove; expect: OrderBlock[] } | null {
  const step = nextStep(layout, target);
  if (!step) return null;
  const block = layout[step.from] as PlacedBlock;
  const moved = applyStep(layout, step);
  const at = moved.indexOf(block);
  const index =
    step.to > step.from
      ? (moved[at - 1] as PlacedBlock).end - block.tabIds.length + 1
      : (moved[at + 1] as PlacedBlock).start;
  return { move: { block, index }, expect: stripIndexes(moved) };
}

/**
 * Every step from `layout` to `target`, without indexes: what `nextMove` will
 * ask for one read-back at a time. Its length bounds the browser loop. Null when
 * the steps would not end in `target`, so nothing is moved toward it.
 */
export function planMoves(
  layout: readonly OrderBlock[],
  target: readonly string[],
): Array<{ key: string; beside: string; after: boolean }> | null {
  const out: Array<{ key: string; beside: string; after: boolean }> = [];
  let current = [...layout];
  for (let guard = layout.length * layout.length + 1; guard > 0; guard--) {
    const step = nextStep(current, target);
    if (!step) {
      const keys = current.map(blockKey);
      return keys.length === target.length && keys.every((k, i) => k === target[i]) ? out : null;
    }
    out.push({
      key: blockKey(current[step.from] as OrderBlock),
      beside: blockKey(current[step.to] as OrderBlock),
      after: step.after,
    });
    current = applyStep(current, step);
  }
  return null;
}

export interface ArrangeIo {
  /** The window's layout, read from a fresh listing. */
  read: () => Promise<PlacedBlock[]>;
  /** One `tabs.move` or `tabGroups.move`. */
  move: (move: OrderMove) => Promise<void>;
}

export interface ArrangeResult {
  /**
   * The window as last read, or as the last move should have left it when that
   * read-back failed; absent when the window could not be read at all.
   */
  layout?: OrderBlock[];
  moves: number;
  /** The window ended in `target`'s order, every read-back as planned. */
  complete: boolean;
}

/**
 * Move a window toward `target` one block at a time, reading it back after
 * every move. It stops, incomplete, as soon as a read-back is not what the move
 * should have left (a tab dragged, opened or closed meanwhile, or an engine
 * that ignored the index), a move or a read throws, or the plan runs out. It
 * never throws, so the caller always records where the window was left.
 */
export async function arrange(io: ArrangeIo, target: readonly string[]): Promise<ArrangeResult> {
  let layout: PlacedBlock[];
  try {
    layout = await io.read();
  } catch {
    return { moves: 0, complete: false };
  }
  const plan = planMoves(layout, target);
  let moves = 0;
  for (;;) {
    const next = plan ? nextMove(layout, target) : null;
    if (!next) {
      const keys = layout.map(blockKey);
      const complete = keys.length === target.length && keys.every((k, i) => k === target[i]);
      return { layout: stripIndexes(layout), moves, complete };
    }
    if (moves >= (plan?.length ?? 0))
      return { layout: stripIndexes(layout), moves, complete: false };
    try {
      await io.move(next.move);
    } catch {
      const now = await io.read().catch(() => null);
      return { ...(now ? { layout: stripIndexes(now) } : {}), moves, complete: false };
    }
    moves++;
    try {
      layout = await io.read();
    } catch {
      return { layout: next.expect, moves, complete: false };
    }
    if (!sameLayout(stripIndexes(layout), next.expect)) {
      return { layout: stripIndexes(layout), moves, complete: false };
    }
  }
}
