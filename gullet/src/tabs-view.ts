// How a selected listing is *rendered* for an agent, as opposed to how it is
// selected (`selectTabs` in bridge-protocol.ts) or transported. Pure, and shared
// with Gullet, which is the only caller: see below for why this runs once at the
// end rather than in the extension's pass.

import type { BridgeTab, ClipMark } from "../../src/bridge-protocol.js";
import { clipText as clip, displayUrl } from "../../src/normalize.js";

// The listing's URL form lives beside `normalizeUrl` because the extension has to
// recognise it too: a `digest_report` item carries the URL exactly as a listing
// showed it, clipped or not (`observeReport`).
export { displayUrl, TAB_URL_MAX } from "../../src/normalize.js";

/**
 * Titles are clipped, not summarised. 120 is where the curve turns: measured
 * over a real 874-tab backlog the mean title is ~104 characters, so there is no
 * "clip the outliers" cap — anything tighter cuts into the body of the
 * distribution rather than its tail. At 120 roughly a quarter of tabs lose
 * something, and what they lose is cheap, because titles are front-loaded: the
 * tail of a long one is usually the site suffix ("… | GitHub") that the URL
 * already says.
 */
export const TAB_TITLE_MAX = 120;

/**
 * A tab as it appears in a rendered listing. `index` is gone — it duplicated
 * the array order under `sort: "window"` and meant nothing under the others,
 * and nothing consumes it: the undo log records position from the live
 * `browser.tabs.Tab`, not from a listing. `windowId` survives only when the
 * listing actually spans more than one window.
 */
export interface RenderedTab {
  id: number;
  title: string;
  url: string;
  lastAccessed?: number;
  discarded?: boolean;
  pinned?: boolean;
  active?: boolean;
  hidden?: boolean;
  windowId?: number;
  /** `"launched"` or `"verified"` on a page the extension remembers filing. */
  clipped?: ClipMark;
}

export interface RenderedTabs {
  tabs: RenderedTab[];
  /** The one window every tab is in, hoisted out of them. Omitted otherwise. */
  windowId?: number;
}

/**
 * Shape a selected listing for output.
 *
 * Runs **once, in Gullet**, deliberately — not in the extension's `selectTabs`
 * pass, even though doing it there would shrink the socket frame. Gullet
 * re-applies `query` over the merged results, and a query matching text that
 * clipping had already removed would silently drop the very tab the agent asked
 * for. Selection sees whole strings; only what is handed to the model is
 * trimmed. The socket is loopback, so the frame size it saves is not a budget
 * anyone is spending.
 *
 * `hoistWindow` is false when more than one browser contributed, since two
 * browsers can each call their window `1` and a hoisted id would then claim a
 * single window that does not exist.
 */
export function renderTabs(
  tabs: readonly BridgeTab[],
  opts: { hoistWindow?: boolean } = {},
): RenderedTabs {
  const windows = new Set(tabs.map((tab) => tab.windowId));
  const shared = (opts.hoistWindow ?? true) && windows.size === 1 ? [...windows][0] : undefined;

  const rendered = tabs.map((tab) => {
    const out: RenderedTab = {
      id: tab.id,
      title: clip(tab.title, TAB_TITLE_MAX),
      url: displayUrl(tab.url),
    };
    if (tab.lastAccessed !== undefined) out.lastAccessed = tab.lastAccessed;
    if (tab.discarded) out.discarded = true;
    if (tab.pinned) out.pinned = true;
    if (tab.active) out.active = true;
    if (tab.hidden) out.hidden = true;
    // Passed through rather than reduced to a boolean: "the handoff was made"
    // and "a note was seen on disk" are different claims, and an agent deciding
    // whether to re-read a page is entitled to know which one it has.
    if (tab.clipped) out.clipped = tab.clipped;
    if (shared === undefined && tab.windowId !== undefined) out.windowId = tab.windowId;
    return out;
  });

  return shared === undefined ? { tabs: rendered } : { tabs: rendered, windowId: shared };
}
