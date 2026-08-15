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
}

export interface DupGroup<T extends DedupTab = Tab> {
  key: string;
  tabs: T[];
}

export function groupDuplicates<T extends DedupTab>(
  tabs: T[],
  normalizeOpts: NormalizeOpts,
): DupGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const tab of tabs) {
    const key = normalizeUrl(tab.url, normalizeOpts);
    if (!key) continue;
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
