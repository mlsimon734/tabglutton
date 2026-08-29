import type { ClipFailureReason, ClipSelectedTabsResponse, PopupTab } from "../src/background.js";
import { clipMarkFor, type ClipMemoryEntry, type ClipTarget } from "../src/clip-memory.js";
import { groupDuplicates, pickKeeper } from "../src/dedup.js";
import { normalizeOptsFrom, type Settings } from "../src/storage.js";

/**
 * A duplicate set (several tabs sharing one canonical URL) or a domain bucket.
 * Duplicates are their own groups and are *removed* from the domain buckets, so
 * every tab still renders exactly once — which is what lets selection, the
 * keyboard queue, and every bulk action keep working off the group list
 * unchanged. They sort ahead of everything else because they are the cheapest
 * decision on the list: nothing is lost by closing a copy of a tab you kept.
 */
export type TabGroupKind = "duplicate" | "domain";

export interface TabGroup {
  kind: TabGroupKind;
  /** Identity for sticky ordering: `dup:<canonical url>` or `host:<host>`. */
  key: string;
  /** Header text — the shared canonical URL for a duplicate set, else the host. */
  label: string;
  host: string;
  tabs: PopupTab[];
  /** The copy Dedup keeps, first in `tabs`. Null on domain groups. */
  keeperId: number | null;
}

export function hostOf(url: string | undefined): string {
  if (!url) return "(no url)";
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.hostname.replace(/^www\./, "");
    }
    return u.protocol.replace(/:$/, "");
  } catch {
    return "(invalid url)";
  }
}

export function hostInitial(host: string): string {
  const cleaned = host.replace(/^[^a-z0-9]+/i, "");
  return (cleaned[0] ?? "·").toUpperCase();
}

