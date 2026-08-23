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
  /** Where that most recent clip went. Reported in the UI, never acted on. */
  destination: ClipTarget;
  /**
   * Epoch ms of the last time something that can see the filesystem actually
   * saw a note for this page — absent until one has.
   *
   * A timestamp rather than a `verified` flag, because the state has to survive
   * a later clip that could not confirm anything (a page verified in March and
   * re-clipped from the popup today is still a page whose note was seen) and
   * because it must then not be *described* as that later clip. Bound to `at`
   * and `destination`, "verified" would claim a disk sighting on a day nothing
   * looked, at a destination nothing checked. Keeping the evidence in its own
   * field is also what makes the state unforgettable by construction: nothing
   * can un-see a note, so there is no ordering in which `clip_confirm` and the
   * `launched` write its own clip made can disagree.
   */
  verifiedAt?: number;
}

/** How well this page's filing is known. Derived, never stored — see `verifiedAt`. */
export function clipMarkFor(entry: ClipMemoryEntry): ClipMark {
  return entry.verifiedAt === undefined ? "launched" : "verified";
}

/** Normalized URL → what is known about filing it. */
export type ClipMemory = Record<string, ClipMemoryEntry>;

/**
 * Ceiling on remembered pages, pruned least-recently-clipped first.
 *
 * A normalized-URL map grows forever otherwise, and this one is written back
 * whole on every clip. Measured at the cap with realistic keys: 617 KB
 * serialized, 0.5ms to parse and 0.46ms to upsert — comfortably inside Chrome's
 * 10 MB `storage.local` quota, and a write a clip that already waits on a page
 * load and a 200ms handoff gap will not notice. A Devour run of hundreds of tabs
 * at the cap does move that much through storage per clip, which is the one
 * shape where batching a single write at the end of the run would pay.
 * Generous in time, too: at a steady seven clips a day it is about two years
 * before anything is forgotten, and what falls off is the page filed longest ago
 * — the one whose tab is least likely to still be in the backlog.
 */
export const CLIP_MEMORY_MAX_ENTRIES = 5000;

/**
 * The key a URL is remembered under, or null when it has none.
 *
 * Only a real page is remembered. `normalizeUrl` passes a non-http URL through
 * **unchanged**, so without this gate a tab mid-navigation would key under the
 * literal `about:blank` Gecko reports for it (see `tabUrl` in
 * bridge-methods.ts) — and one entry there would mark every loading tab as
 * already clipped, in the popup and in `tabs_list` alike. Nothing can currently
 * reach that key (both clip paths are behind their own `isHttpUrl` gates), which
 * is exactly why the guard belongs here rather than in the callers' good
 * intentions.
 */
export function clipMemoryKey(url: string | undefined, opts: NormalizeOpts): string | null {
  if (!url?.startsWith("http://") && !url?.startsWith("https://")) return null;
  return normalizeUrl(url, opts);
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
  // A sighting is never taken back, so the old one stands whenever this clip
  // produced none of its own.
  const verifiedAt = record.state === "verified" ? now : memory[key]?.verifiedAt;
  return pruneClipMemory(
    {
      ...memory,
      [key]: {
        at: now,
        destination: record.destination,
        ...(verifiedAt === undefined ? {} : { verifiedAt }),
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
    // Finite, not merely a number: a stored NaN would make `pruneClipMemory`'s
    // comparator answer NaN and leave the eviction order unspecified, so a junk
    // entry could outlive a live one — and render as "Invalid Date".
    Number.isFinite(entry.at) &&
    (entry.verifiedAt === undefined || Number.isFinite(entry.verifiedAt)) &&
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
