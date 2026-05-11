import { normalizeUrl, type NormalizeOpts } from "./normalize.js";

export type Tab = browser.tabs.Tab;

export interface DupGroup {
  key: string;
  tabs: Tab[];
}

export function groupDuplicates(tabs: Tab[], normalizeOpts: NormalizeOpts): DupGroup[] {
  const groups = new Map<string, Tab[]>();
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
  const dups: DupGroup[] = [];
  for (const [key, bucket] of groups) {
    if (bucket.length > 1) dups.push({ key, tabs: bucket });
  }
  return dups;
}

export function pickKeeper(tabs: Tab[]): Tab {
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
