// Undo trail for the one destructive bridge tool (`tabs_close`). Closing is the
// only thing an agent can do to a tab that the user cannot trivially reverse,
// so every close batch is recorded before `tabs.remove` runs.
//
// Kept as pure functions over a plain array so the retention rules are
// unit-testable; the storage.local read/write lives in bridge-methods.ts.

import type { ClosedTabEntry } from "./bridge-protocol.js";

export const UNDO_LOG_KEY = "bridgeUndoLog";

/** Retention: newest-first, bounded on both batch count and total entries. */
const UNDO_LOG_MAX_BATCHES = 20;
const UNDO_LOG_MAX_ENTRIES = 500;

export interface UndoBatch {
  id: string;
  closedAt: number;
  entries: ClosedTabEntry[];
}

export interface UndoLogLimits {
  maxBatches: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: UndoLogLimits = {
  maxBatches: UNDO_LOG_MAX_BATCHES,
  maxEntries: UNDO_LOG_MAX_ENTRIES,
};

/**
 * Prepend `batch` and drop the oldest batches until both limits hold. A single
 * batch larger than `maxEntries` is kept whole — truncating it would make the
 * undo silently partial, which is worse than briefly exceeding the budget.
 */
export function appendBatch(
  log: readonly UndoBatch[],
  batch: UndoBatch,
  limits: UndoLogLimits = DEFAULT_LIMITS,
): UndoBatch[] {
  const next = [batch, ...log].slice(0, Math.max(1, limits.maxBatches));
  const kept: UndoBatch[] = [];
  let entries = 0;
  for (const candidate of next) {
    if (kept.length > 0 && entries + candidate.entries.length > limits.maxEntries) break;
    kept.push(candidate);
    entries += candidate.entries.length;
  }
  return kept;
}

/** Most recent batch when `batchId` is omitted. */
export function findBatch(log: readonly UndoBatch[], batchId?: string): UndoBatch | null {
  if (batchId === undefined) return log[0] ?? null;
  return log.find((b) => b.id === batchId) ?? null;
}

export function removeBatch(log: readonly UndoBatch[], batchId: string): UndoBatch[] {
  return log.filter((b) => b.id !== batchId);
}

/** Storage is user-editable and survives upgrades — validate what comes back. */
export function parseUndoLog(raw: unknown): UndoBatch[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isUndoBatch);
}

function isUndoBatch(value: unknown): value is UndoBatch {
  if (!value || typeof value !== "object") return false;
  const batch = value as Partial<UndoBatch>;
  return (
    typeof batch.id === "string" &&
    typeof batch.closedAt === "number" &&
    Array.isArray(batch.entries) &&
    batch.entries.every(isClosedTabEntry)
  );
}

function isClosedTabEntry(value: unknown): value is ClosedTabEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ClosedTabEntry>;
  return typeof entry.url === "string" && typeof entry.title === "string";
}
