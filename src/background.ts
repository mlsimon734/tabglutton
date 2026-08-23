// The webextension-polyfill global (`browser`) is supplied by the runtime, not
// imported here. Firefox provides `browser` natively; the Chrome build injects
// the polyfill ahead of this module in its bundle entry (see chromeBundleEntry
// in build.ts). Importing the bare "webextension-polyfill" specifier here would
// break the Firefox background, which tsc emits unbundled — the bare specifier
// is unresolvable in a Firefox module service worker and aborts registration.
import { BridgeClient, type BridgeStatus } from "./bridge-client.js";
import { BridgeMethodRunner, isHttpUrl } from "./bridge-methods.js";
import type { ClipMark } from "./bridge-protocol.js";
import { getBrowserInfoOnce } from "./browser-info.js";
import { clipDownloadPath, saveClipFile, type SavedClipFile } from "./clip-file.js";
import {
  loadClipMemory,
  lookupClip,
  recordClip,
  type ClipMemory,
  type ClipMemoryEntry,
  type ClipTarget,
} from "./clip-memory.js";
import {
  markdownForClip,
  OBSIDIAN_HANDOFF_GAP_MS,
  resolveClipRequest,
  type ClipPayload,
  type ObsidianClipRequest,
} from "./clip-format.js";
import { DOWNLOADS_GONE, downloadsGrant } from "./permissions.js";
import { getFilePlatformOnce } from "./platform.js";
import { delay } from "./serialize.js";
import { pickRule } from "./site-rules.js";
import { groupDuplicates, pickKeeper, type Tab } from "./dedup.js";
import {
  clipsToFile,
  defaults,
  hasClipDestination,
  loadSettings,
  normalizeOptsFrom,
  saveSettings,
  type Settings,
} from "./storage.js";
import { IS_CHROME } from "./target.js";
import { getZoteroTabInfo, isAcademicZoteroTarget, saveTabToZotero } from "./zotero.js";

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

export type ClipFailureReason =
  | "extract-failed"
  | "trigger-failed"
  | "vault-missing"
  | "zotero-failed"
  | "download-failed";

export interface ClipFailure {
  tabId: number;
  title: string;
  url: string;
  reason: ClipFailureReason;
  detail?: string;
}

/**
 * Why a run refused before touching a single tab. One field rather than a flag
 * per cause, because they are alternatives and the popups render exactly one of
 * them: `no-destination` is nothing configured to file into, `downloads-revoked`
 * is the file destination with its optional grant taken back.
 */
export type ClipBlockedReason = "no-destination" | "downloads-revoked";

