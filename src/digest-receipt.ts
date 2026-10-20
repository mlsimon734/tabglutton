// A digest's receipt: what the user did with it once the agent had reported.
// Pure, so the counting rules are unit-testable; the background records the two
// events only it can see (a closed page coming back, an Undo) and the panel and
// "Copy diagnostics" read the receipt.
//
// The receipt is the digest experiment's measurement, taken from ordinary use
// instead of a labelled sitting: rows moved are disagreement, the time from the
// first look to Close is the review's cost, and a closed page opened again is
// regret. Undo is counted apart from regret — it is the user taking a close back
// on purpose, and its restored tabs must never read as pages the user went
// looking for.

import type { ClosedTabEntry, DigestFate } from "./bridge-protocol.js";
import { findCloseBatch, type DigestRecord, type DigestUse } from "./digest.js";
import { normalizeUrl, type NormalizeOpts } from "./normalize.js";
import type { UndoBatch } from "./undo-log.js";

/** How long a closed page is watched for coming back. */
export const REOPEN_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Undos remembered per digest, newest first; closes are capped the same way. */
const UNDO_HISTORY = 10;

const NO_USE: DigestUse = { reopened: [], undone: [] };

export interface DigestReceipt {
  /** Items a Close took. */
  closed: number;
  /** Of those, opened again by the user inside the watch window. */
  reopened: number;
  /** Items Undo put back. */
  undone: number;
  /** Rows the user moved out of the agent's section, unticked close rows included. */
  moved: number;
  /** The moves by the agent's section and the user's, largest first. */
  moves: Array<{ from: DigestFate; to: DigestFate; count: number }>;
  /** From the digest's first render in the panel to its first Close. */
  reviewMs?: number;
  /** Some closed item is still inside its watch window. */
  watching: boolean;
}

/** When each item was last taken by a close. A later close of the same item wins. */
function closedAt(record: Pick<DigestRecord, "closes">): Map<number, number> {
  const out = new Map<number, number>();
  for (const close of record.closes) {
    const at = close.at ?? close.startedAt;
    for (const { index, outcome } of close.outcomes) {
      if (outcome !== "closed") continue;
      const prev = out.get(index);
      if (prev === undefined || at > prev) out.set(index, at);
    }
  }
  return out;
}

/**
 * Whether an item closed at `since` is still watched at `now`: inside the window,
 * and neither put back by Undo nor already counted as reopened since that close.
 * A page that comes back after an Undo is the Undo's tab, not the user's.
 */
function stillWatched(use: DigestUse, index: number, since: number, now: number): boolean {
  if (now < since || now - since >= REOPEN_WINDOW_MS) return false;
  if (use.undone.some((u) => u.at >= since && u.indexes.includes(index))) return false;
  return !use.reopened.some((r) => r.index === index && r.at >= since);
}

export interface ReopenWatch {
  digestId: string;
  index: number;
  /** The closed page, normalized the way digest identity is. */
  key: string;
  /** Only a tab in the same privacy context counts. */
  incognito: boolean;
  /** Epoch ms past which this item is no longer watched. */
  until: number;
}

/** Every closed item still watched, across the stored digests. */
export function reopenWatchList(
  records: readonly DigestRecord[],
  opts: NormalizeOpts,
  now: number,
): ReopenWatch[] {
  const out: ReopenWatch[] = [];
  for (const record of records) {
    const use = record.use ?? NO_USE;
    for (const [index, since] of closedAt(record)) {
      const item = record.items[index];
      if (!item || !stillWatched(use, index, since, now)) continue;
      const key = item.url ? normalizeUrl(item.url, opts) : null;
      if (key === null) continue;
      out.push({
        digestId: record.id,
        index,
        key,
        incognito: item.anchor?.incognito ?? false,
        until: since + REOPEN_WINDOW_MS,
      });
    }
  }
  return out;
}

/**
 * Count one item as reopened at `at`, checked again against the record as it is
 * now (an Undo may have landed since the watch list was built). Null when it no
 * longer counts or already did.
 */
