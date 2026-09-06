import type { Settings } from "./storage.js";

/**
 * The duplicate notice: a small pill Tabglutton drops into the corner of the
 * page the user is on once the badge count reaches a threshold, offering Dedup
 * right there. It is a piece of the extension's own UI shown inside the browser
 * — never a system notification, which is the one thing the setting exists to
 * not be.
 *
 * This module is the pure half: when a badge pass should show it, and what it
 * says. The background owns the injection (`showDupNotice`), the content script
 * `dup-notice-page.ts` places the frame, and `notice/dup-notice.ts` is the frame.
 */

export const DEFAULT_DUP_NOTICE_THRESHOLD = 10;

/**
 * At most one notice per this interval, whatever the count does in between.
 * Without it a user hovering around the threshold — close one tab, open one —
 * would be told about the same pile on every crossing.
 */
export const DUP_NOTICE_COOLDOWN_MS = 30 * 60 * 1000;

/** How long the frame stays up unattended before it takes itself down. */
export const DUP_NOTICE_LINGER_MS = 15_000;

/** Bounds a stored or typed threshold has to satisfy; anything else is the default. */
export function isDupNoticeThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9999;
}

/**
 * What the background remembers between badge passes, in `storage.session`
 * rather than a module variable because the page it runs in is an event page on
 * Gecko and a service worker on Chrome — either dies between tab events, and a
 * memory that dies with it would re-announce the same pile on every wake.
 */
export interface DupNoticeMemory {
  /**
   * The current climb above the threshold has had its notice. Cleared only by
   * an observed count below the threshold, so one pile is announced once.
   */
  shown: boolean;
  /** When a notice last appeared; drives the cooldown. */
  lastShownAt?: number;
}

export type DupNoticeSettings = Pick<Settings, "dupNoticeEnabled" | "dupNoticeThreshold">;

export interface DupNoticePlan {
  /** Inject the notice now. The caller records `memory` only once that succeeds. */
  show: boolean;
  memory: DupNoticeMemory;
}

/**
 * What one badge pass saw. `settled` is false while any tab in scope has a
 * navigation that has not committed — neither engine reports such a tab's real
 * URL yet (Chrome `""`, Gecko `about:blank`), so it is invisible to the
 * duplicate count and the count is a floor, not the pile.
 */
export interface DupNoticeObservation {
  dupCount: number;
  settled: boolean;
}

/**
 * Decide one badge pass. Four rules, each holding one promise to the user:
 *
 * - **Once per pile.** A notice arms `shown`, and only a count observed below
 *   the threshold disarms it — so ten more duplicates on top of an announced
 *   pile say nothing, and dismissing the notice is not undone by the next tab.
 * - **A floor never disarms.** An unsettled pass may show (the pile is at least
 *   the count) but never disarms: the low count may be tabs mid-navigation.
 *   Undo is the case that made this a rule — restored tabs are created faster
 *   than they commit, so the pass right after them read zero duplicates,
 *   disarmed the pile, and the mark `dupNoticeAfterReopen` had just set was
 *   gone before the tabs were back. Measured live on Chrome 152.
 * - **At most once per cooldown.** A disarm-and-rearm inside
 *   `DUP_NOTICE_COOLDOWN_MS` holds rather than shows: the count dipping under
 *   the threshold and back is the same pile, not a new one.
 * - **Off means untouched.** A disabled setting leaves the memory exactly as it
 *   is rather than disarming it. The background evaluates this with default
 *   settings on a wake that beats the settings load, and a disarm there would
 *   turn the next pass into a fresh announcement of a pile already announced.
 */
export function planDupNotice(
  memory: DupNoticeMemory,
  seen: DupNoticeObservation,
  settings: DupNoticeSettings,
  now: number,
): DupNoticePlan {
  if (!settings.dupNoticeEnabled) return { show: false, memory };
  if (seen.dupCount < settings.dupNoticeThreshold) {
    const disarm = memory.shown && seen.settled;
    return { show: false, memory: disarm ? { ...memory, shown: false } : memory };
  }
  if (memory.shown) return { show: false, memory };
  if (memory.lastShownAt !== undefined && now - memory.lastShownAt < DUP_NOTICE_COOLDOWN_MS) {
    return { show: false, memory };
  }
  return { show: true, memory: { shown: true, lastShownAt: now } };
}

/**
 * Reopening tabs is a decision to keep them, so a pile restored by Undo is
 * treated as announced: `shown` arms without a notice, and the next one waits
 * for a genuine drop below the threshold. The cooldown alone would only
 * postpone the re-announcement, not withdraw it.
 */
export function dupNoticeAfterReopen(memory: DupNoticeMemory): DupNoticeMemory {
  return memory.shown ? memory : { ...memory, shown: true };
}

export function dupNoticeText(dupCount: number): string {
  return `${dupCount} duplicate ${dupCount === 1 ? "tab" : "tabs"}`;
}

/** The frame is sized to its content by the page, and this is how it asks. */
export interface DupNoticeSizeMessage {
  source: "tabglutton-dup-notice";
  type: "size";
  width: number;
  height: number;
}

export interface DupNoticeDismissMessage {
  source: "tabglutton-dup-notice";
  type: "dismiss";
}

export type DupNoticeFrameMessage = DupNoticeSizeMessage | DupNoticeDismissMessage;

/**
 * The host content script's one message *into* the frame: the nonce that proves
 * to the background that this frame is the one it placed.
 *
 * It exists because `notice/dup-notice.html` is a `web_accessible_resource`
 * matched on every site, so any page may embed a second copy of the real notice
 * — genuine extension UI, which no frame-busting can refuse — position it under
 * a decoy button, and let a stray click drive Dedup. The nonce is the thing an
 * embedding page cannot produce.
 *
 * It travels by `postMessage` and deliberately **not** in the frame's URL: the
 * URL lands in the embedding page's DOM, where any script can read it, and the
 * notice is shown on whatever page is *active* — which may well be the page
 * trying this. The host runs in the isolated content-script world, so a nonce
 * handed over this way is never in the page's reach. A page may of course post
 * a nonce of its own invention; the background is what rejects it.
 */
export interface DupNoticeHostMessage {
  source: "tabglutton-dup-notice-host";
  type: "nonce";
  nonce: string;
}

export function isDupNoticeHostMessage(data: unknown): data is DupNoticeHostMessage {
  if (!data || typeof data !== "object") return false;
  const msg = data as Partial<DupNoticeHostMessage>;
  return (
    msg.source === "tabglutton-dup-notice-host" &&
    msg.type === "nonce" &&
    typeof msg.nonce === "string" &&
    msg.nonce.length > 0
  );
}

export function isDupNoticeFrameMessage(data: unknown): data is DupNoticeFrameMessage {
  if (!data || typeof data !== "object") return false;
  const msg = data as Partial<DupNoticeFrameMessage>;
  if (msg.source !== "tabglutton-dup-notice") return false;
  if (msg.type === "dismiss") return true;
  return (
    msg.type === "size" &&
    typeof (msg as DupNoticeSizeMessage).width === "number" &&
    typeof (msg as DupNoticeSizeMessage).height === "number"
  );
}
