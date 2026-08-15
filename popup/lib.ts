import type { ClipFailureReason, ClipSelectedTabsResponse, PopupTab } from "../src/background.js";
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

export function visibleGroups(
  scopedTabs: PopupTab[],
  filter: string,
  settings: Settings | null,
  stickyOrder?: readonly string[] | null,
): TabGroup[] {
  const ts = tokens(filter);
  const matching = new Set(scopedTabs.filter((tab) => tabMatches(tab, ts)).map((t) => t.id));

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
    case "trigger-failed":
      return "open failed";
    case "vault-missing":
      return "vault missing";
    case "zotero-failed":
      return "Zotero failed";
    case "download-failed":
      return "file write failed";
  }
}

/**
 * "Saved 3 to Zotero, 1 to Obsidian". A destination is named only when it
 * actually took something, and Obsidian alone is left unnamed because it is
 * the default — so the common single-destination run stays short.
 */
export function clipSummary(res: ClipSelectedTabsResponse): string {
  const named: string[] = [];
  if (res.zoteroSaved) named.push(`${res.zoteroSaved} to Zotero`);
  if (res.fileSaved) named.push(`${res.fileSaved} to files`);
  if (res.obsidianSaved) named.push(`${res.obsidianSaved} to Obsidian`);
  const obsidianOnly = named.length === 1 && res.obsidianSaved > 0;
  const saved =
    named.length === 0 ? "0" : obsidianOnly ? String(res.obsidianSaved) : named.join(", ");
  return res.failed === 0 ? `Saved ${saved}` : `Saved ${saved}, ${res.failed} failed`;
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
