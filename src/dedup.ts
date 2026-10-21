import { normalizeUrl, type NormalizeOpts } from "./normalize.js";

export type Tab = browser.tabs.Tab;

/**
 * The only fields duplicate grouping and keeper selection read. Both
 * `browser.tabs.Tab` and the popup's own `PopupTab` satisfy it, so the two
 * surfaces answer "which copy survives" from this module rather than from a
 * second implementation that can drift from what Dedup actually closes.
 */
export interface DedupTab {
  id?: number;
  url?: string;
  lastAccessed?: number;
  active?: boolean;
  pinned?: boolean;
  /** Position in its window. Read only when windows are synced. */
  index: number;
}

/** What grouping reads of the synced windows' tabs: an address at a position. */
export type SyncedTab = Pick<DedupTab, "url" | "index">;

export interface DupGroup<T extends DedupTab = Tab> {
  key: string;
  tabs: T[];
}

/**
 * Only web pages can be duplicates. Zen's window sync shows many pages' copies
 * in another window as discarded `about:blank` tabs, and closing that copy
 * closes the page; grouping those stand-ins closed every synced page that had
 * no duplicate at all (#117).
 */
function isWebUrl(url: string | undefined): boolean {
  return url !== undefined && (url.startsWith("https://") || url.startsWith("http://"));
}

function webKey(url: string | undefined, opts: NormalizeOpts): string | null {
  return isWebUrl(url) ? normalizeUrl(url, opts) : null;
}

/** One candidate for a duplicate set: a page, and the tab that stands for it. */
interface Page<T> {
  key: string;
  tab: T;
}

function tabPages<T extends DedupTab>(tabs: T[], opts: NormalizeOpts): Page<T>[] {
  const pages: Page<T>[] = [];
  for (const tab of tabs) {
    const key = webKey(tab.url, opts);
    if (key) pages.push({ key, tab });
  }
  return pages;
}

/**
 * Zen's window sync (on by default since Zen 1.18) shows every tab of a space
 * in every window. Each window's copy has its own tab id, closing any copy
 * closes the page in every window, and nothing the extension can read names the
 * page a copy belongs to (#117). What the copies share is their position: Zen
 * replays every open, move, pin and group into each window, so a page sits at
 * the same index everywhere. Measured on Zen 1.23.3b across fresh, discarded,
 * moved, selected, reloaded, navigated, space-switched and session-restored
 * windows; the URL, title and last-access time each disagreed somewhere.
 *
 * So the web tabs at one index are one page, standing in as the copy used most
 * recently. A copy can still report the address its page has since left (Zen
 * never updates a background copy's URL), and closing that copy would close
 * whatever the page shows now; a page whose copies disagree is left out. Every
 * mistaken pairing (an unsynced window, windows on different spaces) can only
 * hide a duplicate, never close a page that has none.
 */
function syncedPages<T extends DedupTab>(
  tabs: T[],
  syncedWindows: readonly SyncedTab[],
  opts: NormalizeOpts,
): Page<T>[] {
  const keysAt = new Map<number, Set<string>>();
  const note = (index: number, key: string): void => {
    let keys = keysAt.get(index);
    if (!keys) keysAt.set(index, (keys = new Set()));
    keys.add(key);
  };
  for (const tab of syncedWindows) {
    const key = webKey(tab.url, opts);
    if (key) note(tab.index, key);
  }
  const copiesAt = new Map<number, T[]>();
  for (const tab of tabs) {
    const key = webKey(tab.url, opts);
    if (!key) continue;
    note(tab.index, key);
    let copies = copiesAt.get(tab.index);
    if (!copies) copiesAt.set(tab.index, (copies = []));
    copies.push(tab);
  }
  const pages: Page<T>[] = [];
  for (const [index, copies] of copiesAt) {
    const keys = [...keysAt.get(index)!];
    if (keys.length === 1) pages.push({ key: keys[0]!, tab: pickKeeper(copies) });
  }
  return pages;
}

/**
 * Duplicate sets among `tabs`, one tab per page, so a set's length less one is
 * the number of pages Dedup closes. Pass `syncedWindows` (every window's tabs)
 * when the windows may be Zen's synced copies of each other; see `syncedPages`.
 */
export function groupDuplicates<T extends DedupTab>(
  tabs: T[],
  normalizeOpts: NormalizeOpts,
  syncedWindows?: readonly SyncedTab[],
): DupGroup<T>[] {
  const pages = syncedWindows
    ? syncedPages(tabs, syncedWindows, normalizeOpts)
    : tabPages(tabs, normalizeOpts);
  const groups = new Map<string, T[]>();
  for (const { key, tab } of pages) {
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(tab);
  }
  const dups: DupGroup<T>[] = [];
  for (const [key, bucket] of groups) {
    if (bucket.length > 1) dups.push({ key, tabs: bucket });
  }
  return dups;
}

export function pickKeeper<T extends DedupTab>(tabs: T[]): T {
  let best = tabs[0]!;
  for (const t of tabs) {
    const a = t.lastAccessed ?? 0;
    const b = best.lastAccessed ?? 0;
    if (a > b) best = t;
    else if (a === b && t.active && !best.active) best = t;
    else if (a === b && t.pinned && !best.pinned) best = t;
  }
  return best;
}