export function withReopen(record: DigestRecord, index: number, at: number): DigestRecord | null {
  const since = closedAt(record).get(index);
  const use = record.use ?? NO_USE;
  if (since === undefined || !stillWatched(use, index, since, at)) return null;
  return { ...record, use: { ...use, reopened: [...use.reopened, { index, at }] } };
}

/**
 * Record an Undo of one of this digest's close batches. `batch` is the batch as
 * it stood before the Undo and `restored` the entries that came back. A tab the
 * Undo reopened may have been counted as reopened while the Undo was running, so
 * any count for those items since `startedAt` is withdrawn. Null when the batch
 * is not this digest's or nothing of it came back.
 */
export function withUndone(
  record: DigestRecord,
  batch: UndoBatch,
  restored: readonly ClosedTabEntry[],
  startedAt: number,
  at: number,
  opts: NormalizeOpts,
): DigestRecord | null {
  const ours = record.closes.filter((close) => findCloseBatch(record, close, [batch], opts));
  if (ours.length === 0) return null;
  const back = new Set(
    restored.map((entry) => (entry.url ? normalizeUrl(entry.url, opts) : null)).filter(Boolean),
  );
  const indexes = new Set<number>();
  for (const close of ours) {
    for (const { index, outcome } of close.outcomes) {
      const url = record.items[index]?.url;
      if (outcome === "closed" && url && back.has(normalizeUrl(url, opts))) indexes.add(index);
    }
  }
  if (indexes.size === 0) return null;
  const use = record.use ?? NO_USE;
  return {
    ...record,
    use: {
      reopened: use.reopened.filter((r) => !(indexes.has(r.index) && r.at >= startedAt)),
      undone: [{ at, indexes: [...indexes].sort((a, b) => a - b) }, ...use.undone].slice(
        0,
        UNDO_HISTORY,
      ),
    },
  };
}

/** The receipt, or null until a Close has taken something. */
export function digestReceipt(record: DigestRecord, now: number): DigestReceipt | null {
  const closed = closedAt(record);
  if (closed.size === 0) return null;
  const use = record.use ?? NO_USE;

  const tally = new Map<string, { from: DigestFate; to: DigestFate; count: number }>();
  let moved = 0;
  for (const item of record.items) {
    if (item.userFate === undefined || item.userFate === item.fate) continue;
    moved += 1;
    const key = `${item.fate}>${item.userFate}`;
    const row = tally.get(key);
    if (row) row.count += 1;
    else tally.set(key, { from: item.fate, to: item.userFate, count: 1 });
  }

  const firstClose = Math.min(...record.closes.map((c) => c.startedAt));
  const reviewMs =
    record.openedAt !== undefined && firstClose >= record.openedAt
      ? firstClose - record.openedAt
      : undefined;

  return {
    closed: closed.size,
    reopened: new Set(use.reopened.map((r) => r.index)).size,
    undone: new Set(use.undone.flatMap((u) => u.indexes)).size,
    moved,
    moves: [...tally.values()].sort((a, b) => b.count - a.count),
    ...(reviewMs !== undefined ? { reviewMs } : {}),
    watching: [...closed].some(([index, since]) => stillWatched(use, index, since, now)),
  };
}

/** "under a minute", "4 min", "1 h 20 min", "3 days": the review time, read at a glance. */
export function reviewSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The receipt as the panel prints it, one clause per fact with its number set
 * apart: "Closed 14, 4 min after opening · reopened 2 so far · you moved 3".
 * Undo and moves appear only when they happened; reopened always does, because
 * "none so far" is the answer the receipt exists to give.
 */
export function receiptSegments(
  r: DigestReceipt,
): Array<{ lead: string; n: number; tail: string }> {
  const out = [
    {
      lead: "Closed ",
      n: r.closed,
      tail: r.reviewMs === undefined ? "" : `, ${reviewSpan(r.reviewMs)} after opening`,
    },
    { lead: "reopened ", n: r.reopened, tail: r.watching ? " so far" : "" },
  ];
  if (r.undone > 0) out.push({ lead: "undone ", n: r.undone, tail: "" });
  if (r.moved > 0) out.push({ lead: "you moved ", n: r.moved, tail: "" });
  return out;
}
