import { markdownForClip, obsidianNewNoteUrl, type ClipPayload } from "./clip-format.js";
import { pickRule } from "./site-rules.js";
import { groupDuplicates, pickKeeper, type Tab } from "./dedup.js";
import {
  defaults,
  loadSettings,
  normalizeOptsFrom,
  saveSettings,
  type Settings,
} from "./storage.js";

export type GetScopedTabsMessage = { type: "get-scoped-tabs" };
export type ClipSelectedTabsMessage = {
  type: "clip-selected-tabs";
  tabIds: number[];
};
export type CloseDuplicatesMessage = { type: "close-duplicates" };
export type CloseTabsMessage = { type: "close-tabs"; tabIds: number[] };
export type FocusTabMessage = { type: "focus-tab"; tabId: number };
export type ReopenTabsMessage = {
  type: "reopen-tabs";
  records: ClosedTabRecord[];
};
export type OpenCockpitMessage = { type: "open-cockpit" };
export type IncomingMessage =
  | GetScopedTabsMessage
  | ClipSelectedTabsMessage
  | ClipCurrentResultMessage
  | CloseDuplicatesMessage
  | CloseTabsMessage
  | FocusTabMessage
  | ReopenTabsMessage
  | OpenCockpitMessage;

export type ClipFailureReason = "extract-failed" | "trigger-failed";

export interface ClipFailure {
  tabId: number;
  title: string;
  url: string;
  reason: ClipFailureReason;
  detail?: string;
}

export interface ClipSelectedTabsResponse {
  succeeded: number;
  failed: number;
  vaultMissing?: boolean;
  failures: ClipFailure[];
}

export interface PopupTab {
  id: number;
  title: string | undefined;
  url: string | undefined;
  favIconUrl: string | undefined;
  lastAccessed: number;
  active: boolean;
  pinned: boolean;
  windowId: number | undefined;
  index: number;
}

export interface ClosedTabRecord {
  url: string;
  title: string | undefined;
  pinned: boolean;
  windowId: number | undefined;
  index: number;
}

export interface GetScopedTabsResponse {
  tabs: PopupTab[];
  settings: Settings;
}

export interface CloseDuplicatesResponse {
  closed: number;
  restorable: ClosedTabRecord[];
}

export type { ClipPayload };

export interface ClipCurrentResponse {
  ok: boolean;
  payload?: ClipPayload;
  error?: string;
}

interface ClipCurrentResultMessage extends ClipCurrentResponse {
  type: "clip-current-result";
  requestId?: string;
}

let settings: Settings = defaults();
const pendingClips = new Map<
  string,
  {
    resolve: (result: ClipCurrentResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

function tabInScope(tab: Tab): boolean {
  if (!tab || !tab.url) return false;
  if (settings.scope === "current-window") return true;
  return tab.hidden === false || tab.hidden === undefined;
}

async function queryScopedTabs(): Promise<Tab[]> {
  if (settings.scope === "current-window") {
    return browser.tabs.query({ currentWindow: true });
  }
  return browser.tabs.query({ hidden: false });
}

async function refreshBadge(tabsHint?: Tab[]): Promise<void> {
  const tabs = tabsHint ?? (await queryScopedTabs());
  const opts = normalizeOptsFrom(settings);
  const groups = groupDuplicates(tabs, opts);
  const dupCount = groups.reduce((n, g) => n + (g.tabs.length - 1), 0);
  try {
    await browser.action.setBadgeText({
      text: dupCount > 0 ? String(dupCount) : "",
    });
    if (dupCount > 0) {
      await browser.action.setBadgeBackgroundColor({ color: "#ef4444" });
    }
  } catch (err) {
    console.warn("[tabglutton] badge update failed", err);
  }
}

async function probeHeuristic(): Promise<void> {
  try {
    const info = await browser.runtime.getBrowserInfo?.();
    const isZen = info?.name?.toLowerCase().includes("zen") ?? false;
    if (!isZen) {
      if (settings.heuristicWarning) {
        await saveSettings({ heuristicWarning: false });
        settings.heuristicWarning = false;
      }
      return;
    }
    const allInWindow = await browser.tabs.query({ currentWindow: true });
    const visibleInWindow = await browser.tabs.query({
      currentWindow: true,
      hidden: false,
    });
    const heuristicLooksBroken =
      allInWindow.length === visibleInWindow.length && allInWindow.length > 0;
    console.log(
      "[tabglutton] zen probe: total=%d visible=%d broken=%s",
      allInWindow.length,
      visibleInWindow.length,
      heuristicLooksBroken,
    );
    if (heuristicLooksBroken !== settings.heuristicWarning) {
      await saveSettings({ heuristicWarning: heuristicLooksBroken });
      settings.heuristicWarning = heuristicLooksBroken;
    }
  } catch (err) {
    console.warn("[tabglutton] probe failed", err);
  }
}

browser.tabs.onUpdated.addListener(
  (_tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
      void refreshBadge();
    }
  },
  { properties: ["status"] },
);

browser.tabs.onRemoved.addListener(() => {
  void refreshBadge();
});

browser.tabs.onCreated.addListener(() => {
  void refreshBadge();
});

browser.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== "local") return;
  settings = await loadSettings();
  await refreshBadge();
});

