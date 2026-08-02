// The webextension-polyfill global (`browser`) is supplied by the runtime, not
// imported here. Firefox provides `browser` natively; the Chrome build injects
// the polyfill ahead of this module in its bundle entry (see chromeBundleEntry
// in build.ts). Importing the bare "webextension-polyfill" specifier here would
// break the Firefox background, which tsc emits unbundled — the bare specifier
// is unresolvable in a Firefox module service worker and aborts registration.
import { BridgeClient, type BridgeStatus } from "./bridge-client.js";
import { BridgeMethodRunner } from "./bridge-methods.js";
import { getBrowserInfoOnce } from "./browser-info.js";
import {
  markdownForClip,
  OBSIDIAN_HANDOFF_GAP_MS,
  resolveClipRequest,
  type ClipPayload,
  type ObsidianClipRequest,
} from "./clip-format.js";
import { getFilePlatformOnce } from "./platform.js";
import { delay } from "./serialize.js";
import { pickRule } from "./site-rules.js";
import { groupDuplicates, pickKeeper, type Tab } from "./dedup.js";
import {
  defaults,
  loadSettings,
  normalizeOptsFrom,
  saveSettings,
  type Settings,
} from "./storage.js";
import { IS_CHROME } from "./target.js";

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
export type GetBridgeStatusMessage = { type: "get-bridge-status" };
export type IncomingMessage =
  | GetScopedTabsMessage
  | ClipSelectedTabsMessage
  | ClipCurrentResultMessage
  | CloseDuplicatesMessage
  | CloseTabsMessage
  | FocusTabMessage
  | ReopenTabsMessage
  | OpenCockpitMessage
  | GetBridgeStatusMessage;

export interface GetBridgeStatusResponse {
  status: BridgeStatus;
  port?: number;
}

/** Pushed to the options page on every transition, so it never has to poll. */
export interface BridgeStatusChangedMessage {
  type: "bridge-status-changed";
  status: BridgeStatus;
  port?: number;
}

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

