// How a selected listing is *rendered* for an agent, as opposed to how it is
// selected (`selectTabs` in bridge-protocol.ts) or transported. Pure, and shared
// with Gullet, which is the only caller: see below for why this runs once at the
// end rather than in the extension's pass.

import type { BridgeTab } from "./bridge-protocol.js";
import { isTrackingParam } from "./normalize.js";

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
 * URLs are trimmed structurally first (see `displayUrl`) and only clipped as a
 * backstop, which is why this is generous. A URL cut mid-string stops being a
 * URL: it cannot be copied, and two distinct tabs can clip to the same prefix
 * and read as duplicates. Losing a data: URI's payload is the case this exists
 * for, and there the prefix really is all the information there is.
 */
export const TAB_URL_MAX = 200;

/** Trailing ellipsis, so a clipped value can never be read as a complete one. */
const ELLIPSIS = "…";

/**
 * Tolerates a non-string because the tabs reaching here came off a socket. The
 * extension guarantees `title` and `url`, but a version-skewed or malformed one
 * does not, and one field missing from one tab must not throw away a listing of
 * eight hundred — the same reason `tabs_list` keeps a failing browser's partner.
 */
function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length <= max ? text : text.slice(0, max - 1) + ELLIPSIS;
}

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
}

export interface RenderedTabs {
  tabs: RenderedTab[];
  /** The one window every tab is in, hoisted out of them. Omitted otherwise. */
  windowId?: number;
}

/**
 * A shorter URL that is still a URL. Drops the click-tracking params, the `www.`
 * and the trailing slash — which is where long URLs get long — while keeping the
 * scheme, the parameter order the page actually used, and the fragment.
 *
 * Keeping the scheme costs ~8 bytes a tab and buys a string an agent can hand
 * back to the user verbatim; keeping the fragment is not optional, because for
 * an SPA the fragment is the whole page identity. Params keep their original
 * order rather than being sorted: `normalizeUrl` sorts because it is building a
 * comparison key, and this is not one.
 */
export function displayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Also the path for a missing or non-string url; see `clip`.
    return clip(raw, TAB_URL_MAX);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return clip(raw, TAB_URL_MAX);

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : "";
  const kept = [...url.searchParams].filter(([key]) => !isTrackingParam(key));
  const search = kept.length
    ? "?" + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  return clip(`${url.protocol}//${host}${path}${search}${url.hash}`, TAB_URL_MAX);
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
    if (shared === undefined && tab.windowId !== undefined) out.windowId = tab.windowId;
    return out;
  });

  return shared === undefined ? { tabs: rendered } : { tabs: rendered, windowId: shared };
}
