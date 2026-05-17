import type { PopupTab } from "../src/background.js";
import { normalizeUrl } from "../src/normalize.js";
import { normalizeOptsFrom, type Settings } from "../src/storage.js";

export interface DomainGroup {
  host: string;
  tabs: PopupTab[];
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

export function visibleGroups(
  scopedTabs: PopupTab[],
  filter: string,
  stickyHostOrder?: readonly string[] | null,
): DomainGroup[] {
  const ts = tokens(filter);
  const byHost = new Map<string, PopupTab[]>();
  for (const tab of scopedTabs) {
    if (!tabMatches(tab, ts)) continue;
    const host = hostOf(tab.url);
    let bucket = byHost.get(host);
    if (!bucket) {
      bucket = [];
      byHost.set(host, bucket);
    }
    bucket.push(tab);
  }
  const groups: DomainGroup[] = [];
  for (const [host, tabs] of byHost) {
    tabs.sort((a, b) => (a.windowId ?? 0) - (b.windowId ?? 0) || a.index - b.index);
    groups.push({ host, tabs });
  }
  if (stickyHostOrder && stickyHostOrder.length) {
    const rank = new Map(stickyHostOrder.map((h, i) => [h, i] as const));
    groups.sort((a, b) => {
      const ra = rank.get(a.host);
      const rb = rank.get(b.host);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return b.tabs.length - a.tabs.length || a.host.localeCompare(b.host);
    });
  } else {
    groups.sort((a, b) => b.tabs.length - a.tabs.length || a.host.localeCompare(b.host));
  }
  return groups;
}

export function visibleTabIds(groups: DomainGroup[]): number[] {
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

export function computeDedupCount(scopedTabs: PopupTab[], settings: Settings | null): number {
  if (!settings) return 0;
  const opts = normalizeOptsFrom(settings);
  const counts = new Map<string, number>();
  for (const tab of scopedTabs) {
    const key = normalizeUrl(tab.url, opts);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let dups = 0;
  for (const n of counts.values()) {
    if (n > 1) dups += n - 1;
  }
  return dups;
}

export function selectedTabsInUiOrder(groups: DomainGroup[], selected: Set<number>): PopupTab[] {
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