export interface ClipSelectedTabsResponse {
  failed: number;
  obsidianSaved: number;
  /** Written as markdown files in the download folder (`clipDestination: "file"`). */
  fileSaved: number;
  zoteroSaved: number;
  /** Present only when nothing was attempted — and nothing was woken either. */
  blocked?: ClipBlockedReason;
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
  /**
   * Present when this page has been clipped before, from any tab and in any
   * earlier session. A record of the past, never a claim about the vault or the
   * download folder as they are now — see `ClipMark` and `src/clip-memory.ts`.
   *
   * The whole entry, where the wire's `BridgeTab` carries only the state: this
   * one crosses `runtime.sendMessage` to a surface with a tooltip to fill, not
   * into a model's context, so the listing budget `BridgeTab` protects does not
   * apply.
   */
  clipped?: ClipMemoryEntry;
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

function tabToPopupTab(t: Tab, memory: ClipMemory): PopupTab {
  const tab: PopupTab = {
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
  const clipped = lookupClip(memory, t.url, normalizeOptsFrom(settings));
  if (clipped) tab.clipped = clipped;
  return tab;
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

/** How long a user-initiated clip waits for a woken tab to finish loading. */
const TAB_READY_TIMEOUT_MS = 15000;

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
//
// A newly created Firefox tab has a separate placeholder state: tabs.create
// resolves with `about:blank` already marked "complete" before the requested
// URL begins loading. Callers waiting for a particular document can supply its
// URL so neither that placeholder nor an intervening navigation counts.
async function ensureTabReady(
  tabId: number,
  timeoutMs: number,
  expectedUrl?: string,
): Promise<void> {
  let cleanup = (): void => {};
  const settled = new Promise<void>((resolve, reject) => {
    const listener = (
      updatedTabId: number,
      changeInfo: { status?: string },
      updatedTab: Tab,
    ): void => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== "complete") return;
      if (expectedUrl !== undefined && updatedTab.url !== expectedUrl) return;
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
    const isExpectedDocument = expectedUrl === undefined || tab.url === expectedUrl;
    if (!tab.discarded && tab.status === "complete" && isExpectedDocument) {
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
  if (!isHttpUrl(tab.url)) {
    return { ok: false, error: "Only http and https pages can be clipped." };
  }

  if (wake) {
    try {
      await ensureTabReady(tab.id, TAB_READY_TIMEOUT_MS);
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

/**
 * How long the handoff waits for the launch page to run. Bounded because the
 * only cost of giving up is the behaviour this had before the wait existed, and
 * a per-clip stall would multiply across a Devour batch.
 */
const OBSIDIAN_LAUNCH_PAGE_TIMEOUT_MS = 2000;
/** Grace for the external-protocol dispatch before the launch tab is dropped. */
const OBSIDIAN_LAUNCH_TAB_CLOSE_MS = 500;

async function openObsidianUrl(url: string): Promise<void> {
  // A tabs.create straight to obsidian:// is browser-initiated, so Firefox has
  // no page principal against which it can remember an external-protocol grant
  // (Chrome has the equivalent limitation). Launch from a packaged page on both
  // engines instead. Its extension origin is the same one the onboarding ping
  // is approved for, so that one approval applies to every later clip.
  const launchUrl = `${browser.runtime.getURL("redirect/obsidian-redirect.html")}#${encodeURIComponent(url)}`;
  const ephemeral = await browser.tabs.create({ url: launchUrl, active: false });
  const ephemeralId = ephemeral.id;
  if (ephemeralId === undefined) return;
  // The page load is now on the handoff's critical path — tabs.create resolves
  // before the redirect page's module script has issued the obsidian:// launch,
  // and "complete" for that URL is the earliest proof that it has (a module
  // script runs before the load event). The URL qualification matters on
  // Firefox, where the new tab first reports about:blank as already complete.
  // Two things ride on that proof: the close below, which would otherwise be
  // racing the page load and could drop the clip outright, and the caller's
  // OBSIDIAN_HANDOFF_GAP_MS pacing — in clipboard mode the next clip overwrites
  // the OS clipboard this launch has yet to read.
  try {
    await ensureTabReady(ephemeralId, OBSIDIAN_LAUNCH_PAGE_TIMEOUT_MS, launchUrl);
  } catch (err) {
    console.warn("[tabglutton] obsidian launch page did not finish loading", err);
  }
  setTimeout(() => {
    void browser.tabs.remove(ephemeralId).catch(() => {});
  }, OBSIDIAN_LAUNCH_TAB_CLOSE_MS);
}

async function resolveTabMeta(tabId: number): Promise<{ title: string; url: string }> {
  try {
    const t = await browser.tabs.get(tabId);
    return { title: t.title ?? "", url: t.url ?? "" };
  } catch {
    return { title: "", url: "" };
  }
}

type TabDestination =
  | { kind: "obsidian" }
  | { kind: "file" }
  | { kind: "zotero" }
  | { kind: "failed"; reason: ClipFailureReason; detail: string };

/** Both note destinations run Defuddle; Zotero owns its own page reading. */
function needsExtraction(destination: TabDestination): boolean {
  return destination.kind === "obsidian" || destination.kind === "file";
}

const ZOTERO_DETECTION_ATTEMPTS = 8;
const ZOTERO_DETECTION_RETRY_MS = 250;

/**
 * Decides where one tab goes, and owns the wake for the whole run — the
 * extraction below is called with `wake: false`.
 *
 * The wake has to come first because the Connector's per-tab translator result
 * only exists for a page whose content script has run, and Devour's normal
 * workload is a backlog of discarded tabs. Asking before waking never sees a
 * translator: an arXiv tab in the backlog reports "detecting" (or a
 * translator-less "ready") and is failed or silently sent to Obsidian.
 */
async function destinationForTab(
  tabId: number,
  url: string,
  downloadsHeld: boolean,
): Promise<TabDestination> {
  // clipTab re-checks the scheme against its own fresh read and owns the error
  // message; this gate only keeps a tab that provably cannot be clipped from
  // being woken and probed for nothing. An address we cannot read yet is not
  // proof — Chrome reports `url: ""` until a navigation commits — so an empty
  // one is waited on rather than written off.
  const clippable = !url || isHttpUrl(url);
  if (clippable) {
    try {
      await ensureTabReady(tabId, TAB_READY_TIMEOUT_MS);
    } catch (err) {
      // Neither destination can have a tab that will not load. Reported as an
      // extract failure, which is what the Obsidian path always called it.
      return { kind: "failed", reason: "extract-failed", detail: errorMessage(err) };
    }
    if (settings.zoteroRoutingEnabled) {
      const zotero = await zoteroDestination(tabId);
      if (zotero) return zotero;
    }
  }
  // The chosen destination, not a fallback: file mode never asks about a vault
  // and Obsidian mode never quietly writes a file. See `ClipDestination`.
  if (clipsToFile(settings)) {
    // The grant is run-global, so it was answered once in `clipSelectedTabs`
    // rather than re-asked per tab — and asked there because this function has
    // already woken the tab by the time it would run, so a revoked grant would
    // reload an entire backlog only to fail every page of it. A run reaches
    // here holding a `false` in exactly one configuration: Zotero routing on
    // *and* the file destination chosen, where the whole run cannot be refused
    // because the papers in it still file to Zotero. Those tabs were woken for
    // the Connector's sake regardless of this grant, so nothing is spent on it.
    if (!downloadsHeld) {
      return { kind: "failed", reason: "download-failed", detail: DOWNLOADS_GONE };
    }
    return { kind: "file" };
  }
  if (!settings.obsidianVault.trim()) {
    return {
      kind: "failed",
      reason: "vault-missing",
      detail: "This tab was not an academic Zotero item and no Obsidian vault is configured.",
    };
  }
  return { kind: "obsidian" };
}

/** `null` when the tab is simply not a paper — the caller falls through. */
async function zoteroDestination(tabId: number): Promise<TabDestination | null> {
  // A throw is retried like a "detecting" answer: the Connector's MV3 service
  // worker can be mid-suspend when a batch reaches it, and Chrome answers that
  // race with "Could not establish connection", not with a real verdict.
  let lastError = "Zotero Connector did not finish detecting this tab.";
  for (let attempt = 0; attempt < ZOTERO_DETECTION_ATTEMPTS; attempt += 1) {
    try {
      const info = await getZoteroTabInfo(settings.zoteroConnectorId, tabId);
      if (info.state === "ready") return isAcademicZoteroTarget(info) ? { kind: "zotero" } : null;
    } catch (err) {
      lastError = errorMessage(err);
    }
    if (attempt + 1 < ZOTERO_DETECTION_ATTEMPTS) {
      await delay(ZOTERO_DETECTION_RETRY_MS);
    }
  }
  return { kind: "failed", reason: "zotero-failed", detail: lastError };
}

type ExtractOutcome = { kind: "ok"; res: ClipCurrentResponse } | { kind: "threw"; err: unknown };

interface PreparedTab {
  meta: { title: string; url: string };
  destination: TabDestination;
  /** Only for note-bound tabs (Obsidian or file); Zotero needs no extraction. */
  extract?: ExtractOutcome;
}

/**
 * Why one download failed, after the run's up-front grant check had already
 * passed. A grant revoked mid-run is the one cause the engine reports opaquely
 * — Gecko throws a schema error naming the `data:` URL, Chrome a bare "not
 * allowed" — so it is named, and named with a remedy. Asked only once a write
 * has already failed, so a run that works pays no extra IPC for it; the same
 * shape the bridge's `fileClip` uses.
 */
async function downloadFailureDetail(err: unknown): Promise<string> {
  // Only a grant we can see is gone earns the claim that it is: a check that
  // threw knows nothing, and the engine's own message is the honest answer.
  if ((await downloadsGrant()) === "missing") return DOWNLOADS_GONE;
  return errorMessage(err);
}

/**
 * Note one clip in the clip memory, against the settings this run is using.
 * Never throws (see `recordClip`) — the page is already filed by the time this
 * runs, and a memory write that fails must not turn it into a reported failure.
 */
async function rememberClip(
  url: string | undefined,
  state: ClipMark,
  destination: ClipTarget,
): Promise<void> {
  await recordClip({ url, state, destination }, normalizeOptsFrom(settings));
}

function clipBlocked(blocked: ClipBlockedReason): ClipSelectedTabsResponse {
  return { failed: 0, obsidianSaved: 0, fileSaved: 0, zoteroSaved: 0, blocked, failures: [] };
}

async function clipSelectedTabs(tabIds: number[]): Promise<ClipSelectedTabsResponse> {
  const vault = settings.obsidianVault.trim();
  if (!hasClipDestination(settings)) return clipBlocked("no-destination");
  // `downloads` is optional and revocable from the browser's own add-on UI, so
  // the grant the options page collected may be gone. It is run-global, so it
  // is answered once here — and *before* phase 1, which reloads every discarded
  // tab in the run. Checked any later, a revoked grant would cost a backlog of
  // page loads to reach the same answer, and would report it as tens of
  // identical per-tab failures rather than as the one fact it is.
  //
  // Refusing the whole run needs the stronger claim that nothing in it could
  // have gone anywhere else. Zotero routing breaks that: an academic tab files
  // through the Connector, which needs no `downloads` at all, so a run with
  // routing on is let through and only its file-bound tabs fail. And only a
  // grant seen to be missing refuses anything — `unknown` carries on, because a
  // check that threw is not evidence of a revocation.
  const downloadsHeld = clipsToFile(settings) ? (await downloadsGrant()) !== "missing" : true;
  if (!downloadsHeld && !settings.zoteroRoutingEnabled) return clipBlocked("downloads-revoked");

  // Phase 1: read, wake, route and extract each tab as one per-tab chain, all
  // of them overlapping. There is deliberately no barrier between the steps —
  // the slow parts are ensureTabReady's reload-and-wait and the Connector's
  // detection poll, so a tab that resolves early must not wait on the slowest
  // one before extracting. Zotero-bound tabs stop after routing: Zotero already
  // owns the page and its translator state, so a paper needs neither Defuddle
  // nor Tabglutton's host permission. clipTab is concurrency-safe (per-tab
  // onUpdated listener, unique requestId in pendingClips) and is passed
  // `wake: false` because destinationForTab has already woken the tab.
  const prepared = new Map(
    await Promise.all(
      tabIds.map(async (tabId): Promise<[number, PreparedTab]> => {
        const meta = await resolveTabMeta(tabId);
        const destination = await destinationForTab(tabId, meta.url, downloadsHeld);
        if (!needsExtraction(destination)) return [tabId, { meta, destination }];
        try {
          return [
            tabId,
            {
              meta,
              destination,
              extract: { kind: "ok", res: await clipTab(tabId, { wake: false }) },
            },
          ];
        } catch (err) {
          return [tabId, { meta, destination, extract: { kind: "threw", err } }];
        }
      }),
    ),
  );

  // Phase 2: dispatch in selection order. Connector saves are serialized so
  // progress/selection UI from two papers cannot race. Obsidian remains serial
  // because clipboard mode uses the global OS clipboard; the 200ms gap also
  // keeps its URI handler reliable.
  const total = tabIds.length;
  const broadcastProgress = (completed: number): void => {
    const msg: ClipProgressMessage = { type: "clip-progress", completed, total };
    browser.runtime.sendMessage(msg).catch(() => {});
  };
  broadcastProgress(0);
  let obsidianSaved = 0;
  let fileSaved = 0;
  let zoteroSaved = 0;
  const failures: ClipFailure[] = [];
  for (const [i, tabId] of tabIds.entries()) {
    try {
      const entry = prepared.get(tabId);
      if (!entry) continue;
      const { meta, destination, extract } = entry;
      // Every failure in this loop reports the same tab against the same
      // metadata; only the payload-derived titles below override it.
      const fail = (
        reason: ClipFailureReason,
        detail: string | undefined,
        title = meta.title,
        url = meta.url,
      ): void => void failures.push({ tabId, title, url, reason, detail });

      if (destination.kind === "failed") {
        fail(destination.reason, destination.detail);
        continue;
      }

      if (destination.kind === "zotero") {
        try {
          await saveTabToZotero(settings.zoteroConnectorId, tabId);
        } catch (err) {
          fail("zotero-failed", errorMessage(err));
          console.warn("[tabglutton] Zotero save failed for tab", tabId, err);
          continue;
        }
        // The Connector accepted the item, which is its report of a handoff and
        // not a file this extension ever sees — `launched`, like Obsidian.
        await rememberClip(meta.url, "launched", "zotero");
        try {
          await browser.tabs.remove(tabId);
        } catch (err) {
          console.warn("[tabglutton] close after Zotero save failed for tab", tabId, err);
        }
        zoteroSaved += 1;
        continue;
      }

      if (!extract) continue;
      if (extract.kind === "threw") {
        fail("extract-failed", errorMessage(extract.err));
        console.warn("[tabglutton] clip threw for tab", tabId, extract.err);
        continue;
      }
      const res = extract.res;
      if (!res.ok || !res.payload) {
        fail("extract-failed", res.error);
        console.warn("[tabglutton] clip failed for tab", tabId, res.error);
        continue;
      }

      if (destination.kind === "file") {
        let saved: SavedClipFile;
        try {
          const path = clipDownloadPath(
            res.payload,
            pickRule(res.payload.url),
            settings.clippingsBaseFolder,
            await getFilePlatformOnce(),
          );
          saved = await saveClipFile(path, markdownForClip(res.payload));
        } catch (err) {
          fail(
            "download-failed",
            await downloadFailureDetail(err),
            res.payload.title || meta.title,
            res.payload.url || meta.url,
          );
          console.warn("[tabglutton] file save failed for tab", tabId, err);
          continue;
        }
        if (!saved.confirmed) {
          // The browser had erased the download's record before we could read
          // it, which is as consistent with an interrupted write as a finished
          // one. Keep the tab: the whole reason this destination is allowed to
          // close one is that it can normally prove the file exists, and here
          // it cannot. Reported rather than counted, so the run says so.
          fail(
            "download-failed",
            "The browser had already forgotten this download, so the file could not be confirmed. The tab was kept — check the download folder.",
            res.payload.title || meta.title,
            res.payload.url || meta.url,
          );
          continue;
        }
        // `verified`: reaching here means saveClipFile watched the download
        // reach `state: "complete"`, which is the same evidence that licenses
        // the close below. The unconfirmed branch above never gets this far.
        await rememberClip(res.payload.url || meta.url, "verified", "file");
        // No OBSIDIAN_HANDOFF_GAP_MS here: that gap paces an external app
        // reading the OS clipboard, and this destination touches neither.
        // saveClipFile has now seen the file land, so the close is safe.
        try {
          await browser.tabs.remove(tabId);
        } catch (err) {
          console.warn("[tabglutton] close failed for tab", tabId, err);
        }
        fileSaved += 1;
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
        fail(
          "extract-failed",
          errorMessage(err),
          res.payload.title || meta.title,
          res.payload.url || meta.url,
        );
        console.warn("[tabglutton] format failed for tab", tabId, err);
        continue;
      }

      try {
        await openObsidianUrl(req.url);
      } catch (err) {
        fail("trigger-failed", errorMessage(err), res.payload.title, res.payload.url);
        console.warn("[tabglutton] trigger failed for tab", tabId, err);
        continue;
      }

      // `launched` and nothing stronger: the popup has no sidecar to ask, and a
      // refused obsidian:// launch is indistinguishable from a taken one.
      await rememberClip(res.payload.url || meta.url, "launched", "obsidian");

      await delay(OBSIDIAN_HANDOFF_GAP_MS);
      try {
        await browser.tabs.remove(tabId);
      } catch (err) {
        console.warn("[tabglutton] close failed for tab", tabId, err);
      }
      obsidianSaved += 1;
    } finally {
      broadcastProgress(i + 1);
    }
  }
  return {
    failed: failures.length,
    obsidianSaved,
    fileSaved,
    zoteroSaved,
    failures,
  };
}

browser.runtime.onMessage.addListener(async (rawMsg: unknown): Promise<unknown> => {
  if (!rawMsg || typeof rawMsg !== "object") return undefined;
  const msg = rawMsg as IncomingMessage;
  switch (msg.type) {
    case "clip-current-result":
      return finishClipResult(msg);
    case "get-scoped-tabs": {
      const tabs = (await queryScopedTabs()).filter(tabInScope);
      // One read for the whole listing, not one per tab.
      const memory = await loadClipMemory();
      const response: GetScopedTabsResponse = {
        tabs: tabs
          .map((t) => tabToPopupTab(t, memory))
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
