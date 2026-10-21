// What the Digest panel's buttons do. Every action re-resolves its items against
// a fresh listing at click time (`planDigestAction`), looks at each tab once more
// right before touching it (`recheckTarget`), and reports per item what it did.
// The destructive half goes through the bridge's own `tabs_close` and
// `undo_close`, so every undo invariant holds with no second implementation
// (docs/ENGINEERING.md §Undo invariants). Focus and Clear only reorder the
// window the panel is in (`tab-order.ts`); they keep that window's layout from
// before and after on the digest, and their Undo puts it back exactly or
// refuses.

import {
  DIGEST_FATES,
  type DigestFate,
  type TabsCloseResult,
  type UndoCloseResult,
} from "./bridge-protocol.js";
import {
  buildDigestView,
  effectiveFate,
  planDigestAction,
  recheckTarget,
  resolveDigestItems,
  summarizeDigest,
  withClose,
  withOrder,
  type DigestAction,
  type DigestActionRecord,
  type DigestItemOutcome,
  type DigestRecord,
  type DigestSummary,
  type DigestView,
  type FileDestination,
  type LiveTab,
} from "./digest.js";
import { digestReceipt } from "./digest-receipt.js";
import { announceDigestsChanged, readDigests, toLiveTab, updateDigest } from "./digest-store.js";
import type { NormalizeOpts } from "./normalize.js";
import type { PageFacts } from "./page-facts.js";
import { createTaskQueue } from "./serialize.js";
import {
  arrange,
  FOCUS_RANK,
  fixedTabs,
  orderTarget,
  restoreTarget,
  sameLayout,
  stripIndexes,
  type ArrangeIo,
  type OrderDirection,
  type OrderMove,
  type PlacedBlock,
} from "./tab-order.js";
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
/** Reorder the window the full view is in by this digest's verdicts. */
export type DigestOrderMessage = {
  type: "digest-order";
  digestId: string;
  direction: OrderDirection;
};
/** Put that window back as it was before the latest Focus or Clear. */
export type DigestUndoOrderMessage = { type: "digest-undo-order"; digestId: string };
export type DigestShowMessage = { type: "digest-show"; digestId: string; index: number };

export type DigestMessage =
  | GetDigestsMessage
  | DigestSeenMessage
  | DigestSetFateMessage
  | DigestActMessage
  | DigestUndoMessage
  | DigestOrderMessage
  | DigestUndoOrderMessage
  | DigestShowMessage;

/** Where a message came from: the window of the tab the full view is in. */
export interface DigestSender {
  windowId?: number;
}

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
      /** Items closed. */
      done: number;
      outcomes: Array<{ index: number; outcome: DigestItemOutcome }>;
      batchId?: string;
    }
  | { ok: false; error: string };

export type DigestOrderResponse =
  | {
      ok: true;
      direction: OrderDirection;
      /** The window ended in the planned order, every read-back as planned. */
      complete: boolean;
      moves: number;
      /** Digest tabs ranked in this window. */
      ranked: number;
      /** Digest tabs open in other windows, left alone. */
      elsewhere: number;
      /** Pinned and hidden tabs, and Zen folders, left in place. */
      fixed: number;
    }
  | { ok: false; error: string };

export type DigestUndoOrderResponse =
  | { ok: true; exact: boolean; moves: number }
  | { ok: false; error: string };

export const ORDER_CHANGED =
  "Not undone: this window’s tabs changed since the reorder (a tab moved, opened, closed, or changed pin or group), so it can no longer be put back exactly.";
const ORDER_WINDOW_GONE = "Not undone: that window is no longer open.";

export interface DigestActionDeps {
  opts: () => NormalizeOpts;
  liveTabs: () => Promise<LiveTab[]>;
  getTab: (tabId: number) => Promise<LiveTab | null>;
  readUndoLog: () => Promise<UndoBatch[]>;
  closeTabs: (tabIds: number[]) => Promise<TabsCloseResult>;
  undoClose: (batchId: string) => Promise<UndoCloseResult>;
  /** One window's tabs, as blocks, from a fresh listing. Throws when the window is gone. */
  readLayout: (windowId: number) => Promise<PlacedBlock[]>;
  /** One `tabs.move` (a tab) or `tabGroups.move` (a group) in that window. */
  moveBlock: (windowId: number, move: OrderMove) => Promise<void>;
  pageFacts: () => Promise<PageFacts[]>;
  fileTo: () => FileDestination;
  focusTab: (tabId: number) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
}

