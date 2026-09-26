// What the Digest panel's buttons do. Every action re-resolves its items against
// a fresh listing at click time (`planDigestAction`), looks at each tab once more
// right before touching it (`recheckTarget`), and reports per item what it did.
// The destructive half goes through the bridge's own `tabs_close` and
// `undo_close`, so every undo invariant holds with no second implementation
// (docs/ENGINEERING.md §Undo invariants).

import {
  BridgeRequestError,
  DIGEST_FATES,
  type DigestFate,
  type TabsCloseResult,
  type UndoCloseResult,
} from "./bridge-protocol.js";
import {
  buildDigestView,
  DIGEST_GROUP_NAME,
  planDigestAction,
  recheckTarget,
  summarizeDigest,
  withAction,
  type DigestAction,
  type DigestActionRecord,
  type DigestItemOutcome,
  type DigestRecord,
  type DigestSummary,
  type DigestView,
  type LiveTab,
} from "./digest.js";
import { announceDigestsChanged, readDigests, toLiveTab, updateDigest } from "./digest-store.js";
import type { PlannedGroup } from "./grouping.js";
import type { NormalizeOpts } from "./normalize.js";
import type { UndoBatch } from "./undo-log.js";

export type GetDigestsMessage = { type: "get-digests"; digestId?: string; view?: boolean };
export type DigestSeenMessage = { type: "digest-seen"; digestId: string };
export type DigestSetFateMessage = {
  type: "digest-set-fate";
  digestId: string;
  index: number;
  /** null returns the row to the agent's fate. */
  fate: DigestFate | null;
};
export type DigestActMessage = { type: "digest-act"; digestId: string; action: DigestAction };
export type DigestUndoMessage = { type: "digest-undo"; digestId: string };
export type DigestShowMessage = { type: "digest-show"; digestId: string; index: number };

export type DigestMessage =
  | GetDigestsMessage
  | DigestSeenMessage
  | DigestSetFateMessage
  | DigestActMessage
  | DigestUndoMessage
  | DigestShowMessage;

export interface GetDigestsResponse {
  /** Newest first. */
  list: DigestSummary[];
  /** The requested digest, else the newest — only when `view` was asked for. */
  view?: DigestView;
}

export type DigestActResponse =
  | {
      ok: true;
      action: DigestAction;
      /** Items grouped or closed. */
      done: number;
      outcomes: Array<{ index: number; outcome: DigestItemOutcome }>;
      batchId?: string;
      /** This engine cannot group at all; nothing moved. */
      unsupported?: string;
    }
  | { ok: false; error: string };

export interface DigestActionDeps {
  opts: () => NormalizeOpts;
  liveTabs: () => Promise<LiveTab[]>;
  getTab: (tabId: number) => Promise<LiveTab | null>;
  readUndoLog: () => Promise<UndoBatch[]>;
  closeTabs: (tabIds: number[]) => Promise<TabsCloseResult>;
  undoClose: (batchId: string) => Promise<UndoCloseResult>;
  group: (groups: PlannedGroup[]) => Promise<{ groupedIds: number[]; unsupported?: string }>;
  focusTab: (tabId: number) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
}

export function isDigestMutation(type: string): boolean {
  return type !== "get-digests" && type.startsWith("digest-");
}

export class DigestActions {
  private readonly deps: DigestActionDeps;

  constructor(deps: DigestActionDeps) {
    this.deps = deps;
  }

  async handle(msg: DigestMessage): Promise<unknown> {
    switch (msg.type) {
      case "get-digests":
        return this.get(msg);
      case "digest-seen":
        return this.seen(msg.digestId);
      case "digest-set-fate":
        return this.setFate(msg);
      case "digest-act":
        return this.act(msg.digestId, msg.action);
      case "digest-undo":
        return this.undo(msg.digestId);
      case "digest-show":
        return this.show(msg.digestId, msg.index);
    }
  }

  private async find(id: unknown): Promise<DigestRecord | null> {
    if (typeof id !== "string") return null;
    return (await readDigests()).find((d) => d.id === id) ?? null;
  }

  private async view(record: DigestRecord): Promise<DigestView> {
    const [live, log] = await Promise.all([this.deps.liveTabs(), this.deps.readUndoLog()]);
    return buildDigestView(record, live, log, this.deps.opts());
  }

  private async get(msg: GetDigestsMessage): Promise<GetDigestsResponse> {
    const list = await readDigests();
    const response: GetDigestsResponse = { list: list.map(summarizeDigest) };
    if (msg.view) {
      const record = list.find((d) => d.id === msg.digestId) ?? list[0];
      if (record) response.view = await this.view(record);
    }
    return response;
  }

  private async seen(id: string): Promise<{ ok: boolean }> {
    const updated = await updateDigest(id, (record) =>
      record.openedAt === undefined ? { ...record, openedAt: Date.now() } : null,
    );
    return { ok: updated !== null };
  }

  /**
   * Move a row. A row an action already took (grouped, or closed and still
   * gone) is locked: moving it would describe something that already happened
   * as something that has not.
   */
  private async setFate(msg: DigestSetFateMessage): Promise<{ ok: boolean }> {
    const fate = msg.fate;
    if (fate !== null && !(DIGEST_FATES as readonly string[]).includes(fate)) return { ok: false };
    const record = await this.find(msg.digestId);
    if (!record || !Number.isInteger(msg.index)) return { ok: false };
    const view = await this.view(record);
    const row = view.items[msg.index];
    if (!row || row.locked) return { ok: false };
    const updated = await updateDigest(record.id, (current) => {
      const item = current.items[msg.index];
      if (!item) return null;
      const items = [...current.items];
      const { userFate: _previous, ...rest } = item;
      items[msg.index] = fate === null || fate === item.fate ? rest : { ...rest, userFate: fate };
      return { ...current, items };
    });
    return { ok: updated !== null };
  }

