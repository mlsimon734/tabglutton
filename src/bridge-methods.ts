// Extension-side implementations of the five bridge methods (see BRIDGE.md).
// Everything that touches the real page — extraction, the Obsidian handoff — is
// injected as a dependency by background.ts, which already owns that machinery;
// this module only adds the tab/undo-log surface the agent sees.
//
// Trust boundary: read + file + close, nothing else. No navigation, no
// scripting beyond the existing Defuddle clipper, and every close is logged
// before it happens.

import {
  delay,
  markdownForClip,
  OBSIDIAN_HANDOFF_GAP_MS,
  resolveClipRequest,
} from "./clip-format.js";
import type { ClipPayload } from "./clip-format.js";
import {
  BridgeRequestError,
  errorMessage,
  parseTabClipParams,
  parseTabReadParams,
  parseTabsCloseParams,
  parseTabsListParams,
  parseTabsLoadParams,
  parseUndoCloseParams,
  TABS_LOAD_DEADLINE_MS,
  type BridgeErrorCode,
  type BridgeMethod,
  type BridgeTab,
  type ClosedTabEntry,
  type TabClipResult,
  type TabLoadOutcome,
  type TabReadResult,
  type TabsCloseResult,
  type TabsListResult,
  type TabsLoadResult,
  type UndoCloseResult,
} from "./bridge-protocol.js";
import { pickRule } from "./site-rules.js";
import type { Settings } from "./storage.js";
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

/** The only way to raise "no such tab id", so the hint above cannot be forgotten. */
function failMissingTab(message: string): never {
  fail("not-found", `${message} ${STALE_ID_HINT}`);
}

/**
 * Every lookup that should fail the whole call goes through here, so the hint
 * cannot be attached to some of them and not others. `tab_clip`'s close step is
 * deliberately not one of these — the note is already filed by then.
 */
async function getTabOrFail(tabId: number): Promise<browser.tabs.Tab> {
  try {
    return await browser.tabs.get(tabId);
  } catch {
    failMissingTab(`No tab with id ${tabId}.`);
  }
}

export interface BridgeExtractResult {
  ok: boolean;
  payload?: ClipPayload;
  error?: string;
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

function fail(code: BridgeErrorCode, message: string): never {
  throw new BridgeRequestError(code, message);
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
function isHttpUrl(url: string | undefined): boolean {
  return url?.startsWith("http://") === true || url?.startsWith("https://") === true;
}

function toBridgeTab(tab: browser.tabs.Tab): BridgeTab | null {
  const url = tabUrl(tab);
  if (tab.id === undefined || url === undefined) return null;
  const bridgeTab: BridgeTab = {
    id: tab.id,
    title: tab.title ?? "",
    url,
    lastAccessed: tab.lastAccessed ?? 0,
    discarded: tab.discarded ?? false,
    pinned: tab.pinned,
    active: tab.active,
    windowId: tab.windowId ?? -1,
    index: tab.index,
  };
  // Chrome has no `tab.hidden`; omitting the key (rather than sending false)
  // keeps "no workspace signal here" distinguishable from "visible".
  if (!IS_CHROME && tab.hidden !== undefined) bridgeTab.hidden = tab.hidden;
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

  /** A window of this privacy context, opening one if the last was closed. */
  async windowFor(incognito: boolean): Promise<number> {
    const existing = this.preferred.get(incognito);
    if (existing !== undefined) return existing;
    const created = await browser.windows.create({ incognito });
    if (created.id === undefined) {
      throw new Error(`Could not open a ${incognito ? "private" : "normal"} window.`);
    }
    this.preferred.set(incognito, created.id);
    return created.id;
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
  await browser.tabs.create({
    url: entry.url,
    windowId: await windows.windowFor(incognito),
    active: false,
  });
}

async function recordClosed(entries: ClosedTabEntry[]): Promise<string> {
  const batch: UndoBatch = { id: crypto.randomUUID(), closedAt: Date.now(), entries };
  await writeUndoLog(appendBatch(await readUndoLog(), batch));
  return batch.id;
}

export class BridgeMethodRunner {
  private readonly deps: BridgeMethodDeps;
  /** Serializes Obsidian handoffs; the OS clipboard is a global resource. */
  private handoffQueue: Promise<void> = Promise.resolve();

  constructor(deps: BridgeMethodDeps) {
    this.deps = deps;
  }

  async run(method: BridgeMethod, params: unknown): Promise<unknown> {
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
    }
  }

  private async tabsList(raw: unknown): Promise<TabsListResult> {
    const params = parseTabsListParams(raw);
    const tabs =
      params.scope === "current-window"
        ? await browser.tabs.query({ currentWindow: true })
        : await queryAllTabs();
    const mapped = tabs
      .map(toBridgeTab)
      .filter((t): t is BridgeTab => t !== null)
      .filter((t) => params.includeHidden || t.hidden !== true);
    mapped.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    return { tabs: mapped };
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
    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return { tabId, status: "failed", reason: `No tab with id ${tabId}. ${STALE_ID_HINT}` };
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
    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return { tabId, status: "failed", url, reason: `${waitError}. ${STALE_ID_HINT}` };
    }
    if (!tab.discarded && tab.status === "complete") return { tabId, status: "ready", url };
    // Pending, not failed: the reload is usually still running and the tab is
    // often readable a moment later, so the agent's move is to try again.
    return { tabId, status: "pending", url, reason: waitError };
  }

  /**
   * Reads through the same Defuddle clipper the popup uses. Discarded tabs
   * cannot host a content script and are reported with a distinct code so the
   * agent can say "needs manual load" instead of retrying.
   */
  private async readTab(tabId: number): Promise<ClipPayload> {
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
    const result = await this.deps.extract(tabId);
    if (!result.ok || !result.payload) {
      fail("extract-failed", result.error ?? "Extraction failed.");
    }
    return result.payload;
  }

  private async tabRead(raw: unknown): Promise<TabReadResult> {
    const { tabId } = parseTabReadParams(raw);
    const payload = await this.readTab(tabId);
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
    };
  }

