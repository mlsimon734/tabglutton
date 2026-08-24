// Extension-side implementations of the five bridge methods (see docs/BRIDGE.md).
// Everything that touches the real page — extraction, the Obsidian handoff — is
// injected as a dependency by background.ts, which already owns that machinery;
// this module only adds the tab/undo-log surface the agent sees.
//
// Trust boundary: read + file + close, nothing else. No navigation, no
// scripting beyond the existing Defuddle clipper, and every close is logged
// before it happens.

import { clipContentHash } from "./clip-hash.js";
import type { ThinClipVerdict } from "./clip-guard.js";
import { clipDownloadPath, saveClipFile, type SavedClipFile } from "./clip-file.js";
import { markdownForClip, OBSIDIAN_HANDOFF_GAP_MS, resolveClipRequest } from "./clip-format.js";
import type { ClipPayload } from "./clip-format.js";
import {
  BridgeRequestError,
  errorMessage,
  parseClipConfirmParams,
  parseTabClipParams,
  parseTabReadParams,
  parseTabsCloseParams,
  parseTabsListParams,
  selectTabs,
  parseTabsLoadParams,
  parseUndoCloseParams,
  TABS_LOAD_DEADLINE_MS,
  type BridgeErrorCode,
  type BridgeTab,
  type BridgeWireMethod,
  type ClipMark,
  type ClosedTabEntry,
  type FileClipResult,
  type ObsidianClipResult,
  type TabClipParams,
  type TabClipResult,
  type TabLoadOutcome,
  type TabReadResult,
  type TabsCloseResult,
  type TabsListResult,
  type TabsLoadResult,
  type UndoCloseResult,
  type ZoteroClipResult,
} from "./bridge-protocol.js";
import {
  clipMarkFor,
  loadClipMemory,
  lookupClip,
  recordClip,
  type ClipMemory,
  type ClipTarget,
} from "./clip-memory.js";
import type { NormalizeOpts } from "./normalize.js";
import { getFilePlatformOnce } from "./platform.js";
import { createTaskQueue, delay } from "./serialize.js";
import { pickRule, type SiteRule } from "./site-rules.js";
import { clipDestinationFor, normalizeOptsFrom, type Settings } from "./storage.js";
import { CLIP_ORIGINS, DOWNLOADS_REMEDY, downloadsGrant, hasOrigins } from "./permissions.js";
import { IS_CHROME } from "./target.js";
import {
  appendBatch,
  findBatch,
  parseUndoLog,
  retainEntries,
  UNDO_LOG_KEY,
  type UndoBatch,
} from "./undo-log.js";

/**
 * Appended to every "no such tab id" error. A stale id reads as "the tab was
 * closed", but Chrome hands a discarded tab a *brand new* id — so a listing
 * taken before a memory-pressure unload points at ids that no longer resolve
 * even though the tabs are all still sitting there. Triage runs list once and
 * act later, which is exactly when this bites.
 */
const STALE_ID_HINT =
  "It may have been closed, or unloaded and given a new id (Chrome does this when it discards a tab). Re-run tabs_list for current ids.";

/** The single place the hint is attached — throwing and per-tab paths alike. */
function missingTabReason(message: string): string {
  return `${message} ${STALE_ID_HINT}`;
}

/** The only way to raise "no such tab id" as a whole-call failure. */
function failMissingTab(message: string): never {
  fail("not-found", missingTabReason(message));
}

/** The browser's answer to "does this id still resolve?", failure swallowed. */
async function tryGetTab(tabId: number): Promise<browser.tabs.Tab | null> {
  try {
    return await browser.tabs.get(tabId);
  } catch {
    return null;
  }
}

/**
 * Every lookup that should fail the whole call goes through here, so the hint
 * cannot be attached to some of them and not others. `tab_clip`'s close step is
 * deliberately not one of these — the note is already filed by then.
 */
async function getTabOrFail(tabId: number): Promise<browser.tabs.Tab> {
  return (await tryGetTab(tabId)) ?? failMissingTab(`No tab with id ${tabId}.`);
}

export interface BridgeExtractResult {
  ok: boolean;
  payload?: ClipPayload;
  error?: string;
  /**
   * The extraction itself succeeded and was refused for being too thin to be a
   * clip (`src/clip-guard.ts`); `ok` is false and the refused text hangs off the
   * verdict, not off `payload`. Its own field rather than an `error` prefix,
   * because `readTab` has to branch on it before it starts diagnosing a failure
   * that did not happen. Mirrors `ClipCurrentResponse` in `background.ts`, whose
   * comment records where a divergence between the two actually fails.
   */
  guarded?: ThinClipVerdict & { payload: ClipPayload };
}

export interface BridgeMethodDeps {
  getSettings: () => Settings;
  /**
   * Extract the tab through Defuddle WITHOUT waking it. Waking is its own
   * explicitly-gated act (`tabs_load`), so reading never navigates as a side
   * effect — a discarded tab is reported as discarded instead.
   */
  extract: (tabId: number) => Promise<BridgeExtractResult>;
  /** Reload a discarded tab and resolve once it is loaded. Backs `tabs_load`. */
  load: (tabId: number, timeoutMs: number) => Promise<void>;
  openObsidianUrl: (url: string) => Promise<void>;
  copyToClipboardViaTab: (tabId: number, text: string) => Promise<boolean>;
  /**
   * Ask the Zotero Connector whether this tab is one it should take — the very
   * same question the popup's Devour asks, injected rather than re-derived so
   * the verdict cannot drift and every Connector wire detail stays in
   * `src/zotero.ts`, where an upstream change to the API has one place to land.
   *
   * Only the Connector's verdict; whether the user routes papers at all is the
   * caller's to check, because that answer also decides whether the tab is
   * touched in the first place.
   *
   * Rejects when the Connector could not answer. Never a `false`: the caller
   * must not read "I could not ask" as "this is not a paper".
   */
  routesToZotero: (tabId: number) => Promise<boolean>;
  /** Save a routed tab through the Connector. Resolves only on a confirmed save. */
  saveToZotero: (tabId: number) => Promise<void>;
}

