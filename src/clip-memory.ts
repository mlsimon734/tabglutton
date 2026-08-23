// What has already been filed, so a second pass over a backlog costs less than
// the first. Nothing else in the extension remembers a clip once its tab is
// gone: re-meeting a page in a later cleanup session looked exactly like meeting
// it for the first time.
//
// Keyed by `normalizeUrl` — the canonicalizer dedup already uses — so a page
// reached from a newsletter and from a group chat is one memory, the same way
// those two tabs are one duplicate set. It also means the key set follows the
// user's own normalization settings: change `stripFragment` or the extra
// stripped params and old keys stop matching new ones. That is the same
// compromise dedup makes, and the failure mode is a page that reads as unclipped
// rather than one that wrongly reads as clipped.
//
// **The record is never authoritative about what is on disk now.** Notes get
// moved, renamed and deleted after the fact, and nothing here watches for that.
// It answers "was this page filed, and how well did we know it landed", which is
// a claim about the past — every label built on it has to read that way too.
//
// Pure over a plain object so the retention and upsert rules are unit-testable;
// the two functions that touch `storage.local` are at the bottom.

import type { ClipDestination, ClipMark } from "./bridge-protocol.js";
import { normalizeUrl, type NormalizeOpts } from "./normalize.js";
import { createTaskQueue } from "./serialize.js";

export const CLIP_MEMORY_KEY = "clipMemory";

/** Where a clip went. Zotero is not a `ClipDestination` — it is a route out of one. */
export type ClipTarget = ClipDestination | "zotero";

export interface ClipMemoryEntry {
  /** Epoch ms of the most recent clip of this page. What pruning sorts on. */
  at: number;
  /**
   * The **strongest** evidence any clip of this page has produced, not the most
   * recent one's. A page verified on disk in March that is re-clipped today
   * stays `verified`: the note that was seen is no less real for a later handoff
   * being unobservable, and the whole point of the distinction is to mark what
   * was once provable. It is also what lets `clip_confirm` arrive after the
   * `launched` write its own clip made and raise it.
   */
  state: ClipMark;
  /** Most recent destination. Reported in the UI, never acted on. */
  destination: ClipTarget;
}

/** Normalized URL → what is known about filing it. */
export type ClipMemory = Record<string, ClipMemoryEntry>;

/**
 * Ceiling on remembered pages, pruned least-recently-clipped first.
 *
 * A normalized-URL map grows forever otherwise, and this one is written back
 * whole on every clip. At the cap an entry costs roughly 120 bytes (a ~70-char
 * key plus a three-field value), so the store tops out near 600 KB — comfortably
 * inside Chrome's 10 MB `storage.local` quota, and a serialize-and-write a clip
 * that already waits on a page load and a 200ms handoff gap will not notice.
 * Generous in time, too: at a steady seven clips a day it is about two years
 * before anything is forgotten, and what falls off is the page filed longest ago
 * — the one whose tab is least likely to still be in the backlog.
 */
export const CLIP_MEMORY_MAX_ENTRIES = 5000;

/**
 * The key a URL is remembered under, or null when it has none. Blank and
 * unparseable URLs are the null case: a tab mid-navigation has no address yet
 * (see `tabUrl` in bridge-methods.ts) and must not be filed under one.
 */
export function clipMemoryKey(url: string | undefined, opts: NormalizeOpts): string | null {
  return normalizeUrl(url, opts);
}

/** `verified` outranks `launched`; see `ClipMemoryEntry.state`. */
function strongest(current: ClipMark | undefined, next: ClipMark): ClipMark {
  return current === "verified" || next === "verified" ? "verified" : "launched";
}

export interface ClipRecord {
  url: string | undefined;
  state: ClipMark;
  destination: ClipTarget;
}

/**
 * Remember one clip, returning a new map. The caller supplies `now` so the
 * retention rules can be tested without a clock.
 *
 * A URL with no key is dropped silently: failing a clip that has already
 * succeeded because its tab navigated away mid-flight would be the memory
 * costing more than it is worth.
 */
export function rememberClip(
  memory: ClipMemory,
  record: ClipRecord,
  opts: NormalizeOpts,
  now: number,
  max: number = CLIP_MEMORY_MAX_ENTRIES,
): ClipMemory {
  const key = clipMemoryKey(record.url, opts);
  if (key === null) return memory;
  return pruneClipMemory(
    {
      ...memory,
      [key]: {
        at: now,
        state: strongest(memory[key]?.state, record.state),
        destination: record.destination,
      },
    },
    max,
  );
}

/** Drop the least recently clipped pages until the map fits. */
export function pruneClipMemory(memory: ClipMemory, max: number): ClipMemory {
  const entries = Object.entries(memory);
  if (entries.length <= max) return memory;
  entries.sort(([, a], [, b]) => b.at - a.at);
  return Object.fromEntries(entries.slice(0, Math.max(0, max)));
}

export function lookupClip(
  memory: ClipMemory,
  url: string | undefined,
  opts: NormalizeOpts,
): ClipMemoryEntry | undefined {
  const key = clipMemoryKey(url, opts);
  return key === null ? undefined : memory[key];
}

/** Storage is user-editable and survives upgrades — validate what comes back. */
export function parseClipMemory(raw: unknown): ClipMemory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ClipMemory = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key && isClipMemoryEntry(value)) out[key] = value;
  }
  return out;
}

function isClipMemoryEntry(value: unknown): value is ClipMemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ClipMemoryEntry>;
  return (
    typeof entry.at === "number" &&
    (entry.state === "launched" || entry.state === "verified") &&
    (entry.destination === "obsidian" ||
      entry.destination === "file" ||
      entry.destination === "zotero")
  );
}

export async function loadClipMemory(): Promise<ClipMemory> {
  const stored = await browser.storage.local.get(CLIP_MEMORY_KEY);
  return parseClipMemory((stored as Record<string, unknown>)[CLIP_MEMORY_KEY]);
}

/**
 * Every read-modify-write of the memory runs here, one at a time.
 *
 * The same lost update the undo log had (`withUndoLog` in bridge-methods.ts, and
 * docs/ENGINEERING.md §Concurrency): `storage.local` has no compare-and-swap, so
 * the read and the write are two awaits with a gap, and bridge requests are
 * served concurrently — two agents clipping at once would each read the same
 * map, each add their page, and the second write would drop the first. Less
 * costly than losing an undo batch, but a memory that quietly forgets under load
 * is worse than no memory, because nothing about it looks wrong.
 */
const withClipMemory = createTaskQueue();

/**
 * Record one successful clip. Never throws: the clip has already happened by the
 * time this runs, and a memory write that fails must not turn a filed page into
 * a reported failure — the caller would re-clip it and Obsidian would happily
 * write the duplicate.
 */
export async function recordClip(record: ClipRecord, opts: NormalizeOpts): Promise<void> {
  try {
    await withClipMemory(async () => {
      const memory = await loadClipMemory();
      const next = rememberClip(memory, record, opts, Date.now());
      if (next === memory) return;
      await browser.storage.local.set({ [CLIP_MEMORY_KEY]: next });
    });
  } catch (err) {
    console.warn("[tabglutton] could not record clip memory for", record.url, err);
  }
}