export function tokens(s: string): string[] {
  return s.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

export function matchTokens(haystack: string, ts: string[]): boolean {
  if (ts.length === 0) return true;
  const lower = haystack.toLowerCase();
  return ts.every((t) => lower.includes(t));
}

export function tabMatches(tab: PopupTab, ts: string[]): boolean {
  if (ts.length === 0) return true;
  return matchTokens(`${tab.url ?? ""}\n${tab.title ?? ""}`, ts);
}

function byPosition(a: PopupTab, b: PopupTab): number {
  return (a.windowId ?? 0) - (b.windowId ?? 0) || a.index - b.index;
}

/**
 * Sort one section. Groups the user has already seen hold their slot (that is
 * what `rank` carries), so selecting or closing inside a group cannot reshuffle
 * the list under the cursor; everything new falls in by size.
 */
function sortSection(groups: TabGroup[], rank: Map<string, number> | null): void {
  groups.sort((a, b) => {
    if (rank) {
      const ra = rank.get(a.key);
      const rb = rank.get(b.key);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
    }
    return b.tabs.length - a.tabs.length || a.label.localeCompare(b.label);
  });
}

/**
 * The duplicate sets among `tabs`, keeper first in each. Keeper selection is
 * `pickKeeper` itself, not a copy of its rule: the pill this puts on a row is a
 * claim about what the Dedup button will do, and it has to stay true.
 */
export function duplicateGroups(tabs: PopupTab[], settings: Settings | null): TabGroup[] {
  if (!settings) return [];
  return groupDuplicates(tabs, normalizeOptsFrom(settings)).map((set) => {
    const keeper = pickKeeper(set.tabs);
    const extras = set.tabs.filter((t) => t.id !== keeper.id).sort(byPosition);
    return {
      kind: "duplicate" as const,
      key: `dup:${set.key}`,
      label: set.key,
      host: hostOf(keeper.url),
      tabs: [keeper, ...extras],
      keeperId: keeper.id,
    };
  });
}

/** The copies Dedup would close — every tab in a duplicate set but its keeper. */
export function extraTabIds(groups: TabGroup[]): number[] {
  const ids: number[] = [];
  for (const g of groups) {
    if (g.kind !== "duplicate") continue;
    for (const t of g.tabs) {
      if (t.id !== g.keeperId) ids.push(t.id);
    }
  }
  return ids;
}

/**
 * Which side of the clip memory the list is showing. `unclipped` is the second
 * pass over a backlog — everything already filed drops out of the way — and
 * `clipped` is the other half of the same question, the tabs that can go.
 */
export type ClipFilter = "all" | "clipped" | "unclipped";

export function clipFilterMatches(tab: PopupTab, filter: ClipFilter): boolean {
  if (filter === "all") return true;
  return filter === "clipped" ? tab.clipped !== undefined : tab.clipped === undefined;
}

function clipTargetLabel(destination: ClipTarget): string {
  switch (destination) {
    case "obsidian":
      return "Obsidian";
    case "file":
      return "a file in the download folder";
    case "zotero":
      return "Zotero";
  }
}

/**
 * The pill's text. "Clipped" is the whole claim — never "in your vault", which
 * the extension cannot know: a refused `obsidian://` launch looks exactly like a
 * taken one from in here. The tick separates the two states without asserting
 * anything more, and `clipMarkTitle` spells out what it means.
 */
export function clipMarkLabel(entry: ClipMemoryEntry): string {
  return clipMarkFor(entry) === "verified" ? "clipped ✓" : "clipped";
}

/**
 * Built once rather than per row: a cockpit list runs to hundreds of rows, and
 * `toLocaleDateString` with an options bag rebuilds the formatter on each call.
 * The year is always shown — a conditional one would save four characters and
 * cost a second formatter.
 */
let dateFormat: Intl.DateTimeFormat | null = null;
function formatDay(at: number): string {
  dateFormat ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return dateFormat.format(new Date(at));
}

/**
 * The hover text behind the pill, where the honest version has room to live.
 *
 * The two facts are reported separately on purpose. `at` and `destination`
 * describe the **most recent** clip, while `verifiedAt` is when a note was last
 * actually seen — and those can be different clips to different destinations.
 * Folding them into one sentence let a sticky `verified` claim a disk sighting
 * on the day of a handoff nothing observed.
 */
export function clipMarkTitle(entry: ClipMemoryEntry): string {
  const clipped = `Clipped to ${clipTargetLabel(entry.destination)} on ${formatDay(entry.at)}.`;
  const evidence =
    entry.verifiedAt === undefined
      ? "The handoff was launched — nothing could confirm the note reached disk."
      : entry.verifiedAt === entry.at
        ? "The note was seen on disk then."
        : `A note for this page was seen on disk on ${formatDay(entry.verifiedAt)}.`;
  // One sentence reached by every branch rather than a copy per branch. It is
  // the disclaimer that keeps even a verified mark from reading as a claim
  // about now, so a reworded copy on one path is a claim quietly overstated.
  const since = "It may have been moved or deleted since.";
  return `${clipped} ${evidence} ${since}`;
}

export function visibleGroups(
  scopedTabs: PopupTab[],
  filter: string,
  settings: Settings | null,
  stickyOrder?: readonly string[] | null,
  clipFilter: ClipFilter = "all",
): TabGroup[] {
  const ts = tokens(filter);
  // Both filters answer the same question — is this row worth looking at — so
  // they narrow the same set, and duplicate sets go on being found across the
  // whole scope and shown whole. A clip filter that split a set would pin `keep`
  // on a copy Dedup is about to close, exactly as a text filter would.
  const matching = new Set(
    scopedTabs
      .filter((tab) => tabMatches(tab, ts) && clipFilterMatches(tab, clipFilter))
      .map((t) => t.id),
  );

  // Duplicate sets are found across the whole scope and shown *whole* as soon as
  // one copy matches the filter. Detecting them among the matching tabs instead
  // would let a filter split a set and pin `keep` on a copy Dedup is about to
  // close — the button has never been filtered, and the pill is a claim about it.
  const dups = duplicateGroups(scopedTabs, settings).filter((g) =>
    g.tabs.some((t) => matching.has(t.id)),
  );
  const claimed = new Set<number>();
  for (const g of dups) {
    for (const t of g.tabs) claimed.add(t.id);
  }

  const byHost = new Map<string, PopupTab[]>();
  for (const tab of scopedTabs) {
    if (!matching.has(tab.id) || claimed.has(tab.id)) continue;
    const host = hostOf(tab.url);
    let bucket = byHost.get(host);
    if (!bucket) {
      bucket = [];
      byHost.set(host, bucket);
    }
    bucket.push(tab);
  }
  const domains: TabGroup[] = [];
  for (const [host, tabs] of byHost) {
    tabs.sort(byPosition);
    domains.push({ kind: "domain", key: `host:${host}`, label: host, host, tabs, keeperId: null });
  }

  const rank =
    stickyOrder && stickyOrder.length ? new Map(stickyOrder.map((k, i) => [k, i] as const)) : null;
  sortSection(dups, rank);
  sortSection(domains, rank);
  return [...dups, ...domains];
}

export function visibleTabIds(groups: TabGroup[]): number[] {
  const ids: number[] = [];
  for (const g of groups) {
    for (const t of g.tabs) ids.push(t.id);
  }
  return ids;
}

export function escapeMarkdownText(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

export function markdownForTabs(tabs: PopupTab[]): string {
  return tabs
    .filter((tab) => tab.url)
    .map((tab) => {
      const url = tab.url!;
      const title = escapeMarkdownText(tab.title?.trim() || url);
      return `- [${title}](${url})`;
    })
    .join("\n");
}

/**
 * What the Dedup button would close, over the whole scope — deliberately not
 * filtered, because the button is not either.
 */
export function computeDedupCount(scopedTabs: PopupTab[], settings: Settings | null): number {
  if (!settings) return 0;
  return groupDuplicates(scopedTabs, normalizeOptsFrom(settings)).reduce(
    (n, g) => n + g.tabs.length - 1,
    0,
  );
}

/** Both popups render the same failure vocabulary; keep them from drifting. */
export function reasonLabel(reason: ClipFailureReason): string {
  switch (reason) {
    case "extract-failed":
      return "extract failed";
    case "thin-content":
      return "too little content";
    case "trigger-failed":
      return "open failed";
    case "vault-missing":
      return "vault missing";
    case "zotero-failed":
      return "Zotero failed";
    case "download-failed":
      return "file write failed";
    case "close-failed":
      return "close failed";
    case "never-devour":
      return "kept by rule";
  }
}

/**
 * The pill a rule-driven disposition puts on a tab row, in both popups — the
 * rule has to be visible *before* Devour runs, or its effect reads as the tool
 * acting on its own. `null` for plain subfolder rules: where a note files is
 * the inspector's job, and a pill per GitHub tab would restate the group
 * header down every row.
 */
export function ruleMark(disposition: "never-devour" | "auto-close" | "zotero"): {
  label: string;
  title: string;
} {
  switch (disposition) {
    case "never-devour":
      return {
        label: "no devour",
        title: "A site rule keeps this site out of Devour — the tab stays open.",
      };
    case "auto-close":
      return {
        label: "auto-close",
        title: "A site rule closes this tab without saving when it is devoured.",
      };
    case "zotero":
      return {
        label: "→ Zotero",
        title: "A site rule sends this site to Zotero instead of a note.",
      };
  }
}

/**
 * "Saved 3 to Zotero, 1 to Obsidian". A destination is named only when it
 * actually took something, and Obsidian alone is left unnamed because it is
 * the default — so the common single-destination run stays short. Rule-driven
 * outcomes are named apart from failures: a tab a rule kept or closed went
 * exactly where the user's own rule sent it.
 */
export function clipSummary(res: ClipSelectedTabsResponse): string {
  const named: string[] = [];
  if (res.zoteroSaved) named.push(`${res.zoteroSaved} to Zotero`);
  if (res.fileSaved) named.push(`${res.fileSaved} to files`);
  if (res.obsidianSaved) named.push(`${res.obsidianSaved} to Obsidian`);
  const obsidianOnly = named.length === 1 && res.obsidianSaved > 0;
  const saved =
    named.length === 0 ? "0" : obsidianOnly ? String(res.obsidianSaved) : named.join(", ");
  const kept = res.failures.filter((f) => f.reason === "never-devour").length;
  const failed = res.failed - kept;
  let out = `Saved ${saved}`;
  if (res.ruleClosed) out += `, closed ${res.ruleClosed} by rule`;
  if (kept) out += `, ${kept} kept by rule`;
  if (failed) out += `, ${failed} failed`;
  return out;
}

export function selectedTabsInUiOrder(groups: TabGroup[], selected: Set<number>): PopupTab[] {
  const out: PopupTab[] = [];
  for (const g of groups) {
    for (const t of g.tabs) {
      if (selected.has(t.id)) out.push(t);
    }
  }
  return out;
}

export async function sendMessage<T>(msg: unknown): Promise<T | undefined> {
  try {
    return (await browser.runtime.sendMessage(msg)) as T | undefined;
  } catch (err) {
    console.warn("[tabglutton] sendMessage failed", msg, err);
    return undefined;
  }
}

/**
 * Publish the floating chrome stacks' heights onto `root` as `--chrome-top` /
 * `--chrome-bottom`, so the scroll region can pad itself clear of bars it
 * scrolls underneath. Their heights are not knowable from CSS: the warning
 * banner and the Devour-failures panel appear and disappear inside the stacks,
 * and a hard-coded inset would either clip the first row or leave a gap. The
 * observer is never removed — both surfaces live exactly as long as their page.
 */
export function trackChromeHeights(
  root: HTMLElement | null,
  top: HTMLElement | null,
  bottom: HTMLElement | null,
): void {
  if (!root) return;
  const publish = (): void => {
    if (top) root.style.setProperty("--chrome-top", `${Math.round(top.offsetHeight)}px`);
    if (bottom) root.style.setProperty("--chrome-bottom", `${Math.round(bottom.offsetHeight)}px`);
  };
  publish();
  const observer = new ResizeObserver(publish);
  if (top) observer.observe(top);
  if (bottom) observer.observe(bottom);
}

/**
 * Toggle `chrome-lifted` on `root` from whether anything is scrolled underneath
 * the floating chrome. The material is absent at rest — at the top of the list
 * the queue's padding means there is genuinely nothing behind the header, and a
 * bar tinted over nothing is the vibrant-toolbar look this is trying not to be.
 * Two scrollers are passed because the cockpit moves its scroll from `.queue`
 * out to `.cockpit-main` below 980px; whichever is live answers.
 */
export function trackScrollLift(root: HTMLElement, scrollers: (HTMLElement | null)[]): void {
  const live = scrollers.filter((el): el is HTMLElement => el !== null);
  if (!live.length) return;
  let frame = 0;
  const update = (): void => {
    frame = 0;
    root.classList.toggle(
      "chrome-lifted",
      live.some((el) => el.scrollTop > 8),
    );
  };
  const onScroll = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(update);
  };
  for (const el of live) el.addEventListener("scroll", onScroll, { passive: true });
  update();
}

/* ---------- scroll rail ---------- */

/**
 * Geometry of the scroll thumb, given the band it travels in.
 *
 * Pure so the arithmetic is testable; `mountScrollRail` supplies the live
 * numbers. `null` means there is nothing to scroll and the rail should be
 * absent rather than showing a full-length thumb, which reads as a stuck one.
 */
export interface RailMetrics {
  /** Height of the band the thumb travels in, in px — not the scrollport's. */
  track: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface RailThumb {
  height: number;
  /** Distance from the top of the track, in px. */
  offset: number;
}

/**
 * Below this a thumb on a long list becomes a dot too small to grab. Trading
 * proportionality for a usable target is what every native scrollbar does.
 */
export const RAIL_MIN_THUMB = 28;

export function railThumb(m: RailMetrics): RailThumb | null {
  const range = m.scrollHeight - m.clientHeight;
  if (range <= 1 || m.track <= 0) return null;
  const proportional = Math.round((m.track * m.clientHeight) / m.scrollHeight);
  const height = Math.min(m.track, Math.max(RAIL_MIN_THUMB, proportional));
  const travel = m.track - height;
  const progress = Math.min(1, Math.max(0, m.scrollTop / range));
  return { height, offset: Math.round(travel * progress) };
}

/**
 * The `scrollTop` a thumb of `thumbHeight` dragged to `offset` px down the
 * track corresponds to. The inverse of {@link railThumb}, and not derivable
 * from it: the clamp to `RAIL_MIN_THUMB` makes the mapping non-proportional,
 * so a drag has to divide by the thumb's real travel rather than by the track.
 */
/**
 * A wheel event's travel in pixels.
 *
 * `deltaY` is only in pixels when `deltaMode` says so — Gecko reports lines for
 * a real mouse wheel — so a handler that forwards the raw number scrolls a
 * couple of pixels per notch there and feels broken.
 */
export function wheelPixels(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_HEIGHT;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

/** Gecko's own default for a wheel line when it has no better answer. */
export const WHEEL_LINE_HEIGHT = 16;

export function railScrollTop(m: RailMetrics, thumbHeight: number, offset: number): number {
  const travel = m.track - thumbHeight;
  const range = m.scrollHeight - m.clientHeight;
  if (travel <= 0 || range <= 0) return 0;
  return (Math.min(travel, Math.max(0, offset)) / travel) * range;
}

/**
 * Draw the list's scroll affordance over the band between the floating chrome
 * stacks, instead of over the whole window.
 *
 * The popup's list and the cockpit's queue are full-viewport-height scroll
 * containers that pad themselves clear of the fixed chrome, so rows pass *under*
 * the glass — that passage is the only thing the material is describing. A
 * native scrollbar always spans its scrollport, so it ran from the top of the
 * window to the bottom, level with bars the list never reaches; in full screen,
 * with no browser chrome above it, that is unmissable ([#67]).
 *
 * Neither engine can inset a native track — Blink takes a margin on
 * `::-webkit-scrollbar-track`, Gecko's entire vocabulary is `scrollbar-width`
 * and `scrollbar-color` — so the native bar is hidden on both (`.u-rail-host`)
 * and the thumb is drawn here. The rail is **decorative**: the scroller stays
 * natively scrollable, so the wheel, the keyboard, and `scroll-padding-block`
 * are untouched, and it is `aria-hidden` because it duplicates no state a
 * screen reader is missing. It only ever reads and sets `scrollTop`, and the
 * track is `pointer-events: none` so the strip it lies over keeps scrolling on
 * a wheel the way the native bar did.
 *
 * `scrollers` takes the same pair `trackScrollLift` does, for the same reason:
 * the cockpit moves its scroll from `.queue` out to `.cockpit-main` below
 * 980px, so which element is live is a question of layout, re-asked on every
 * draw rather than answered once at mount.
 */
export function mountScrollRail(rail: HTMLElement | null, scrollers: (HTMLElement | null)[]): void {
  if (!rail) return;
  const thumb = rail.querySelector<HTMLElement>(".scroll-rail-thumb");
  const live = scrollers.filter((el): el is HTMLElement => el !== null);
  if (!thumb || !live.length) return;

  const active = (): HTMLElement | null =>
    live.find((el) => el.scrollHeight - el.clientHeight > 1) ?? null;

  const metrics = (el: HTMLElement): RailMetrics => ({
    track: rail.clientHeight,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
  });

  let frame = 0;
  const draw = (): void => {
    frame = 0;
    const el = active();
    if (!el) {
      rail.hidden = true;
      return;
    }
    // Unhidden *before* the track is measured, not after: `hidden` is
    // `display: none`, whose `clientHeight` is 0, which `railThumb` reads as
    // nothing to scroll — so a rail that starts hidden could never show
    // itself again. Re-hiding below happens in the same frame, so nothing
    // paints in between.
    rail.hidden = false;
    const geometry = railThumb(metrics(el));
    if (!geometry) {
      rail.hidden = true;
      return;
    }
    // Hung off the scroller's *content* edge, not the window's and not its
    // border box: the queue is a centred measure on a wide display, so the
    // window edge can be several hundred px away from the list, and the two
    // scrollers carry very different padding — matching the border box put the
    // rail flush against the frame in the narrow layout while every other
    // element held the `--edge` inset. CSS pulls it back out into its gutter.
    const box = el.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(el).paddingRight) || 0;
    rail.style.right = `${Math.max(0, Math.round(window.innerWidth - box.right + padding))}px`;
    thumb.style.height = `${geometry.height}px`;
    thumb.style.transform = `translateY(${geometry.offset}px)`;
  };
  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(draw);
  };

  for (const el of live) {
    el.addEventListener("scroll", schedule, { passive: true });
    // A re-render replaces the rows without scrolling or resizing anything, so
    // neither listener above would fire and the thumb would keep the length of
    // the list it was drawn for. Filtering is exactly that.
    new MutationObserver(schedule).observe(el, { childList: true, subtree: true });
    new ResizeObserver(schedule).observe(el);
  }
  // The chrome stacks change height when the warning banner or the failures
  // panel appears, and the rail is inset off their measured heights.
  new ResizeObserver(schedule).observe(rail);
  window.addEventListener("resize", schedule);

  thumb.addEventListener("pointerdown", (ev: PointerEvent) => {
    const el = active();
    if (!el) return;
    ev.preventDefault();
    // Only where the drag *started* is snapshotted. The geometry it maps
    // through is re-read every move, because a Devour run re-renders the rows
    // and grows the failures panel while the pointer is down — that changes
    // `scrollHeight` and, through `--chrome-bottom`, the track itself. Mapping
    // against stale numbers while `draw` repaints from live ones is the thumb
    // visibly sliding away from the cursor.
    const startY = ev.clientY;
    const startOffset = railThumb(metrics(el))?.offset ?? 0;
    const stop = new AbortController();
    thumb.setPointerCapture(ev.pointerId);
    rail.classList.add("dragging");
    const end = (): void => {
      stop.abort();
      rail.classList.remove("dragging");
    };
    thumb.addEventListener(
      "pointermove",
      (move: PointerEvent) => {
        el.scrollTop = railScrollTop(
          metrics(el),
          thumb.offsetHeight,
          startOffset + (move.clientY - startY),
        );
      },
      { signal: stop.signal },
    );
    // One signal for all three: `pointerup` and `pointercancel` are mutually
    // exclusive, so registering them `once` each leaves the loser attached for
    // the life of the page, one closure per drag.
    thumb.addEventListener("pointerup", end, { signal: stop.signal });
    thumb.addEventListener("pointercancel", end, { signal: stop.signal });
  });

  // The thumb has to stay pointer-interactive to be draggable, which makes it
  // the one part of the rail that can still swallow a wheel — measured at
  // exactly that: 600px of travel over a row and over the bare track, zero over
  // the thumb. The native bar this replaces scrolled its element on a wheel, so
  // the event is forwarded rather than the affordance surrendered. Bound on the
  // rail, which the thumb bubbles to.
  rail.addEventListener(
    "wheel",
    (ev: WheelEvent) => {
      const el = active();
      if (!el) return;
      ev.preventDefault();
      el.scrollTop += wheelPixels(ev.deltaY, ev.deltaMode, el.clientHeight);
    },
    { passive: false },
  );

  draw();
}

export function prettifyShortcut(raw: string): string {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return raw
    .split("+")
    .map((part) => {
      const key = part.trim();
      if (!isMac) return key;
      switch (key) {
        case "Command":
        case "MacCtrl":
          return "⌘";
        case "Ctrl":
          return "⌃";
        case "Alt":
        case "Option":
          return "⌥";
        case "Shift":
          return "⇧";
        default:
          return key.length === 1 ? key.toUpperCase() : key;
      }
    })
    .join(isMac ? "" : "+");
}