  private async tabClip(raw: unknown): Promise<TabClipResult> {
    const params = parseTabClipParams(raw);
    const settings = this.deps.getSettings();
    const vault = settings.obsidianVault.trim();
    if (!vault) {
      fail("vault-missing", "No Obsidian vault is configured in Tabglutton's settings.");
    }

    const payload = await this.readTab(params.tabId);
    const rule = pickRule(payload.url);
    const content = markdownForClip(payload);

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
        (text) => this.deps.copyToClipboardViaTab(params.tabId, text),
      );
      await this.deps.openObsidianUrl(request.url);
      return request.file;
    });

    const filed = { tabId: params.tabId, title: payload.title, url: payload.url, file };
    if (!params.close) return { ...filed, closed: false };

    let batchId: string | undefined;
    try {
      const tab = await browser.tabs.get(params.tabId);
      const entry = toClosedEntry(tab);
      if (entry) batchId = await recordClosed([entry]);
      await browser.tabs.remove(params.tabId);
    } catch (err) {
      // The note is already in Obsidian, so this is a partial success, not a
      // failure: report the clip and let the tab stand.
      console.warn("[tabglutton] bridge close-after-clip failed", params.tabId, err);
      return { ...filed, closed: false };
    }
    return { ...filed, closed: true, ...(batchId ? { batchId } : {}) };
  }

  private async tabsClose(raw: unknown): Promise<TabsCloseResult> {
    const { tabIds } = parseTabsCloseParams(raw);
    // One listing rather than a `tabs.get` per id: a triage run closes tabs by
    // the hundred (BRIDGE.md sizes one at ~180), and that many IPC round-trips
    // just to build undo entries is the bulk of the call.
    const byId = new Map((await queryAllTabs()).filter(hasTabId).map((t) => [t.id, t] as const));
    const live = tabIds.map((id) => byId.get(id)).filter((t) => t !== undefined);
    if (live.length === 0) failMissingTab("None of the given tab ids exist.");

    const entries = live.map(toClosedEntry).filter((e): e is ClosedTabEntry => e !== null);
    // Record before removing: a crash mid-remove must not lose the trail.
    const batchId = await recordClosed(entries);
    await browser.tabs.remove(live.map((t) => t.id));
    return { closed: live.length, batchId, entries };
  }

  private async undoClose(raw: unknown): Promise<UndoCloseResult> {
    const params = parseUndoCloseParams(raw);
    const log = await readUndoLog();
    const batch = findBatch(log, params.batchId);
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
    const ordered = [...batch.entries].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
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
    // to prevent. Re-read first: restoring is slow, and a close recorded while
    // it ran must not be clobbered by our stale copy of the log.
    await writeUndoLog(retainEntries(await readUndoLog(), batch.id, failed));
    return { batchId: batch.id, restored: ordered.length - failed.length, failed: failed.length };
  }

  private handoff<T>(task: () => Promise<T>): Promise<T> {
    const next = this.handoffQueue.then(async () => {
      const result = await task();
      await delay(OBSIDIAN_HANDOFF_GAP_MS);
      return result;
    });
    // Keep the chain alive even if a handoff rejects, so one bad clip does not
    // wedge every later one. Discards the value as well as the error — the
    // queue only tracks ordering.
    this.handoffQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}