export interface ClipProgressMessage {
  type: "clip-progress";
  completed: number;
  total: number;
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
// Only the connected/not-connected split reaches the badge, so that is all we
// mirror; `bridge.status` stays the source of truth for anyone who asks.
let bridgeConnected = false;
const pendingClips = new Map<
  string,
  {
    resolve: (result: ClipCurrentResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

// Agent bridge (docs/BRIDGE.md). The runner owns the tab/undo surface; everything
// that touches a page is handed down from here, so the bridge cannot reach any
// capability the popup does not already have.
const bridgeRunner = new BridgeMethodRunner({
  getSettings: () => settings,
  extract: (tabId) => clipTab(tabId, { wake: false }),
  load: ensureTabReady,
  openObsidianUrl,
  copyToClipboardViaTab,
});

const bridge = new BridgeClient({
  getSettings: () => settings,
  run: (method, params) => bridgeRunner.run(method, params),
  onStatusChange: (status, port) => {
    // Nobody may be listening — an options page that is closed rejects, and
    // that is the normal case, not an error.
    const msg: BridgeStatusChangedMessage = { type: "bridge-status-changed", status, port };
    void browser.runtime.sendMessage(msg).catch(() => {});
    // A failed dial cycles idle → connecting → idle every 30s. Repainting on
    // each would re-query and re-dedup every tab twice a minute to draw the
    // same pixels, so only an actual connect/disconnect gets through.
    const connected = status === "connected";
    if (connected === bridgeConnected) return;
    bridgeConnected = connected;
    void refreshBadge();
  },
});

function tabInScope(tab: Tab): boolean {
  if (!tab || !tab.url) return false;
  if (settings.scope === "current-window") return true;
  return tab.hidden === false || tab.hidden === undefined;
}

async function queryScopedTabs(): Promise<Tab[]> {
  // Chrome has no `hidden` filter, so always treat scope as current-window there.
  if (IS_CHROME || settings.scope === "current-window") {
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
    // The duplicate count is the badge's primary job. A live agent connection
    // only claims the badge when there is nothing to report, as a terracotta
    // dot — accent means "state indicator" in DESIGN.md, never decoration.
    if (dupCount > 0) {
      await browser.action.setBadgeText({ text: String(dupCount) });
      await browser.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } else if (bridgeConnected) {
      await browser.action.setBadgeText({ text: "•" });
      await browser.action.setBadgeBackgroundColor({ color: "#7a4a2c" });
    } else {
      await browser.action.setBadgeText({ text: "" });
    }
  } catch (err) {
    console.warn("[tabglutton] badge update failed", err);
  }
}

async function probeHeuristic(): Promise<void> {
  // Zen-specific heuristic; Chrome has no workspaces and no getBrowserInfo.
  if (IS_CHROME) return;
  try {
    const info = await getBrowserInfoOnce();
    const isZen = info?.name?.toLowerCase().includes("zen") ?? false;
    if (!isZen) {
      if (settings.heuristicWarning) {
        await saveSettings({ heuristicWarning: false });
        settings.heuristicWarning = false;
      }
      return;
    }
    const [allInWindow, visibleInWindow] = await Promise.all([
      browser.tabs.query({ currentWindow: true }),
      browser.tabs.query({ currentWindow: true, hidden: false }),
    ]);
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

// Firefox supports tabs.onUpdated event filters; Chrome throws
// "This event does not support filters" — and at top level that error aborts
// service-worker registration entirely. Both listeners below already guard on
// changeInfo.status, so on Chrome we register them unfiltered.
function onTabUpdated(listener: Parameters<typeof browser.tabs.onUpdated.addListener>[0]): void {
  if (IS_CHROME) {
    browser.tabs.onUpdated.addListener(listener);
  } else {
    browser.tabs.onUpdated.addListener(listener, { properties: ["status"] });
  }
}

/**
 * Trailing-edge coalesce for the tab-event listeners, which fire once *per tab*.
 * A bridge triage run closes a batch of ~180 in one call and `undo_close`
 * recreates them just as fast; without this each tab would kick off its own
 * `tabs.query` + full duplicate grouping to land on a single badge number.
 */
let badgeTimer: ReturnType<typeof setTimeout> | undefined;
function queueBadgeRefresh(): void {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = undefined;
    void refreshBadge();
  }, 250);
}

onTabUpdated((_tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    queueBadgeRefresh();
  }
});

browser.tabs.onRemoved.addListener(queueBadgeRefresh);

browser.tabs.onCreated.addListener(queueBadgeRefresh);

// storage.local has tenants that are not settings (the undo log today, more
// later). Match positively on what a setting *is*, so a new non-setting key
// cannot silently start triggering reloads and badge repaints. DEFAULTS is
// frozen, so this set is fixed for the module's lifetime.
const SETTING_KEYS = new Set(Object.keys(defaults()));

// The subset the duplicate-count badge is actually computed from. The bridge's
// own contribution to the badge arrives via onStatusChange, not through here.
const BADGE_SETTING_KEYS = ["stripFragment", "extraStripParams", "scope", "heuristicWarning"];

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (!Object.keys(changes).some((key) => SETTING_KEYS.has(key))) return;
  settings = await loadSettings();
  bridge.sync();
  // Repainting the badge means a tabs.query plus a full duplicate grouping —
  // ~1000 URL normalizations at this project's scale — so it runs only when a
  // badge input truly changed. Presence alone is not that: Firefox reports
  // every key a write names, and the options page saves the whole object, so a
  // bridge toggle would regroup every tab for a number that cannot move.
  const badgeAffected = BADGE_SETTING_KEYS.some((key) => {
    const change = changes[key];
    return (
      change !== undefined && JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue)
    );
  });
  if (badgeAffected) await refreshBadge();
});

const SAFE_FAVICON_SCHEMES = new Set([
  "http:",
  "https:",
  "data:",
  "moz-extension:",
  "chrome-extension:",
]);

function safeFavIconUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return SAFE_FAVICON_SCHEMES.has(new URL(raw).protocol) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function tabToPopupTab(t: Tab): PopupTab {
  return {
    id: t.id ?? -1,
    title: t.title,
    url: t.url,
    favIconUrl: safeFavIconUrl(t.favIconUrl),
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

// Auto Tab Discard (and Firefox's own unloader) puts inactive tabs into a
// discarded state with no live document — scripting.executeScript fails on
// those. Reload via tabs.reload(); tabs.update({ discarded: false }) is
// inconsistent across Firefox versions.
//
// The completion listener is attached before the tab is inspected rather than
// after. `tabs.get` is an IPC round trip, and a tab that reaches "complete"
// during it would otherwise fire into a listener that does not exist yet and
// then sit until the timeout — cheap when one clip pays it, expensive now that
// `tabs_load` runs this over a batch. Nothing is read back after the reload for
// the mirror-image reason: `tabs.reload` resolves before the navigation starts,
// so a status read there still reports the pre-reload "complete".
async function ensureTabReady(tabId: number, timeoutMs: number): Promise<void> {
  let cleanup = (): void => {};
  const settled = new Promise<void>((resolve, reject) => {
    const listener = (updatedTabId: number, changeInfo: { status?: string }): void => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== "complete") return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Tab did not finish loading within ${timeoutMs}ms`));
    }, timeoutMs);
    cleanup = (): void => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
    };
    onTabUpdated(listener);
  });

  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.discarded && tab.status === "complete") {
      // Cleared, so `settled` simply never resolves — nothing awaits it here.
      cleanup();
      return;
    }
    if (tab.discarded) await browser.tabs.reload(tabId);
  } catch (err) {
    cleanup();
    throw err;
  }
  await settled;
}

interface ClipTabOptions {
  /**
   * Reload a discarded tab before extracting. True for user-initiated clips;
   * the agent bridge passes false, because waking a tab on the agent's behalf is
   * its own opt-in act there — the `tabs_load` method, which the user has to
   * enable — and must never happen as a side effect of a read (see docs/BRIDGE.md).
   */
  wake: boolean;
}

async function clipTab(
  tabId?: number,
  { wake }: ClipTabOptions = { wake: true },
): Promise<ClipCurrentResponse> {
  const tab = await resolveTargetTab(tabId);
  if (!tab?.id) return { ok: false, error: "Tab not found." };
  if (!tab.url?.startsWith("http://") && !tab.url?.startsWith("https://")) {
    return { ok: false, error: "Only http and https pages can be clipped." };
  }

  if (wake) {
    try {
      await ensureTabReady(tab.id, 15000);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
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

// Runs inside the source tab's content-script world. With `clipboardWrite`
// permission, document.execCommand("copy") works without a user gesture there —
// unlike in the background page, where it requires page focus we can't get.
// Throws on failure so the caller (executeScript) rejects.
function copyInTab(textToCopy: string): void {
  const ta = document.createElement("textarea");
  ta.value = textToCopy;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("execCommand copy returned false");
}

async function copyToClipboardViaTab(tabId: number, text: string): Promise<boolean> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      func: copyInTab,
      args: [text],
    });
    return true;
  } catch (err) {
    console.warn("[tabglutton] copyToClipboardViaTab failed", err);
    return false;
  }
}

async function openObsidianUrl(url: string): Promise<void> {
  // Chrome can't remember an "always allow" for a browser-initiated obsidian://
  // navigation (a tabs.create straight to the protocol URL), so it would prompt
  // on every clip. Launch via an extension-origin redirect page instead: that
  // shares the one-time chrome-extension://<id> approval the user grants (e.g.
  // through the onboarding ping), so clips fire silently thereafter. Firefox
  // launches the protocol directly (dev pref / the user's registered handler).
  const launchUrl = IS_CHROME
    ? `${browser.runtime.getURL("redirect/obsidian-redirect.html")}#${encodeURIComponent(url)}`
    : url;
  const ephemeral = await browser.tabs.create({ url: launchUrl, active: false });
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

  // Phase 1: wake + extract every tab in parallel. clipTab is concurrency-safe
  // (per-tab onUpdated listener, unique requestId in pendingClips). The slow
  // step for discarded tabs is ensureTabReady's reload-and-wait, which is
  // overlapping I/O — running them in parallel turns N × 15s into ~max 15s.
  type ExtractOutcome = { kind: "ok"; res: ClipCurrentResponse } | { kind: "threw"; err: unknown };
  const extractResults = await Promise.all(
    tabIds.map(async (tabId): Promise<[number, ExtractOutcome]> => {
      try {
        return [tabId, { kind: "ok", res: await clipTab(tabId) }];
      } catch (err) {
        return [tabId, { kind: "threw", err }];
      }
    }),
  );
  const extractByTabId = new Map(extractResults);

  // Phase 2: dispatch to Obsidian serially in selection order. clipMode
  // defaults to "clipboard" (storage.ts), and the OS clipboard is global —
  // parallel dispatches would clobber each other. The 200ms inter-dispatch
  // delay also helps Obsidian's URI handler stay reliable.
  const total = tabIds.length;
  const broadcastProgress = (completed: number): void => {
    const msg: ClipProgressMessage = { type: "clip-progress", completed, total };
    browser.runtime.sendMessage(msg).catch(() => {});
  };
  broadcastProgress(0);
  let succeeded = 0;
  const failures: ClipFailure[] = [];
  for (const [i, tabId] of tabIds.entries()) {
    try {
      const outcome = extractByTabId.get(tabId);
      if (!outcome) continue;
      if (outcome.kind === "threw") {
        const m = metaOf(tabId);
        failures.push({
          tabId,
          title: m.title,
          url: m.url,
          reason: "extract-failed",
          detail: errorMessage(outcome.err),
        });
        console.warn("[tabglutton] clip threw for tab", tabId, outcome.err);
        continue;
      }
      const res = outcome.res;
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

      let req: ObsidianClipRequest;
      try {
        const rule = pickRule(res.payload.url);
        const content = markdownForClip(res.payload);
        req = await resolveClipRequest(
          res.payload,
          vault,
          content,
          rule,
          settings.clipMode,
          settings.clippingsBaseFolder,
          await getFilePlatformOnce(),
          async (text) => {
            const copied = await copyToClipboardViaTab(tabId, text);
            if (!copied) {
              console.warn(
                "[tabglutton] clipboard write failed for tab",
                tabId,
                "— falling back to legacy URI",
              );
            }
            return copied;
          },
        );
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
        await openObsidianUrl(req.url);
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

      await delay(OBSIDIAN_HANDOFF_GAP_MS);
      try {
        await browser.tabs.remove(tabId);
      } catch (err) {
        console.warn("[tabglutton] close failed for tab", tabId, err);
      }
      succeeded += 1;
    } finally {
      broadcastProgress(i + 1);
    }
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
    case "get-bridge-status": {
      const response: GetBridgeStatusResponse = {
        status: bridge.status,
        port: bridge.connectedPort,
      };
      return response;
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
  // Dial before the tab-heavy work below, not after. This is an event page: the
  // browser re-runs init on every wake, including the wakes the reconnect alarm
  // causes, so anything ahead of `start()` is paid again on every single
  // reconnect attempt. `probeHeuristic` costs two `tabs.query` calls and
  // `refreshBadge` a third plus a full duplicate-grouping pass — cheap on a
  // normal window, seconds on the thousand-tab backlogs the bridge exists for,
  // and every one of those seconds is time an agent is told no browser is
  // connected. `start()` only *initiates* the dial, so the handshake completes
  // while the badge work runs.
  await bridge.start();
  await probeHeuristic();
  await refreshBadge();
  console.log("[tabglutton] ready", loggableSettings(settings), "bridge:", bridge.status);
})();

/**
 * Settings minus the bridge token. That token is the whole of the bridge's
 * authentication — anything holding it can list, read, clip, and close every tab
 * — and this line runs on every wake of an event page, so leaving it in prints
 * the credential continuously into a console whose contents get pasted wholesale
 * into bug reports and agent sessions.
 */
function loggableSettings(current: Settings): Record<string, unknown> {
  return { ...current, bridgeToken: current.bridgeToken ? "<set>" : "" };
}
