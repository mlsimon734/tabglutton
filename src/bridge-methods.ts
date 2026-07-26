// Extension-side implementations of the five bridge methods (see BRIDGE.md).
// Everything that touches the real page — extraction, the Obsidian handoff — is
// injected as a dependency by background.ts, which already owns that machinery;
// this module only adds the tab/undo-log surface the agent sees.
//
// Trust boundary: read + file + close, nothing else. No navigation, no
// scripting beyond the existing Defuddle clipper, and every close is logged
// before it happens.

import { clipFilePath, markdownForClip, obsidianClipRequest } from "./clip-format.js";
import type { ClipPayload } from "./clip-format.js";
import {
  BridgeRequestError,
  parseTabClipParams,
  parseTabReadParams,
  parseTabsCloseParams,
  parseTabsListParams,
  parseUndoCloseParams,
  type BridgeMethod,
  type BridgeTab,
  type ClosedTabEntry,
  type TabClipResult,
  type TabReadResult,
  type TabsCloseResult,
  type TabsListResult,
  type UndoCloseResult,
} from "./bridge-protocol.js";
import { pickRule } from "./site-rules.js";
import type { Settings } from "./storage.js";
import { IS_CHROME } from "./target.js";
import {
  appendBatch,
  findBatch,
  parseUndoLog,
  removeBatch,
  UNDO_LOG_KEY,
  type UndoBatch,
} from "./undo-log.js";

export interface BridgeExtractResult {
  ok: boolean;
  payload?: ClipPayload;
  error?: string;
}

export interface BridgeMethodDeps {
  getSettings: () => Settings;
  /**
   * Extract the tab through Defuddle WITHOUT waking it. `tab_load` is a v1.1
   * tool that ships default-off, so v1 must never navigate on the agent's
   * behalf — a discarded tab is reported as such instead.
   */
  extract: (tabId: number) => Promise<BridgeExtractResult>;
  openObsidianUrl: (url: string) => Promise<void>;
  copyToClipboardViaTab: (tabId: number, text: string) => Promise<boolean>;
}

/** Minimum gap between `obsidian://` launches, matching the Devour cockpit. */
const OBSIDIAN_HANDOFF_GAP_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(code: ConstructorParameters<typeof BridgeRequestError>[0], message: string): never {
  throw new BridgeRequestError(code, message);
}

function toBridgeTab(tab: browser.tabs.Tab): BridgeTab | null {
  if (tab.id === undefined || tab.url === undefined) return null;
  const bridgeTab: BridgeTab = {
    id: tab.id,
    title: tab.title ?? "",
    url: tab.url,
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
  if (!tab.url) return null;
  return {
    url: tab.url,
    title: tab.title ?? "",
    pinned: tab.pinned,
    windowId: tab.windowId ?? -1,
    index: tab.index,
  };
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
   * Reads through the same Defuddle clipper the popup uses. Discarded tabs
   * cannot host a content script and are reported with a distinct code so the
   * agent can say "needs manual load" instead of retrying.
   */
  private async readTab(tabId: number): Promise<{ tab: browser.tabs.Tab; payload: ClipPayload }> {
    let tab: browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      fail("not-found", `No tab with id ${tabId}.`);
    }
    if (!tab.url?.startsWith("http://") && !tab.url?.startsWith("https://")) {
      fail("unsupported", "Only http and https pages can be read.");
    }
    if (tab.discarded) {
      fail(
        "tab-discarded",
        `Tab ${tabId} is unloaded, so its content cannot be read. Needs manual load.`,
      );
    }
    const result = await this.deps.extract(tabId);
    if (!result.ok || !result.payload) {
      fail("extract-failed", result.error ?? "Extraction failed.");
    }
    return { tab, payload: result.payload };
  }

  private async tabRead(raw: unknown): Promise<TabReadResult> {
    const { tabId } = parseTabReadParams(raw);
    const { payload } = await this.readTab(tabId);
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

    const { payload } = await this.readTab(params.tabId);
    const rule = pickRule(payload.url);
    const content = markdownForClip(payload);
    const file = clipFilePath(payload, rule, settings.clippingsBaseFolder);

    await this.handoff(async () => {
      let request = obsidianClipRequest(
        payload,
        vault,
        content,
        rule,
        settings.clipMode,
        settings.clippingsBaseFolder,
      );
      if (request.clipboard !== null) {
        const copied = await this.deps.copyToClipboardViaTab(params.tabId, request.clipboard);
        if (!copied) {
          // Same fallback the cockpit uses: the URI carries the note itself.
          request = obsidianClipRequest(
            payload,
            vault,
            content,
            rule,
            "legacy-uri",
            settings.clippingsBaseFolder,
          );
        }
      }
      await this.deps.openObsidianUrl(request.url);
    });

    if (!params.close) {
      return { tabId: params.tabId, title: payload.title, url: payload.url, file, closed: false };
    }

    let batchId: string | undefined;
    try {
      const tab = await browser.tabs.get(params.tabId);
      const entry = toClosedEntry(tab);
      if (entry) batchId = await recordClosed([entry]);
      await browser.tabs.remove(params.tabId);
    } catch (err) {
      console.warn("[tabglutton] bridge close-after-clip failed", params.tabId, err);
      return { tabId: params.tabId, title: payload.title, url: payload.url, file, closed: false };
    }
    return {
      tabId: params.tabId,
      title: payload.title,
      url: payload.url,
      file,
      closed: true,
      ...(batchId ? { batchId } : {}),
    };
  }

  private async tabsClose(raw: unknown): Promise<TabsCloseResult> {
    const { tabIds } = parseTabsCloseParams(raw);
    const tabs = await Promise.all(
      tabIds.map(async (id) => {
        try {
          return await browser.tabs.get(id);
        } catch {
          return null;
        }
      }),
    );
    const live = tabs.filter((t): t is browser.tabs.Tab => t !== null && t.id !== undefined);
    if (live.length === 0) fail("not-found", "None of the given tab ids exist.");

    const entries = live.map(toClosedEntry).filter((e): e is ClosedTabEntry => e !== null);
    // Record before removing: a crash mid-remove must not lose the trail.
    const batchId = await recordClosed(entries);
    await browser.tabs.remove(live.map((t) => t.id as number));
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

    let restored = 0;
    for (const entry of batch.entries) {
      try {
        await browser.tabs.create({
          url: entry.url,
          windowId: entry.windowId >= 0 ? entry.windowId : undefined,
          index: entry.index,
          pinned: entry.pinned,
          active: false,
        });
        restored += 1;
      } catch (err) {
        // Most often the original window is gone; retry without placement.
        try {
          await browser.tabs.create({ url: entry.url, active: false });
          restored += 1;
        } catch {
          console.warn("[tabglutton] bridge undo failed for", entry.url, err);
        }
      }
    }
    await writeUndoLog(removeBatch(log, batch.id));
    return { batchId: batch.id, restored, failed: batch.entries.length - restored };
  }

  private handoff(task: () => Promise<void>): Promise<void> {
    const next = this.handoffQueue.then(async () => {
      await task();
      await delay(OBSIDIAN_HANDOFF_GAP_MS);
    });
    // Keep the chain alive even if a handoff rejects, so one bad clip does not
    // wedge every later one.
    this.handoffQueue = next.catch(() => {});
    return next;
  }
}