/**
 * Per-tab ceiling, held separate from the batch deadline so one page that never
 * finishes cannot spend the whole call's budget: it is reported pending and the
 * next tab gets its turn.
 */
const TAB_LOAD_TIMEOUT_MS = 20_000;

/**
 * How many pages load at once. Anyone with a backlog big enough to need
 * `tabs_load` is running an auto-discarder because memory is scarce, and waking
 * twenty pages simultaneously would spend exactly what the discarder saved.
 */
const TABS_LOAD_CONCURRENCY = 3;

/**
 * Gecko was observed rejecting the first script injection after `tabs_load`
 * reported a page ready even though the extension still held its host grant.
 * The identical extraction succeeded a moment later; keep this pause local to
 * that measured error instead of delaying or repeating every failed read.
 */
const TRANSIENT_EXTRACT_RETRY_MS = 250;
const NO_INJECTION_TARGET_ERROR = "missing host permission for the tab";

/**
 * Appended when the retry has been spent. Gecko raises the message above for
 * *any* injection that came back with no results, so it names a permission
 * whether or not one is missing — say what is actually known instead of
 * repeating it, and never advise a retry that cannot help.
 */
const NO_INJECTION_TARGET_HINT =
  "Firefox reports this whenever no frame accepted the injection: the page may have been navigating, or it may be one the engine keeps closed to extensions (its own add-on, support, and account sites). The host grant is held, so a second failure means this page cannot be read.";

/**
 * Appended when routing could not get a verdict. Two different failures reach
 * it and the wording has to hold for both: the Connector could not be reached
 * at all (absent, disabled, wrong ID, or this extension not in its allowlist),
 * or it was reached and answered `detecting` until the poll ran out — which is
 * a property of the one tab, not of the install. Hence the conditional: the
 * remedies are worth naming because none of them are visible from the engine's
 * own message ("Could not establish connection" reads like a transient miss),
 * and worth qualifying because telling someone to reinstall the Connector that
 * just answered them is worse than saying nothing.
 */
const ZOTERO_UNREACHABLE_HINT =
  "Tabglutton could not get a verdict from the Zotero Connector for this tab, so it was left open rather than filed somewhere the user did not choose. A tab that was still loading can do this on its own. If it happens for every tab, ask the user to check that the Connector is installed and enabled, that the Connector ID in Tabglutton's settings matches it, and that Tabglutton's own extension ID is listed in the Connector's externalAPI.allowedExtensions preference.";

/** Pure so the engine-string gate can be pinned without a browser harness. */
export function isNoInjectionTargetError(message: string | undefined): boolean {
  return message?.toLowerCase().includes(NO_INJECTION_TARGET_ERROR) === true;
}

function fail(code: BridgeErrorCode, message: string): never {
  throw new BridgeRequestError(code, message);
}

/** Distinguish a real missing host grant from an injection failure. */
async function requireClipAccess(): Promise<void> {
  if (await hasOrigins(CLIP_ORIGINS)) return;
  fail(
    "not-enabled",
    "Tabglutton has no access to page contents, so tabs cannot be read or clipped. " +
      "Ask the user to open the Tabglutton popup and run Devour once — that is where " +
      "the browser asks for the permission.",
  );
}

/**
 * Chrome reports `url: ""` until a navigation commits, parking the target in
 * the Chrome-only `pendingUrl`. A tab caught mid-load would otherwise look like
 * it has no address at all — missing from a listing and, worse, unrecordable in
 * the undo log, so closing it would be the one thing `undo_close` cannot
 * reverse.
 *
 * Gecko has no equivalent field: it reports `about:blank` for the same window
 * (verified on Zen 1.21.9b), so a tab closed mid-load is recorded as
 * about:blank and reopens blank. Nothing in the API exposes the pending target
 * there, so that stays a known limitation — narrow in practice, since triage
 * acts on tabs that came back from a listing and have long since committed.
 */
function tabUrl(tab: browser.tabs.Tab): string | undefined {
  return tab.url || (tab as { pendingUrl?: string }).pendingUrl || undefined;
}

/** Defuddle needs a real document; `about:`, `file:`, and the rest never have one. */
export function isHttpUrl(url: string | undefined): boolean {
  return url?.startsWith("http://") === true || url?.startsWith("https://") === true;
}

/**
 * `memory` and `opts` come from the caller rather than being read here: a
 * listing maps up to a few thousand tabs and the memory is one `storage.local`
 * read for all of them.
 */
function toBridgeTab(
  tab: browser.tabs.Tab,
  memory: ClipMemory,
  opts: NormalizeOpts,
): BridgeTab | null {
  const url = tabUrl(tab);
  if (tab.id === undefined || url === undefined) return null;
  const bridgeTab: BridgeTab = {
    id: tab.id,
    title: tab.title ?? "",
    url,
    windowId: tab.windowId ?? -1,
    index: tab.index,
  };
  // Everything below is omitted unless it says something. See BridgeTab: a
  // listing is repeated once per tab into a model's context, and false flags
  // were most of what it carried.
  if (tab.lastAccessed !== undefined && tab.lastAccessed > 0) {
    bridgeTab.lastAccessed = tab.lastAccessed;
  }
  if (tab.discarded === true) bridgeTab.discarded = true;
  if (tab.pinned) bridgeTab.pinned = true;
  if (tab.active) bridgeTab.active = true;
  // Chrome has no `tab.hidden` at all, so there it is never a signal either way.
  if (!IS_CHROME && tab.hidden === true) bridgeTab.hidden = true;
  const clipped = lookupClip(memory, url, opts);
  if (clipped) bridgeTab.clipped = clipMarkFor(clipped);
  return bridgeTab;
}

function toClosedEntry(tab: browser.tabs.Tab): ClosedTabEntry | null {
  const url = tabUrl(tab);
  if (!url) return null;
  return {
    url,
    title: tab.title ?? "",
    pinned: tab.pinned,
    windowId: tab.windowId ?? -1,
    index: tab.index,
    incognito: tab.incognito,
  };
}

function hasTabId(tab: browser.tabs.Tab): tab is browser.tabs.Tab & { id: number } {
  return tab.id !== undefined;
}