export function isDigestMutation(type: string): boolean {
  return type !== "get-digests" && type.startsWith("digest-");
}

export class DigestActions {
  private readonly deps: DigestActionDeps;
  /** Focus, Clear and their Undo, one at a time: each reads a window, then moves it. */
  private readonly ordering = createTaskQueue();

  constructor(deps: DigestActionDeps) {
    this.deps = deps;
  }

  async handle(msg: DigestMessage, from: DigestSender = {}): Promise<unknown> {
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
      case "digest-order":
        return this.order(msg.digestId, msg.direction, from.windowId);
      case "digest-undo-order":
        return this.undoOrder(msg.digestId);
      case "digest-show":
        return this.show(msg.digestId, msg.index);
    }
  }

  private async find(id: unknown): Promise<DigestRecord | null> {
    if (typeof id !== "string") return null;
    return (await readDigests()).find((d) => d.id === id) ?? null;
  }

  private async view(record: DigestRecord): Promise<DigestView> {
    const [live, log, facts] = await Promise.all([
      this.deps.liveTabs(),
      this.deps.readUndoLog(),
      this.deps.pageFacts().catch(() => []),
    ]);
    const view = buildDigestView(record, live, log, this.deps.opts(), {
      facts,
      fileTo: this.deps.fileTo(),
    });
    const receipt = digestReceipt(record, Date.now());
    return receipt ? { ...view, receipt } : view;
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
   * Move a row. A row a close already took (and whose tab is still gone) is
   * locked: moving it would describe something that already happened as
   * something that has not. Unticking a close row is this same move, to
   * could-not-read; ticking it again returns it to the agent's fate.
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
    if (action !== "close") return { ok: false, error: "Unknown action." };
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

    if (targets.length > 0) {
      // Intent first. If the write after the close is lost, the panel finds the
      // batch again from this `startedAt` and the undo log (`findCloseBatch`);
      // if this write fails, nothing has been closed yet.
      const intent = await updateDigest(record.id, (current) =>
        withClose(current, { startedAt, outcomes: [] }),
      );
      if (!intent) return { ok: false, error: "That digest is no longer stored." };
      const ids = targets.map((t) => t.tabId);
      let result: TabsCloseResult | null = null;
      try {
        result = await this.deps.closeTabs(ids);
      } catch {
        // `tabs_close` throws when nothing at all could be closed. Its code does
        // not say which tabs are gone — `not-found` also covers tabs that have
        // not committed a URL yet — so ask the browser, tab by tab.
        for (const t of targets) {
          const still = await this.deps.getTab(t.tabId).catch(() => null);
          outcomes.push({ index: t.index, outcome: still ? "failed" : "gone" });
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
    await updateDigest(record.id, (current) => withClose(current, entry)).catch((err) =>
      console.warn("[tabglutton] digest: could not record an action", String(err?.name ?? "")),
    );
    announceDigestsChanged();
    return { ok: true, action, done, outcomes, ...(batchId ? { batchId } : {}) };
  }

  /**
   * Focus or Clear the window the full view is in. Only this digest's verdicts
   * rank: a tab the digest resolves to in this window takes its effective
   * fate's bucket, every other tab here is neutral, and digest tabs in other
   * windows are counted and left alone. That window's layout is stored before
   * the first move and read back after the last; when nothing changed since the
   * previous order, its `before` is kept, so one Undo returns to the start.
   */
  private async order(
    id: string,
    direction: OrderDirection,
    windowId: number | undefined,
  ): Promise<DigestOrderResponse> {
    if (direction !== "focus" && direction !== "clear") {
      return { ok: false, error: "Unknown order." };
    }
    if (windowId === undefined) {
      return { ok: false, error: "Open the full view in a tab of the window to order." };
    }
    return this.ordering(async () => {
      const record = await this.find(id);
      if (!record) return { ok: false, error: "That digest is no longer stored." };
      const resolutions = resolveDigestItems(
        record.items,
        await this.deps.liveTabs(),
        this.deps.opts(),
      );
      const rank = new Map<number, number>();
      let elsewhere = 0;
      record.items.forEach((item, i) => {
        const r = resolutions[i];
        if (r?.kind !== "exact" && r?.kind !== "fallback") return;
        if (r.tab.windowId === windowId) rank.set(r.tab.id, FOCUS_RANK[effectiveFate(item)]);
        else elsewhere++;
      });
      let before;
      try {
        before = stripIndexes(await this.deps.readLayout(windowId));
      } catch {
        return { ok: false, error: "That window is no longer open." };
      }
      const target = orderTarget(
        before,
        (tabId) => rank.get(tabId) ?? FOCUS_RANK.neutral,
        direction,
      );
      const previous = record.order;
      const origin =
        previous &&
        previous.undoneAt === undefined &&
        previous.after &&
        previous.windowId === windowId &&
        sameLayout(previous.after, before)
          ? previous.before
          : before;
      // Before anything moves: a run cut short still has its starting point.
      const startedAt = Date.now();
      const intent = await updateDigest(record.id, (current) =>
        withOrder(current, {
          direction,
          windowId,
          startedAt,
          before: origin,
          ranked: rank.size,
          elsewhere,
        }),
      );
      if (!intent) return { ok: false, error: "That digest is no longer stored." };
      const result = await arrange(this.windowIo(windowId), target);
      await updateDigest(record.id, (current) =>
        current.order?.startedAt === startedAt
          ? withOrder(current, {
              ...current.order,
              after: stripIndexes(result.layout),
              at: Date.now(),
              complete: result.complete,
              moves: result.moves,
            })
          : null,
      ).catch((err) =>
        console.warn("[tabglutton] digest: could not record an order", String(err?.name ?? "")),
      );
      announceDigestsChanged();
      return {
        ok: true,
        direction,
        complete: result.complete,
        moves: result.moves,
        ranked: rank.size,
        elsewhere,
        fixed: fixedTabs(before),
      };
    });
  }

  private windowIo(windowId: number): ArrangeIo {
    return {
      read: () => this.deps.readLayout(windowId),
      move: (move) => this.deps.moveBlock(windowId, move),
    };
  }

  /**
   * Put the latest order's window back, once, and only exactly: the live layout
   * must still be the one the order left, or nothing moves and the answer says
   * why. The claim is spent under the digest lock before the first move.
   */
  private async undoOrder(id: string): Promise<DigestUndoOrderResponse> {
    return this.ordering(async () => {
      const record = await this.find(id);
      const order = record?.order;
      if (!record || !order || order.undoneAt !== undefined || !order.after) {
        return { ok: false, error: "There is no reorder to undo." };
      }
      let live;
      try {
        live = stripIndexes(await this.deps.readLayout(order.windowId));
      } catch {
        return { ok: false, error: ORDER_WINDOW_GONE };
      }
      if (live.length === 0) return { ok: false, error: ORDER_WINDOW_GONE };
      const target = sameLayout(live, order.after) ? restoreTarget(live, order.before) : null;
      if (!target) return { ok: false, error: ORDER_CHANGED };
      let claimed = false;
      await updateDigest(record.id, (current) => {
        if (current.order?.startedAt !== order.startedAt || current.order.undoneAt !== undefined) {
          return null;
        }
        claimed = true;
        return withOrder(current, { ...current.order, undoneAt: Date.now() });
      });
      if (!claimed) return { ok: false, error: "That reorder was already undone." };
      const result = await arrange(this.windowIo(order.windowId), target);
      announceDigestsChanged();
      return {
        ok: true,
        exact: result.complete && sameLayout(stripIndexes(result.layout), order.before),
        moves: result.moves,
      };
    });
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
    // A still-clipped URL (an item that never matched its tab) is not an
    // address; opening it would load a page that does not exist.
    if (row.url.endsWith("…")) return { ok: false };
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
