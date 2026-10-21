// Order by priority (#112): the Digest panel's Focus and Clear reorder the one
// window the panel was invoked from by the digest's verdicts, and Undo puts
// that window back exactly or refuses. Pure, so the plan, the move sequence and
// the layout comparison are unit-tested; the browser half is `readOrderLayout`
// and `arrangeWindow` in `background.ts`.
//
// Measured on Chrome for Testing 148, Firefox 154 and Zen 1.23.3b
// (docs/ENGINEERING.md §Order by priority):
// - `tabs.move(id, { index })` and `tabGroups.move(id, { index })` put the
//   first moved tab at `index` after the move, leftward or rightward, and a
//   group moves whole with its inner order intact.
// - A tab moved into a group's span joins the group. On Gecko that includes
//   the group's first index, so an ungrouped tab is never moved directly in
//   front of a group: the group steps aside instead (`nextStep`). Chrome does
//   not need this, and does not mind it.
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

export function blockKey(block: OrderBlock): string {
  return block.groupId !== undefined ? `g${block.groupId}` : `t${block.tabIds[0] ?? -1}`;
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
 * The next move toward `target`, as positions in `layout`: the block at `from`
 * goes immediately before or after the block at `to`. Left to right, slot by
 * slot: the block that belongs in the first wrong slot moves left into it,
 * unless it is an ungrouped tab and the slot holds a group. Gecko would add the
 * tab to that group, so the group moves right, to just after the tab, and the
 * slot is tried again; every such step leaves one block fewer between the slot
 * and the tab. Null when `layout` already is `target`, or is not a permutation
 * of it.
 */
function nextStep(
  layout: readonly OrderBlock[],
  target: readonly string[],
): { from: number; to: number; after: boolean } | null {
  const keys = layout.map(blockKey);
  for (let slot = 0; slot < keys.length; slot++) {
    const want = target[slot];
    if (keys[slot] === want) continue;
    const at = want === undefined ? -1 : keys.indexOf(want, slot + 1);
    const here = layout[slot];
    const mover = layout[at];
    if (at < 0 || !here || !mover || here.fixed || mover.fixed) return null;
    if (mover.groupId === undefined && here.groupId !== undefined) {
      return { from: slot, to: at, after: true };
    }
    return { from: at, to: slot, after: false };
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
 * A block moving left lands where the slot's block starts; a group stepping
 * right past a tab lands where that tab's last index is, less its own size.
 */
export function nextMove(
  layout: readonly PlacedBlock[],
  target: readonly string[],
): { move: OrderMove; expect: OrderBlock[] } | null {
  const step = nextStep(layout, target);
  if (!step) return null;
  const block = layout[step.from] as PlacedBlock;
  const anchor = layout[step.to] as PlacedBlock;
  const index = step.after ? anchor.end - block.tabIds.length + 1 : anchor.start;
  return { move: { block, index }, expect: stripIndexes(applyStep(layout, step)) };
}

/**
 * Every step from `layout` to `target`, without indexes: what `nextMove` will
 * ask for one read-back at a time. Its length bounds the browser loop.
 */
export function planMoves(
  layout: readonly OrderBlock[],
  target: readonly string[],
): Array<{ key: string; beside: string; after: boolean }> {
  const out: Array<{ key: string; beside: string; after: boolean }> = [];
  let current = [...layout];
  // Each slot takes at most one step per block still to its right.
  for (let guard = layout.length * layout.length + 1; guard > 0; guard--) {
    const step = nextStep(current, target);
    if (!step) break;
    out.push({
      key: blockKey(current[step.from] as OrderBlock),
      beside: blockKey(current[step.to] as OrderBlock),
      after: step.after,
    });
    current = applyStep(current, step);
  }
  return out;
}

export interface ArrangeIo {
  /** The window's layout, read from a fresh listing. */
  read: () => Promise<PlacedBlock[]>;
  /** One `tabs.move` or `tabGroups.move`. */
  move: (move: OrderMove) => Promise<void>;
}

export interface ArrangeResult {
  /** The window as last read. */
  layout: PlacedBlock[];
  moves: number;
  /** The window ended in `target`'s order, every read-back as planned. */
  complete: boolean;
}

/**
 * Move a window toward `target` one block at a time, reading it back after
 * every move. It stops, incomplete, as soon as a read-back is not what the move
 * should have left (a tab dragged, opened or closed meanwhile, or an engine
 * that ignored the index) or a move throws, and it never makes more moves than
 * the plan has.
 */
export async function arrange(io: ArrangeIo, target: readonly string[]): Promise<ArrangeResult> {
  let layout = await io.read();
  const limit = planMoves(layout, target).length;
  let moves = 0;
  for (;;) {
    const next = nextMove(layout, target);
    if (!next) {
      const keys = layout.map(blockKey);
      const complete = keys.length === target.length && keys.every((k, i) => k === target[i]);
      return { layout, moves, complete };
    }
    if (moves >= limit) return { layout, moves, complete: false };
    try {
      await io.move(next.move);
    } catch {
      return { layout: await io.read().catch(() => layout), moves, complete: false };
    }
    moves++;
    layout = await io.read();
    if (!sameLayout(stripIndexes(layout), next.expect)) return { layout, moves, complete: false };
  }
}

/** Tabs a window's order leaves in place: pinned, hidden, and the members of fixed groups. */
export function fixedTabs(layout: readonly OrderBlock[]): number {
  return layout.reduce((n, b) => n + (b.fixed ? b.tabIds.length : 0), 0);
}