// `browser.tabs.query({})` with no filter is broken on Zen
// (zen-browser/desktop#11210), so "all windows" is assembled window by window.
async function queryAllTabs(): Promise<browser.tabs.Tab[]> {
  const windows = await browser.windows.getAll();
  const perWindow = await Promise.all(
    windows.map(async (w) => (w.id === undefined ? [] : browser.tabs.query({ windowId: w.id }))),
  );
  return perWindow.flat();
}

async function readUndoLog(): Promise<UndoBatch[]> {
  const stored = await browser.storage.local.get(UNDO_LOG_KEY);
  return parseUndoLog((stored as Record<string, unknown>)[UNDO_LOG_KEY]);
}

async function writeUndoLog(log: UndoBatch[]): Promise<void> {
  await browser.storage.local.set({ [UNDO_LOG_KEY]: log });
}

/**
 * Every read-modify-write of the undo log runs here, one at a time.
 *
 * `storage.local` has no compare-and-swap, so the read and the write are two
 * awaits with a gap between them, and bridge requests are served concurrently —
 * `bridge-client.ts` dispatches each frame independently, and the hub/peer design
 * exists precisely so two agent sessions can drive one browser at once. Two
 * `tabs_close` calls interleaving there both read the same log, both append their
 * own batch, and the second write drops the first: those tabs are closed, the
 * batch is gone, and `undo_close` answers not-found. That is the one guarantee
 * the whole close path is built on, so the log gets a lock rather than a hope.
 *
 * `undo_close` holds it across its restores, not just its two critical sections.
 * Slower, but a close landing in the middle of a restore is genuinely ambiguous,
 * and it makes a double undo of one batch safe for free: the second caller
 * re-reads inside the lock and finds the batch already dropped or already
 * narrowed to what failed, instead of reopening everything twice.
 */
const withUndoLog = createTaskQueue();

/** Where a fallback restore should land, and whether getting there already placed it. */
interface WindowHome {
  windowId: number;
  /**
   * The tab the window was opened with. `windows.create` always brings a tab of
   * its own, so a new window is seeded with the entry's URL rather than opened
   * blank — creating the restored tab separately would strand that blank one in
   * every undo unlucky enough to need a new window.
   */
  seededTabId?: number;
  seeded: boolean;
}

/**
 * The windows that exist at the moment an undo runs, indexed for restore
 * decisions. A recorded window id is not proof of anything on its own: the undo
 * log survives a browser restart, after which ids start over and the id we
 * stored may belong to a different window — possibly one of the other privacy
 * context. So placement is only trusted when a live window with that id shares
 * the tab's context.
 */
class LiveWindows {
  private readonly contexts = new Map<number, boolean>();
  private readonly preferred = new Map<boolean, number>();

  static async load(): Promise<LiveWindows> {
    return new LiveWindows(await browser.windows.getAll());
  }

  private constructor(windows: browser.windows.Window[]) {
    for (const w of windows) {
      if (w.id === undefined) continue;
      this.contexts.set(w.id, w.incognito);
      // The focused window is where a plain `tabs.create` would have landed, so
      // it is the natural home for a tab whose own window is gone.
      if (w.focused || !this.preferred.has(w.incognito)) this.preferred.set(w.incognito, w.id);
    }
  }

  matches(windowId: number, incognito: boolean): boolean {
    return this.contexts.get(windowId) === incognito;
  }

  /**
   * A window of this privacy context, opening one on `url` if the last was
   * closed. Only the first entry to need a new window is seeded by it; the rest
   * find it cached here and are created normally.
   */
  async windowFor(incognito: boolean, url: string): Promise<WindowHome> {
    const existing = this.preferred.get(incognito);
    if (existing !== undefined) return { windowId: existing, seeded: false };
    const created = await browser.windows.create({ incognito, url });
    if (created.id === undefined) {
      throw new Error(`Could not open a ${incognito ? "private" : "normal"} window.`);
    }
    this.preferred.set(incognito, created.id);
    const seededTabId = created.tabs?.[0]?.id;
    return {
      windowId: created.id,
      seeded: true,
      ...(seededTabId !== undefined ? { seededTabId } : {}),
    };
  }
}

/**
 * Recreate one closed tab. Position is best-effort — the original window may be
 * gone — but the privacy context is not. Closing the last tabs of a private
 * window takes the window with them, and reopening those URLs in a normal
 * window would put them into history and sync, so a private tab is only ever
 * restored into a private window. If none can be opened (the extension has no
 * private-browsing access), this throws and the entry stays in the undo log.
 */
async function restoreEntry(entry: ClosedTabEntry, windows: LiveWindows): Promise<void> {
  const incognito = entry.incognito ?? false;
  if (windows.matches(entry.windowId, incognito)) {
    try {
      await browser.tabs.create({
        url: entry.url,
        windowId: entry.windowId,
        index: entry.index,
        pinned: entry.pinned,
        active: false,
      });
      return;
    } catch (err) {
      // Window closing under us, or an index it will not take: reopen loose
      // rather than lose the tab.
      console.warn("[tabglutton] bridge undo placement failed for", entry.url, err);
    }
  }
  const home = await windows.windowFor(incognito, entry.url);
  if (home.seeded) {
    // The window came up already showing this entry, so there is no tab left to
    // create — only the pinned state to reapply, which `windows.create` has no
    // way to express.
    if (entry.pinned && home.seededTabId !== undefined) {
      await browser.tabs.update(home.seededTabId, { pinned: true });
    }
    return;
  }
  // `pinned` survives even when the index and window cannot: a pinned tab
  // reopened as an ordinary one is a change the user never asked for and would
  // have to spot to fix.
  await browser.tabs.create({
    url: entry.url,
    windowId: home.windowId,
    pinned: entry.pinned,
    active: false,
  });
}

async function recordClosed(entries: ClosedTabEntry[]): Promise<string> {
  const batch: UndoBatch = { id: crypto.randomUUID(), closedAt: Date.now(), entries };
  return withUndoLog(async () => {
    await writeUndoLog(appendBatch(await readUndoLog(), batch));
    return batch.id;
  });
}