function tabToPopupTab(t: Tab): PopupTab {
  return {
    id: t.id ?? -1,
    title: t.title,
    url: t.url,
    favIconUrl: t.favIconUrl,
    lastAccessed: t.lastAccessed ?? 0,
    active: t.active,
    pinned: t.pinned,
    windowId: t.windowId,
    index: t.index,
  };
}

function tabToClosedRecord(t: Tab): ClosedTabRecord | null {
  if (!t.url) return null;
  return {
    url: t.url,
    title: t.title,
    pinned: t.pinned,
    windowId: t.windowId,
    index: t.index,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setClipRequestId(requestId: string): void {
  (window as Window & { __tabDedupClipRequestId?: string }).__tabDedupClipRequestId = requestId;
}

function waitForClipResult(requestId: string): Promise<ClipCurrentResponse> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingClips.delete(requestId);
      resolve({ ok: false, error: "Timed out while clipping the active tab." });
    }, 10000);
    pendingClips.set(requestId, { resolve, timeout });
  });
}

function finishClipResult(msg: ClipCurrentResultMessage): ClipCurrentResponse {
  const requestId = msg.requestId;
  if (!requestId) return { ok: false, error: "Missing clip request id." };
  const pending = pendingClips.get(requestId);
  if (!pending) return { ok: false, error: "Unknown clip request id." };
  pendingClips.delete(requestId);
  clearTimeout(pending.timeout);
  const result: ClipCurrentResponse = msg.ok
    ? { ok: true, payload: msg.payload }
    : { ok: false, error: msg.error ?? "Clip failed." };
  pending.resolve(result);
  return { ok: true };
}

