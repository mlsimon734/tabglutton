// Move to top: the Digest panel's shortlist action. The worth-it tabs move to
// the head of their own window's tab list, right after the pinned tabs, in the
// digest's order — never into a group, never across windows, and never a
// pinned tab. Pure, so the index arithmetic and its Undo are unit-tested; the
// browser half is `moveTabsToTop` / `restoreTabOrder` in `background.ts`.
//
// Measured on Chrome for Testing 148 and Firefox 154, headless
// (docs/ENGINEERING.md §Move to top): `tabs.move(ids, { index })` places the
// ids in array order starting at `index`; a single move lands at the index
// asked for on both; an index inside the pinned block is clamped by Chrome and
// silently ignored by Firefox, so the target is always the first unpinned tab
// the listing can see.

/** The slice of a tab the ordering needs. */
export interface OrderTab {
  id: number;
  index: number;
  pinned: boolean;
}

/** Where a moved tab sat before Move to top, for Undo. */
export interface TabPosition {
  tabId: number;
  windowId: number;
  index: number;
}

/**
 * The index Move to top aims at in one window: the first unpinned tab this
 * listing can see, or null when there is none. Taken from what the listing
 * shows rather than counted from the pinned tabs, so on Zen — where another
 * workspace's tabs are absent from the listing but still hold indexes — it
 * lands before this workspace's first ordinary tab.
 */
export function topIndex(tabs: readonly OrderTab[]): number | null {
  let top: number | null = null;
  for (const tab of tabs) {
    if (!tab.pinned && (top === null || tab.index < top)) top = tab.index;
  }
  return top;
}

/**
 * Which of `ids` now lead the window's unpinned tabs. A tab the engine did not
 * move (an index it ignored, a tab that moved on its own) sits below a tab
 * that was not asked to move, and is not counted.
 */
export function landedAtTop(tabs: readonly OrderTab[], ids: readonly number[]): Set<number> {
  const wanted = new Set(ids);
  const landed = new Set<number>();
  const unpinned = tabs.filter((t) => !t.pinned).sort((a, b) => a.index - b.index);
  for (const tab of unpinned) {
    if (!wanted.has(tab.id)) break;
    landed.add(tab.id);
  }
  return landed;
}

/**
 * The single moves that put tabs back where they were, in order: per window,
 * highest original index first. With the moved tabs gathered at the top and
 * every other tab still in its old relative order, placing the one that sat
 * furthest down first leaves each later move's target index counting exactly
 * the tabs that preceded it originally.
 */
export function restoreSequence(from: readonly TabPosition[]): TabPosition[] {
  return [...from].sort((a, b) => a.windowId - b.windowId || b.index - a.index);
}