/**
 * Narrow a recorded batch to the tabs that actually closed, dropping it whole if
 * none did.
 *
 * The batch is written *before* `tabs.remove`, which is the right order — a
 * crash mid-remove must not lose the trail — but it means a removal the browser
 * refuses leaves the log describing a tab that is still open. An id-less
 * `undo_close` takes the newest batch, so that orphan is exactly what the next
 * undo reaches for, and it would reopen a duplicate of a tab that never went
 * anywhere.
 */
async function reconcileBatch(batchId: string, closed: readonly ClosedTabEntry[]): Promise<void> {
  await withUndoLog(async () => {
    await writeUndoLog(retainEntries(await readUndoLog(), batchId, closed));
  });
}

/** Whether the browser still knows this id — the only honest answer to "did it close?". */
async function tabExists(tabId: number): Promise<boolean> {
  return (await tryGetTab(tabId)) !== null;
}

/**
 * Close tabs, and report which ids are actually gone afterwards.
 *
 * `tabs.remove(ids)` is not all-or-nothing. Chrome removes in order and rejects
 * the whole call at the first id that no longer resolves, leaving the tabs ahead
 * of it closed and the ones behind it open — AGENTS.md records this for a
 * duplicate id, and a stale id takes the identical path, which is the common one
 * here since Chrome mints a new id every time it discards a tab. Treating the
 * rejection as "nothing closed" would report an error over tabs that are gone
 * and leave an undo batch describing tabs that are not.
 *
 * So a rejection only demotes the fast path: every id is retried on its own, and
 * then the browser is asked which of them still exist. Absence is the signal
 * rather than the retry's own result — a tab the batch call already took rejects
 * the retry too, and dropping its entry would be the one close `undo_close`
 * could never reverse. The residual ambiguity is a Chrome tab discarded between
 * the listing and here: it reads as closed because its old id is gone, so its
 * entry survives in the log. Keeping an entry too many costs a duplicate tab on
 * undo; losing one costs a tab.
 */
async function removeTabs(ids: readonly number[]): Promise<Set<number>> {
  try {
    await browser.tabs.remove([...ids]);
    return new Set(ids);
  } catch (err) {
    console.warn("[tabglutton] bridge batch close rejected; closing one at a time", err);
  }
  const removed = await Promise.allSettled(ids.map((id) => browser.tabs.remove(id)));
  // A fulfilled retry is already an answer; only the rejected ones are worth an
  // existence check, which at triage scale skips one tabs.get IPC per tab that
  // plainly closed. The union is unchanged: fulfilled implies gone either way.
  const gone = new Set(ids.filter((_, i) => removed[i]?.status === "fulfilled"));
  const unsure = ids.filter((id) => !gone.has(id));
  const alive = await Promise.allSettled(unsure.map((id) => browser.tabs.get(id)));
  unsure.forEach((id, i) => {
    if (alive[i]?.status === "rejected") gone.add(id);
  });
  return gone;
}

export class BridgeMethodRunner {
  private readonly deps: BridgeMethodDeps;
  /** Serializes Obsidian handoffs; the OS clipboard is a global resource. */
  private readonly handoffQueue = createTaskQueue();
  /** Serializes file writes; `uniquify` picks a name against the filesystem. */
  private readonly fileQueue = createTaskQueue();

  constructor(deps: BridgeMethodDeps) {
    this.deps = deps;
  }