  async act(id: string, action: DigestAction): Promise<DigestActResponse> {
    if (action !== "keep" && action !== "close") return { ok: false, error: "Unknown action." };
    const record = await this.find(id);
    if (!record) return { ok: false, error: "That digest is no longer stored." };
    const opts = this.deps.opts();
    const plan = planDigestAction(record, action, await this.deps.liveTabs(), opts);

    // The last look, immediately before acting: anything that navigated, got
    // pinned, or became active since the plan is left alone and says why.
    const outcomes = [...plan.skipped];
    const targets = [];
    for (const target of plan.targets) {
      const refused = recheckTarget(target, await this.deps.getTab(target.tabId), action, opts);
      if (refused) outcomes.push({ index: target.index, outcome: refused });
      else targets.push(target);
    }

    const startedAt = Date.now();
    let done = 0;
    let batchId: string | undefined;
    let unsupported: string | undefined;

    if (action === "keep") {
      const byWindow = new Map<number, PlannedGroup>();
      for (const t of targets) {
        const group = byWindow.get(t.windowId) ?? {
          name: DIGEST_GROUP_NAME,
          color: "yellow",
          windowId: t.windowId,
          tabIds: [],
        };
        group.tabIds.push(t.tabId);
        byWindow.set(t.windowId, group);
      }
      if (targets.length > 0) {
        const res = await this.deps.group([...byWindow.values()]);
        unsupported = res.unsupported;
        const grouped = new Set(res.groupedIds);
        for (const t of targets) {
          outcomes.push({ index: t.index, outcome: grouped.has(t.tabId) ? "grouped" : "failed" });
        }
        done = grouped.size;
      }
      if (unsupported) return { ok: true, action, done: 0, outcomes: [], unsupported };
    } else if (targets.length > 0) {
      // Intent first. If the write after the close is lost, the panel finds the
      // batch again from this `startedAt` and the undo log (`findCloseBatch`);
      // if this write fails, nothing has been closed yet.
      const intent = await updateDigest(record.id, (current) =>
        withAction(current, "close", { startedAt, outcomes: [] }),
      );
      if (!intent) return { ok: false, error: "That digest is no longer stored." };
      const ids = targets.map((t) => t.tabId);
      let result: TabsCloseResult | null = null;
      try {
        result = await this.deps.closeTabs(ids);
      } catch (err) {
        // `tabs_close` throws when nothing at all could be closed: every id gone
        // (`not-found`) or every removal refused. Neither closed anything.
        const gone = err instanceof BridgeRequestError && err.code === "not-found";
        for (const t of targets) {
          outcomes.push({ index: t.index, outcome: gone ? "gone" : "failed" });
        }
      }
      if (result) {
        batchId = result.batchId;
        const missing = new Set(result.missing ?? []);
        const skipped = new Set(result.skipped ?? []);
        for (const t of targets) {
          const outcome = missing.has(t.tabId)
            ? "gone"
            : skipped.has(t.tabId)
              ? "failed"
              : "closed";
          outcomes.push({ index: t.index, outcome });
        }
        done = result.closed;
      }
    }

    outcomes.sort((a, b) => a.index - b.index);
    const entry: DigestActionRecord = {
      startedAt,
      at: Date.now(),
      ...(batchId ? { batchId } : {}),
      outcomes,
    };
    // A lost write here is recoverable: the undo log still holds the batch.
    await updateDigest(record.id, (current) => withAction(current, action, entry)).catch((err) =>
      console.warn("[tabglutton] digest: could not record an action", String(err?.name ?? "")),
    );
    announceDigestsChanged();
    return { ok: true, action, done, outcomes, ...(batchId ? { batchId } : {}) };
  }

  /** Reopen the newest close batch that still has something to reopen. */
  private async undo(id: string): Promise<{ ok: boolean; restored: number; failed: number }> {
    const record = await this.find(id);
    if (!record) return { ok: false, restored: 0, failed: 0 };
    const undo = (await this.view(record)).undo;
    if (!undo) return { ok: false, restored: 0, failed: 0 };
    try {
      const result = await this.deps.undoClose(undo.batchId);
      announceDigestsChanged();
      return { ok: true, restored: result.restored, failed: result.failed };
    } catch {
      // Double-clicked, or undone from an agent session first: `withUndoLog`
      // re-read the log inside its lock and found the batch already gone.
      return { ok: false, restored: 0, failed: 0 };
    }
  }

  /**
   * Bring a row's tab forward, or reopen its page when the tab is gone. Only
   * the extension-resolved tab or the stored http(s) URL, re-validated here —
   * nothing an agent wrote becomes an `<a href>`.
   */
  private async show(id: string, index: number): Promise<{ ok: boolean }> {
    const record = await this.find(id);
    if (!record) return { ok: false };
    const row = (await this.view(record)).items[index];
    if (!row) return { ok: false };
    if (row.tabId !== undefined) {
      await this.deps.focusTab(row.tabId);
      return { ok: true };
    }
    let url: URL;
    try {
      url = new URL(row.url);
    } catch {
      return { ok: false };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false };
    await this.deps.openUrl(url.href);
    return { ok: true };
  }
}

/** Browser-backed `getTab` for the recheck. */
export async function liveTabById(tabId: number): Promise<LiveTab | null> {
  try {
    return toLiveTab(await browser.tabs.get(tabId));
  } catch {
    return null;
  }
}