async function resolveTargetTab(tabId?: number): Promise<Tab | null> {
  if (tabId !== undefined) {
    try {
      return await browser.tabs.get(tabId);
    } catch {
      return null;
    }
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function clipTab(tabId?: number): Promise<ClipCurrentResponse> {
  const tab = await resolveTargetTab(tabId);
  if (!tab?.id) return { ok: false, error: "Tab not found." };
  if (!tab.url?.startsWith("http://") && !tab.url?.startsWith("https://")) {
    return { ok: false, error: "Only http and https pages can be clipped." };
  }

  const requestId = crypto.randomUUID();
  const resultPromise = waitForClipResult(requestId);
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: setClipRequestId,
      args: [requestId],
    });
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/clip-current.js"],
    });
    return await resultPromise;
  } catch (err) {
    const pending = pendingClips.get(requestId);
    if (pending) {
      pendingClips.delete(requestId);
      clearTimeout(pending.timeout);
    }
    return { ok: false, error: errorMessage(err) };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function triggerObsidianUrl(url: string): Promise<void> {
  const ephemeral = await browser.tabs.create({ url, active: false });
  if (ephemeral.id !== undefined) {
    const ephemeralId = ephemeral.id;
    setTimeout(() => {
      void browser.tabs.remove(ephemeralId).catch(() => {});
    }, 500);
  }
}

async function resolveTabMeta(tabId: number): Promise<{ title: string; url: string }> {
  try {
    const t = await browser.tabs.get(tabId);
    return { title: t.title ?? "", url: t.url ?? "" };
  } catch {
    return { title: "", url: "" };
  }
}

async function clipSelectedTabs(tabIds: number[]): Promise<ClipSelectedTabsResponse> {
  const vault = settings.obsidianVault.trim();
  if (!vault) return { succeeded: 0, failed: 0, vaultMissing: true, failures: [] };

  const metaEntries = await Promise.all(
    tabIds.map(
      async (tabId): Promise<[number, { title: string; url: string }]> => [
        tabId,
        await resolveTabMeta(tabId),
      ],
    ),
  );
  const metaById = new Map(metaEntries);
  const metaOf = (tabId: number) => metaById.get(tabId) ?? { title: "", url: "" };

  let succeeded = 0;
  const failures: ClipFailure[] = [];
  for (const tabId of tabIds) {
    let res: ClipCurrentResponse;
    try {
      res = await clipTab(tabId);
    } catch (err) {
      const m = metaOf(tabId);
      failures.push({
        tabId,
        title: m.title,
        url: m.url,
        reason: "extract-failed",
        detail: errorMessage(err),
      });
      console.warn("[tabglutton] clip threw for tab", tabId, err);
      continue;
    }
    if (!res.ok || !res.payload) {
      const m = metaOf(tabId);
      failures.push({
        tabId,
        title: m.title,
        url: m.url,
        reason: "extract-failed",
        detail: res.error,
      });
      console.warn("[tabglutton] clip failed for tab", tabId, res.error);
      continue;
    }

    let url: string;
    try {
      const rule = pickRule(res.payload.url);
      const content = markdownForClip(res.payload);
      url = obsidianNewNoteUrl(res.payload, vault, content, rule);
    } catch (err) {
      const m = metaOf(tabId);
      failures.push({
        tabId,
        title: res.payload.title || m.title,
        url: res.payload.url || m.url,
        reason: "extract-failed",
        detail: errorMessage(err),
      });
      console.warn("[tabglutton] format failed for tab", tabId, err);
      continue;
    }

    try {
      await triggerObsidianUrl(url);
    } catch (err) {
      failures.push({
        tabId,
        title: res.payload.title,
        url: res.payload.url,
        reason: "trigger-failed",
        detail: errorMessage(err),
      });
      console.warn("[tabglutton] trigger failed for tab", tabId, err);
      continue;
    }

    await delay(200);
    try {
      await browser.tabs.remove(tabId);
    } catch (err) {
      console.warn("[tabglutton] close failed for tab", tabId, err);
    }
    succeeded += 1;
  }
  return { succeeded, failed: failures.length, failures };
}

browser.runtime.onMessage.addListener(async (rawMsg: unknown): Promise<unknown> => {
  if (!rawMsg || typeof rawMsg !== "object") return undefined;
  const msg = rawMsg as IncomingMessage;
  switch (msg.type) {
    case "clip-current-result":
      return finishClipResult(msg);
    case "get-scoped-tabs": {
      const tabs = (await queryScopedTabs()).filter(tabInScope);
      const response: GetScopedTabsResponse = {
        tabs: tabs
          .map(tabToPopupTab)
          .sort((a, b) => (a.windowId ?? 0) - (b.windowId ?? 0) || a.index - b.index),
        settings,
      };
      return response;
    }
    case "clip-selected-tabs":
      return clipSelectedTabs(Array.isArray(msg.tabIds) ? msg.tabIds : []);
    case "close-duplicates": {
      const tabs = await queryScopedTabs();
      const opts = normalizeOptsFrom(settings);
      const groups = groupDuplicates(tabs, opts);
      const restorable: ClosedTabRecord[] = [];
      const closeIds: number[] = [];
      for (const group of groups) {
        const keeper = pickKeeper(group.tabs);
        for (const t of group.tabs) {
          if (t.id === undefined || t.id === keeper.id) continue;
          closeIds.push(t.id);
          const rec = tabToClosedRecord(t);
          if (rec) restorable.push(rec);
        }
      }
      if (closeIds.length) {
        await browser.tabs.remove(closeIds);
      }
      const response: CloseDuplicatesResponse = {
        closed: closeIds.length,
        restorable,
      };
      return response;
    }
    case "close-tabs": {
      const ids = Array.isArray(msg.tabIds) ? msg.tabIds : [];
      if (ids.length) {
        await browser.tabs.remove(ids);
      }
      return { closed: ids.length };
    }
    case "focus-tab": {
      const tab = await browser.tabs.get(msg.tabId);
      if (tab.id !== undefined) {
        await browser.tabs.update(tab.id, { active: true });
      }
      if (tab.windowId !== undefined) {
        await browser.windows.update(tab.windowId, { focused: true });
      }
      return { ok: true };
    }
    case "reopen-tabs": {
      const records = Array.isArray(msg.records) ? msg.records : [];
      let restored = 0;
      for (const rec of records) {
        if (!rec || typeof rec.url !== "string") continue;
        try {
          await browser.tabs.create({
            url: rec.url,
            windowId: rec.windowId,
            index: rec.index,
            pinned: rec.pinned,
            active: false,
          });
          restored += 1;
        } catch (err) {
          console.warn("[tabglutton] reopen failed for", rec.url, err);
        }
      }
      await refreshBadge();
      return { restored };
    }
    case "open-cockpit": {
      await openCockpit();
      return { ok: true };
    }
  }
  return undefined;
});

const COCKPIT_URL = browser.runtime.getURL("popup/devour.html");

async function openCockpit(): Promise<void> {
  try {
    const existing = await browser.tabs.query({ url: COCKPIT_URL });
    const reusable = existing.find((t) => t.id !== undefined);
    if (reusable?.id !== undefined) {
      await browser.tabs.update(reusable.id, { active: true });
      if (reusable.windowId !== undefined) {
        await browser.windows.update(reusable.windowId, { focused: true });
      }
      return;
    }
    await browser.tabs.create({ url: COCKPIT_URL, active: true });
  } catch (err) {
    console.warn("[tabglutton] failed to open cockpit", err);
  }
}

browser.commands.onCommand.addListener((name) => {
  if (name === "open-cockpit") void openCockpit();
});

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const current = await loadSettings();
  if (current.onboardingComplete) return;
  try {
    await browser.tabs.create({
      url: browser.runtime.getURL("onboarding/onboarding.html"),
      active: true,
    });
  } catch (err) {
    console.warn("[tabglutton] failed to open onboarding tab", err);
  }
});

void (async function init() {
  settings = await loadSettings();
  await probeHeuristic();
  await refreshBadge();
  console.log("[tabglutton] ready", settings);
})();
