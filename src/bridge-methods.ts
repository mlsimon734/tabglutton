// Extension-side implementations of the five bridge methods (see docs/BRIDGE.md).
// Everything that touches the real page — extraction, the Obsidian handoff — is
// injected as a dependency by background.ts, which already owns that machinery;
// this module only adds the tab/undo-log surface the agent sees.
//
// Trust boundary: read + file + close, nothing else. No navigation, no
// scripting beyond the existing Defuddle clipper, and every close is logged
// before it happens.

import { markdownForClip, OBSIDIAN_HANDOFF_GAP_MS, resolveClipRequest } from "./clip-format.js";
import type { ClipPayload } from "./clip-format.js";
import {
  BridgeRequestError,
  errorMessage,
  parseTabClipParams,
  parseTabReadParams,
  parseTabsCloseParams,
  parseTabsListParams,
  selectTabs,
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
import { getFilePlatformOnce } from "./platform.js";
import { createTaskQueue, delay } from "./serialize.js";
import { pickRule } from "./site-rules.js";
import type { Settings } from "./storage.js";
import { CLIP_ORIGINS, hasOrigins } from "./permissions.js";
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
    const mapped = tabs.map(toBridgeTab).filter((t): t is BridgeTab => t !== null);
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
      // Asked only once extraction has already failed, so a read costs no extra
      // IPC in the normal case. Site access is optional on Chrome and only a
      // click can request it, which the bridge does not have — so an agent whose
      // user has never clipped from the popup would otherwise meet this as an
      // opaque injection error with no stated remedy.
      if (!(await hasOrigins(CLIP_ORIGINS))) {
        fail(
          "not-enabled",
          "Tabglutton has no access to page contents, so tabs cannot be read or clipped. " +
            "Ask the user to open the Tabglutton popup and run Devour once — that is where " +
            "the browser asks for the permission.",
        );
      }
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
    // An override stands alone: it is the destination the user named, so a
    // vault they have not configured is not a reason to refuse. `vault-missing`
    // only means "nowhere to file this", which an override answers.
    const vault = params.vault ?? settings.obsidianVault.trim();
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
        await getFilePlatformOnce(),
        (text) => this.deps.copyToClipboardViaTab(params.tabId, text),
      );
      await this.deps.openObsidianUrl(request.url);
      return request.file;
    });

    const filed = { tabId: params.tabId, title: payload.title, url: payload.url, file, vault };
    if (!params.close) return { ...filed, closed: false };

    // Nothing past here fails the call: the note is already in Obsidian, so a
    // close that does not happen is a partial success, not a failure.
    const batchId = await this.recordForClose(params.tabId);
    if (batchId === null) return { ...filed, closed: false };

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
        return { ...filed, closed: false };
      }
    }
    return { ...filed, closed: true, batchId };
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