  async run(method: BridgeWireMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case "tabs_list":
        return this.tabsList(params);
      case "tabs_load":
        return this.tabsLoad(params);
      case "tab_read":
        return this.tabRead(params);
      case "tab_clip":
        return this.tabClip(params);
      case "tabs_close":
        return this.tabsClose(params);
      case "undo_close":
        return this.undoClose(params);
      case "clip_confirm":
        return this.clipConfirm(params);
    }
  }

  /**
   * Gullet found the note this extension could only report having launched.
   * Raises that page's clip memory to `verified` — see `ClipConfirmParams` for
   * why the sidecar is the only party that can say so, and
   * `BRIDGE_SIDECAR_METHODS` for why no agent can.
   *
   * Obsidian by construction: it is sent only after a vault check, because the
   * file destination is confirmed by the browser that watched the download and
   * Gullet deliberately verifies nothing there.
   */
  private async clipConfirm(raw: unknown): Promise<{ recorded: true }> {
    const { url } = parseClipConfirmParams(raw);
    await this.noteClip(url, "verified", "obsidian");
    return { recorded: true };
  }

  private async tabsList(raw: unknown): Promise<TabsListResult> {
    const params = parseTabsListParams(raw);
    const tabs =
      params.scope === "current-window"
        ? await browser.tabs.query({ currentWindow: true })
        : await queryAllTabs();
    const memory = await loadClipMemory();
    const opts = normalizeOptsFrom(this.deps.getSettings());
    const mapped = tabs
      .map((tab) => toBridgeTab(tab, memory, opts))
      .filter((t): t is BridgeTab => t !== null);
    // `groupBy` counts every match, so truncating here would corrupt the counts.
    // Gullet does the grouping, over every browser at once — and the full list
    // crossing loopback costs nothing, unlike the same list crossing into a
    // model's context, which is the only budget any of this is protecting.
    //
    // The Infinity stays local: `selectTabs` spends it on a `slice` and it is
    // absent from `TabsListResult`, so it never meets `JSON.stringify`, which
    // would silently turn it into `null`. Anything that later puts a limit on
    // the wire has to send a real number.
    const limit = params.groupBy === undefined ? params.limit : Number.POSITIVE_INFINITY;
    return selectTabs(mapped, { ...params, limit });
  }

  /**
   * Wake unloaded tabs so `tab_read` can reach them — the bridge's one action
   * tool, and the only place it navigates anything. It ships default-off, and a
   * reload is all it will ever do: the URL comes from a tab the user opened, not
   * from the agent.
   *
   * Batched rather than one-per-call because loading is dominated by the network
   * wait, and a triage run has tens of discarded survivors. Loads run a few at a
   * time under a wall-clock deadline, and every tab in the request gets an
   * outcome — a call that ran out of budget still reports what it managed.
   */
  private async tabsLoad(raw: unknown): Promise<TabsLoadResult> {
    const { tabIds } = parseTabsLoadParams(raw);
    if (!this.deps.getSettings().bridgeAllowTabLoad) {
      fail(
        "not-enabled",
        'Loading tabs is switched off. The user can turn it on in Tabglutton\'s settings, under Agent bridge → "Let agents load unloaded tabs".',
      );
    }

    const deadline = Date.now() + TABS_LOAD_DEADLINE_MS;
    const outcomes: TabLoadOutcome[] = Array.from({ length: tabIds.length });
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < tabIds.length; i = next++) {
        const tabId = tabIds[i];
        const budget = Math.min(deadline - Date.now(), TAB_LOAD_TIMEOUT_MS);
        outcomes[i] =
          budget > 0
            ? await this.loadOne(tabId, budget)
            : {
                tabId,
                status: "pending",
                reason: `Not reached within the ${TABS_LOAD_DEADLINE_MS}ms budget for one tabs_load call. Call again for this tab.`,
              };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TABS_LOAD_CONCURRENCY, tabIds.length) }, worker),
    );

    return {
      tabs: outcomes,
      ready: outcomes.filter((o) => o.status === "ready").length,
      pending: outcomes.filter((o) => o.status === "pending").length,
      failed: outcomes.filter((o) => o.status === "failed").length,
    };
  }

  /**
   * One tab, never throwing: a batch reports per-tab outcomes, so a tab that
   * cannot be loaded must not take the other nineteen down with it.
   */
  private async loadOne(tabId: number, timeoutMs: number): Promise<TabLoadOutcome> {
    const tab = await tryGetTab(tabId);
    if (!tab) {
      return { tabId, status: "failed", reason: missingTabReason(`No tab with id ${tabId}.`) };
    }
    const url = tabUrl(tab) ?? "";
    if (!isHttpUrl(url)) {
      return { tabId, status: "failed", url, reason: "Only http and https pages can be loaded." };
    }
    // Already live: loading it again would re-fetch a page the user may have
    // state in, which is well outside what waking a discarded tab authorises.
    if (!tab.discarded && tab.status === "complete") return { tabId, status: "ready", url };

    try {
      await this.deps.load(tabId, timeoutMs);
      return { tabId, status: "ready", url };
    } catch (err) {
      // A wait that ended badly is not proof the tab did not load, so ask the
      // browser before answering. It settles two cases the wait cannot see: a
      // page that finished right at the timeout boundary, and — the one that
      // would otherwise make this tool useless on Chrome — a tab whose id
      // changed under us, since the completion event then names an id our
      // listener is not watching for. The second reads back as a vanished tab,
      // which STALE_ID_HINT already knows how to explain.
      return await this.verifyLoaded(tabId, url, errorMessage(err));
    }
  }

  private async verifyLoaded(
    tabId: number,
    url: string,
    waitError: string,
  ): Promise<TabLoadOutcome> {
    const tab = await tryGetTab(tabId);
    if (!tab) {
      return { tabId, status: "failed", url, reason: missingTabReason(`${waitError}.`) };
    }
    if (!tab.discarded && tab.status === "complete") return { tabId, status: "ready", url };
    // Pending, not failed: the reload is usually still running and the tab is
    // often readable a moment later, so the agent's move is to try again.
    return { tabId, status: "pending", url, reason: waitError };
  }

  /**
   * The tab a read or a clip can actually act on: an id that still resolves, an
   * http(s) page, and a document that is loaded. Separate from `readTab` because
   * Zotero routing has to clear the same three before it asks the Connector
   * anything — the Connector's answer for a discarded tab is a two-second
   * detection poll ending in "still detecting", where the honest reply is the
   * one already written here.
   */
  private async loadedTab(tabId: number): Promise<browser.tabs.Tab> {
    const tab = await getTabOrFail(tabId);
    // Deliberately the committed `tab.url`, not the `tabUrl` fallback: a tab
    // still resolving its `pendingUrl` has no document to extract, and `wake` is
    // false here, so there is nothing to wait for either.
    if (!isHttpUrl(tab.url)) {
      fail("unsupported", "Only http and https pages can be read.");
    }
    if (tab.discarded) {
      fail(
        "tab-discarded",
        `Tab ${tabId} is unloaded, so its content cannot be read. Wake it with tabs_load and read it again; if that reports the capability is off, the tab needs a manual load.`,
      );
    }
    return tab;
  }

  /**
   * What the thin-content guard means depends on who asked, so the caller says.
   *
   * `tab_clip` refuses: it would file a junk note and close the tab, which is
   * #49 exactly. `tab_read` does not: it files nothing and closes nothing, so
   * refusing would cost an agent every legitimately short page — a
   * one-paragraph issue, a link post, a docs page that is mostly code — with no
   * override, in order to withhold text the agent can judge for itself. It takes
   * the text and the label instead.
   */
  private thinRead(
    guarded: ThinClipVerdict & { payload: ClipPayload },
    refuseThin: boolean,
  ): { payload: ClipPayload; guarded: ThinClipVerdict } {
    if (refuseThin) fail(guarded.reason, guarded.message);
    return { payload: guarded.payload, guarded };
  }

  /**
   * Reads through the same Defuddle clipper the popup uses. Discarded tabs
   * cannot host a content script and are reported with a distinct code so the
   * agent can say "needs manual load" instead of retrying.
   */
  private async readTab(
    tabId: number,
    { refuseThin }: { refuseThin: boolean },
  ): Promise<{ payload: ClipPayload; guarded?: ThinClipVerdict }> {
    await this.loadedTab(tabId);
    let result = await this.deps.extract(tabId);
    // Ahead of everything below, because none of it applies: the injection ran
    // and the page answered, so site access is plainly held and there is no
    // second document arriving to make a retry worth its 250ms. Both of those
    // checks would name a problem this page does not have and hand the agent a
    // remedy that cannot fix it. Reached before `tabClip` gets to its close, so
    // a refused clip leaves the tab open — the disposition #49 asks for.
    if (result.guarded) return this.thinRead(result.guarded, refuseThin);
    if (!result.ok || !result.payload) {
      // Asked only once extraction has already failed, so a read costs no extra
      // IPC in the normal case. Site access is optional on Chrome and only a
      // click can request it, which the bridge does not have — so an agent whose
      // user has never clipped from the popup would otherwise meet this as an
      // opaque injection error with no stated remedy.
      await requireClipAccess();

      // Firefox returned this error on the first read after a discarded tab
      // finished `tabs_load`, despite the grant above being held throughout,
      // and an identical call moments later succeeded. A page still swapping
      // documents is the likeliest of the causes the engine folds together, so
      // pause once — but report the engine's own words either way, since one of
      // those causes is a page that will never be readable.
      if (isNoInjectionTargetError(result.error)) {
        await delay(TRANSIENT_EXTRACT_RETRY_MS);
        result = await this.deps.extract(tabId);
        // The retry goes through the same guard, and this is the likeliest way
        // to meet one: a challenge swapping documents is exactly what makes the
        // first attempt report no injection target. Checked again rather than
        // left to fall through, where it would earn "extract-failed" plus a hint
        // insisting the page can never be read — both wrong, and the hint
        // contradicts the message it would be glued to.
        if (result.guarded) return this.thinRead(result.guarded, refuseThin);
        if (result.ok && result.payload) return { payload: result.payload };
        fail(
          "extract-failed",
          `${result.error ?? "Extraction failed."} ${NO_INJECTION_TARGET_HINT}`,
        );
      }

      fail("extract-failed", result.error ?? "Extraction failed.");
    }
    return { payload: result.payload };
  }

  private async tabRead(raw: unknown): Promise<TabReadResult> {
    const { tabId } = parseTabReadParams(raw);
    const { payload, guarded } = await this.readTab(tabId, { refuseThin: false });
    return {
      tabId,
      title: payload.title,
      url: payload.url,
      author: payload.author,
      published: payload.published,
      description: payload.description,
      site: payload.site,
      wordCount: payload.wordCount,
      markdown: payload.markdown,
      ...(guarded
        ? { thin: { chars: guarded.chars, challengeSuspect: guarded.challengeSuspect } }
        : {}),
    };
  }

  /**
   * File a tab the way the popup's Devour would, into whichever destination the
   * user chose. The three are not interchangeable in what they can promise: a
   * download is confirmed on disk and a Connector save is confirmed by Zotero
   * before this returns, while the `obsidian://` handoff is unobservable from
   * here and is left for Gullet to confirm.
   */
  private async tabClip(raw: unknown): Promise<TabClipResult> {
    const params = parseTabClipParams(raw);
    const settings = this.deps.getSettings();

    // Zotero routing runs first, and runs the *same* routing the popup's Devour
    // does. An agent clearing a backlog for a user who routes papers to Zotero
    // must not quietly file them into Obsidian instead
    // ([#50](https://github.com/mlsimon734/tabglutton/issues/50)) — a
    // destination the user chose is the user's, whichever surface the clip came
    // from. The one thing that outranks it is an explicit `vault`, which is a
    // destination the caller asked for outright rather than a setting.
    const routed = params.vault ? null : await this.zoteroClip(params.tabId, settings);
    if (routed) return this.closeAfterClip(params, routed);

    const destination = clipDestinationFor(settings, params.vault);
    // An override stands alone: it is the destination the caller named, so a
    // vault the user has not configured is not a reason to refuse. Resolved
    // *before* `readTab` — a clip with nowhere to go must not spend a Defuddle
    // injection, and on a page the engine keeps closed to extensions the
    // injection failure would arrive first and hand the agent
    // NO_INJECTION_TARGET_HINT's retry advice for a problem a retry cannot fix.
    const vault = destination === "obsidian" ? (params.vault ?? settings.obsidianVault.trim()) : "";
    if (destination === "obsidian" && !vault) {
      // Named against what the user has actually configured: with routing on
      // they do have a working destination, just not one this tab qualified for,
      // and the popup's own message says so rather than reading as "nothing is
      // set up".
      fail(
        "vault-missing",
        settings.zoteroRoutingEnabled
          ? "This tab was not an academic Zotero item, no Obsidian vault is configured in Tabglutton's settings, and clips are not set to save as files either."
          : "No Obsidian vault is configured in Tabglutton's settings, and clips are not set to save as files either.",
      );
    }

    const { payload } = await this.readTab(params.tabId, { refuseThin: true });
    const rule = pickRule(payload.url);
    const content = markdownForClip(payload);

    const filed =
      destination === "file"
        ? await this.fileClip(params.tabId, payload, rule, content, settings)
        : await this.obsidianClip(params.tabId, payload, rule, content, settings, vault);
    return this.closeAfterClip(params, filed);
  }

  /**
   * Honour `close` once the tab has been filed somewhere. Shared by all three
   * destinations, because the reason a close may not fail the call is the same
   * for each: the item is already saved, so a close that does not happen is a
   * partial success and a thrown `tab_clip` would only provoke a duplicate.
   */
  private async closeAfterClip<T extends TabClipResult>(
    params: TabClipParams,
    filed: T,
  ): Promise<T> {
    if (!params.close) return filed;

    const batchId = await this.recordForClose(params.tabId);
    if (batchId === null) return filed;

    try {
      await browser.tabs.remove(params.tabId);
    } catch (err) {
      console.warn("[tabglutton] bridge close-after-clip failed", params.tabId, err);
      // The record was written first, so a rejection here can leave a batch
      // describing a tab that is still open — and an id-less `undo_close` takes
      // the newest batch, making that orphan the very thing the next undo
      // reopens. But a rejection is not proof the tab survived either (a Chrome
      // id rollover rejects over a tab that is merely renumbered), so ask.
      if (await tabExists(params.tabId)) {
        await reconcileBatch(batchId, []);
        return filed;
      }
    }
    return { ...filed, closed: true, batchId };
  }

  /**
   * The Zotero destination: hand the tab to the Connector, which owns the page
   * and its translator state. `null` when the tab is not one Zotero should take
   * — routing off, or a page the Connector does not read as scholarly — and the
   * caller falls through to the note destinations.
   *
   * Nothing is extracted: a paper needs neither Defuddle nor Tabglutton's host
   * permission, exactly as in Devour's phase 1. The result is `confirmedBy:
   * "browser"` because a Connector save that resolved is the closest anything in
   * the browser gets to proof, and the popup already closes a routed tab on it.
   *
   * Same routing function as the popup, but **not** the same precondition, and
   * the difference is a real one: Devour wakes a tab before asking, and this
   * cannot — waking is `tabs_load`'s own gated act. A discarded tab is therefore
   * refused outright rather than asked about, but a tab that is loaded and still
   * navigating is asked, and the Connector can answer `ready` with no translator
   * for it. That verdict is "not a paper", so such a tab files as a note. The
   * detection poll makes the window narrow rather than absent.
   */
  private async zoteroClip(tabId: number, settings: Settings): Promise<ZoteroClipResult | null> {
    if (!settings.zoteroRoutingEnabled) return null;
    // Ahead of the Connector, not after it: routing asks about a live document,
    // and a discarded tab would otherwise spend the detection poll to arrive at
    // an answer this already has a remedy for.
    const tab = await this.loadedTab(tabId);

    let routed: boolean;
    try {
      routed = await this.deps.routesToZotero(tabId);
    } catch (err) {
      // Never a fallthrough to Obsidian. The user asked for papers to go to
      // Zotero, and "the Connector could not say whether this is one" is not
      // permission to file it somewhere else — the popup fails the tab here too.
      fail("zotero-failed", `${errorMessage(err)} ${ZOTERO_UNREACHABLE_HINT}`);
    }
    if (!routed) return null;

    try {
      await this.deps.saveToZotero(tabId);
    } catch (err) {
      fail("zotero-failed", errorMessage(err));
    }

    return {
      tabId,
      title: tab.title ?? "",
      url: tab.url ?? "",
      destination: "zotero",
      confirmedBy: "browser",
      closed: false,
    };
  }

  /**
   * The Obsidian destination: compose the note, hand it to the OS, and report
   * the path it was *asked* to write. Nothing here can confirm it arrived — a
   * refused launch looks exactly like a taken one (docs/ENGINEERING.md §Clip
   * verification) — hence `confirmedBy: "nobody"` until Gullet says otherwise.
   */
  private async obsidianClip(
    tabId: number,
    payload: ClipPayload,
    rule: SiteRule | null,
    content: string,
    settings: Settings,
    vault: string,
  ): Promise<ObsidianClipResult> {
    // Taken from the request rather than derived again, so the path reported to
    // the agent is by construction the one the `obsidian://` URL was built from.
    const file = await this.handoff(async () => {
      const request = await resolveClipRequest(
        payload,
        vault,
        content,
        rule,
        settings.clipMode,
        settings.clippingsBaseFolder,
        await getFilePlatformOnce(),
        (text) => this.deps.copyToClipboardViaTab(tabId, text),
      );
      await this.deps.openObsidianUrl(request.url);
      return request.file;
    });

    // Launched, never verified: this is the destination whose handoff cannot be
    // observed from here. Gullet raises it with `clip_confirm` if the note
    // turns up in the vault.
    await this.noteClip(payload.url, "launched", "obsidian");

    return {
      tabId,
      title: payload.title,
      url: payload.url,
      destination: "obsidian",
      file,
      vault,
      contentHash: await clipContentHash(content),
      confirmedBy: "nobody",
      closed: false,
    };
  }

  /**
   * Note one clip in the clip memory. Never throws — `recordClip` swallows its
   * own failures, and a filed note must not be reported as a failed clip
   * because remembering it did not work.
   */
  private async noteClip(url: string, state: ClipMark, destination: ClipTarget): Promise<void> {
    await recordClip({ url, state, destination }, normalizeOptsFrom(this.deps.getSettings()));
  }

  /**
   * The file destination: the same note, written to the download folder.
   *
   * Usually the one clip that comes back already confirmed — the browser was
   * seen to complete the download — and Gullet then has nothing to add. When
   * the browser cannot say (its record of the download was already erased, see
   * `settled`), that is reported as `nobody` rather than dressed up as proof:
   * an erased record is equally consistent with an interrupted write, and this
   * destination must not be allowed to close a tab on weaker evidence than the
   * one whose whole verification layer exists because it has none.
   *
   * Not on `handoff` — that queue paces an external app reading the OS
   * clipboard, which a download touches neither of — but on a queue all the
   * same. Bridge requests are served concurrently, and `conflictAction:
   * "uniquify"` is resolved against the filesystem when a download starts, so
   * two clips of the same page racing could both be handed the same free name.
   * Shared browser state gets a queue, not a hope (AGENTS.md §Concurrency).
   */
  private async fileClip(
    tabId: number,
    payload: ClipPayload,
    rule: SiteRule | null,
    content: string,
    settings: Settings,
  ): Promise<FileClipResult> {
    const path = clipDownloadPath(
      payload,
      rule,
      settings.clippingsBaseFolder,
      await getFilePlatformOnce(),
    );
    let saved: SavedClipFile;
    try {
      saved = await this.fileQueue(() => saveClipFile(path, content));
    } catch (err) {
      // `downloads` is optional and revocable from the browser's own add-on UI,
      // and the bridge has no gesture with which to ask for it back. Checked
      // only once the write has already failed, like `requireClipAccess`: the
      // clip that works pays no extra IPC for it.
      if ((await downloadsGrant()) === "missing") {
        fail(
          "not-enabled",
          "Tabglutton no longer has permission to save downloads, so clips cannot be written as files. " +
            `Ask the user to restore it: ${DOWNLOADS_REMEDY}`,
        );
      }
      fail(
        "internal",
        `The clip could not be written to the download folder: ${errorMessage(err)}`,
      );
    }

    // The browser watched this download reach `state: "complete"`, which is the
    // same evidence `confirmedBy: "browser"` rests on and the strongest anything
    // in the extension can produce. An erased record proves nothing, so that
    // case is remembered as `launched` — the file may well be there, and this is
    // exactly the distinction the two states exist to keep.
    await this.noteClip(payload.url, saved.confirmed ? "verified" : "launched", "file");

    return {
      tabId,
      title: payload.title,
      url: payload.url,
      destination: "file",
      // Both absent together: no record to read means neither proof nor path.
      ...(saved.path !== undefined ? { file: saved.path } : {}),
      confirmedBy: saved.confirmed ? "browser" : "nobody",
      closed: false,
    };
  }

  /**
   * Log one tab as closed before it is, returning null if it cannot be logged.
   *
   * Same invariant `tabs_close` holds: nothing is closed that the undo log could
   * not put back. A tab with no committed URL is also a tab that navigated away
   * between the read and here, which is its own reason to leave it alone — it is
   * no longer the page that was filed.
   */
  private async recordForClose(tabId: number): Promise<string | null> {
    try {
      const entry = toClosedEntry(await browser.tabs.get(tabId));
      if (!entry) throw new Error("the tab has no committed URL to record");
      return await recordClosed([entry]);
    } catch (err) {
      console.warn("[tabglutton] bridge close-after-clip not recordable", tabId, err);
      return null;
    }
  }

  private async tabsClose(raw: unknown): Promise<TabsCloseResult> {
    const { tabIds } = parseTabsCloseParams(raw);
    // One listing rather than a `tabs.get` per id: a triage run closes tabs by
    // the hundred (docs/BRIDGE.md sizes one at ~180), and that many IPC round-trips
    // just to build undo entries is the bulk of the call.
    const byId = new Map((await queryAllTabs()).filter(hasTabId).map((t) => [t.id, t] as const));
    const missing = tabIds.filter((id) => !byId.has(id));
    const live = tabIds.map((id) => byId.get(id)).filter((t) => t !== undefined);
    if (live.length === 0) failMissingTab("None of the given tab ids exist.");

    // Paired rather than filtered, so a tab that cannot be recorded is left
    // standing instead of being closed off the end of the undo log. A tab whose
    // navigation has not committed has no URL on either engine (`tabUrl` covers
    // Chrome's `pendingUrl`; nothing exposes Gecko's), so closing it would be
    // the one close `undo_close` could never reverse. Reported as skipped: the
    // window is milliseconds wide, and a re-list gets a URL.
    const closable: Array<{ id: number; entry: ClosedTabEntry }> = [];
    const skipped: number[] = [];
    for (const tab of live) {
      const entry = toClosedEntry(tab);
      if (entry) closable.push({ id: tab.id, entry });
      else skipped.push(tab.id);
    }
    if (closable.length === 0) {
      fail(
        "not-found",
        "None of the given tabs have committed a URL yet, so closing them could not be undone. They are still loading — re-run tabs_list and close them again.",
      );
    }

    // Record before removing: a crash mid-remove must not lose the trail.
    const batchId = await recordClosed(closable.map((c) => c.entry));
    // A batch removal can close some and refuse the rest — see `removeTabs`. So
    // the report and the batch are both built from what the browser did, not
    // from what was asked: `closed` still equals `entries.length`, and the tabs
    // left standing join `skipped` instead of sitting in the log as an undo that
    // would duplicate them.
    const gone = await removeTabs(closable.map((c) => c.id));
    const closed = closable.filter((c) => gone.has(c.id));
    if (closed.length !== closable.length) {
      skipped.push(...closable.filter((c) => !gone.has(c.id)).map((c) => c.id));
      await reconcileBatch(
        batchId,
        closed.map((c) => c.entry),
      );
    }
    if (closed.length === 0) {
      fail(
        "internal",
        `The browser refused to close any of the ${closable.length} tab(s). Nothing was closed and nothing was recorded; re-run tabs_list for current ids and try again.`,
      );
    }

    return {
      closed: closed.length,
      batchId,
      entries: closed.map((c) => c.entry),
      // Present only when there is something to say, so the common case stays
      // compact in a model's context.
      ...(missing.length > 0 ? { missing } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
    };
  }

  private async undoClose(raw: unknown): Promise<UndoCloseResult> {
    const params = parseUndoCloseParams(raw);
    // The whole undo runs under the log's lock, restores included — see
    // `withUndoLog`. Reading, restoring, and writing back are one transaction
    // as far as any concurrent close is concerned.
    return withUndoLog(async () => {
      const batch = findBatch(await readUndoLog(), params.batchId);
      if (!batch) {
        fail(
          "not-found",
          params.batchId
            ? `No close batch with id ${params.batchId}.`
            : "Nothing to undo — the close log is empty.",
        );
      }

      // Ascending index within each window: inserting a low index *after* a high
      // one shifts the tab already sitting there, so the batch would come back in
      // an order that does not match what was recorded.
      const ordered = [...batch.entries].sort(
        (a, b) => a.windowId - b.windowId || a.index - b.index,
      );
      const windows = await LiveWindows.load();
      const failed: ClosedTabEntry[] = [];
      for (const entry of ordered) {
        try {
          await restoreEntry(entry, windows);
        } catch (err) {
          console.warn("[tabglutton] bridge undo failed for", entry.url, err);
          failed.push(entry);
        }
      }

      // Only what actually came back leaves the log. Dropping a failed entry
      // would put the tab beyond every retry, which is the one thing undo exists
      // to prevent. Re-read rather than reusing the copy above: restoring is
      // slow, and the lock orders concurrent closes against us but does not stop
      // this process's own view from going stale across those awaits.
      await writeUndoLog(retainEntries(await readUndoLog(), batch.id, failed));
      return { batchId: batch.id, restored: ordered.length - failed.length, failed: failed.length };
    });
  }

  /**
   * The gap is paid inside the queued task, not between tasks, so the next clip
   * cannot start launching `obsidian://` until this one's pacing has elapsed.
   */
  private handoff<T>(task: () => Promise<T>): Promise<T> {
    return this.handoffQueue(async () => {
      const result = await task();
      await delay(OBSIDIAN_HANDOFF_GAP_MS);
      return result;
    });
  }
}
