// Where digests live: `storage.local`, one key, behind one queue. The model is
// pure and lives in `digest.ts`; this is the browser half.
//
// Every read-modify-write of the key goes through `withDigests`. Reports arrive
// concurrently over the bridge and the panel writes back into the same array,
// and `storage.local` has no compare-and-swap (docs/ENGINEERING.md
// §Concurrency). It is its own queue rather than the undo log's, because a
// queue guards a key: an action that closes tabs writes the undo log inside
// `tabs_close`, and records its outcome here in a separate step, so no
// operation ever holds both queues and they cannot deadlock.

import {
  DIGESTS_KEY,
  DIGEST_STORE_VERSION,
  parseDigestStore,
  retainDigests,
  type DigestRecord,
  type LiveTab,
} from "./digest.js";
import { createTaskQueue } from "./serialize.js";
import { IS_CHROME } from "./target.js";

export const withDigests = createTaskQueue();

/** Only call inside `withDigests`, unless the answer is read-only. */
export async function readDigests(): Promise<DigestRecord[]> {
  const stored = await browser.storage.local.get(DIGESTS_KEY);
  const { digests, unknownVersion } = parseDigestStore(
    (stored as Record<string, unknown>)[DIGESTS_KEY],
  );
  // The version and nothing else: a digest carries URLs and page text, which
  // never go to a console (docs/ENGINEERING.md §Secrets in logs).
  if (unknownVersion !== undefined) {
    console.warn("[tabglutton] digests: unknown store version", String(unknownVersion));
  }
  return digests;
}

async function writeDigests(list: readonly DigestRecord[]): Promise<void> {
  await browser.storage.local.set({
    [DIGESTS_KEY]: { v: DIGEST_STORE_VERSION, digests: retainDigests(list) },
  });
}

/**
 * Change one digest under the lock. `change` sees the current record and
 * returns its replacement, or null to leave the store untouched. Resolves to
 * the record as written, or null when there was no such digest.
 */
export function updateDigest(
  id: string,
  change: (record: DigestRecord) => DigestRecord | null,
): Promise<DigestRecord | null> {
  return withDigests(async () => {
    const list = await readDigests();
    const index = list.findIndex((d) => d.id === id);
    const current = list[index];
    if (!current) return null;
    const next = change(current);
    if (next === null) return current;
    list[index] = next;
    await writeDigests(list);
    return next;
  });
}

/**
 * Store a new digest unless an identical one is already held. `build` runs
 * inside the lock, so two copies of one report racing each other store once.
 */
export function insertDigest(
  id: string,
  build: () => DigestRecord,
): Promise<{ record: DigestRecord; stored: "new" | "duplicate" }> {
  return withDigests(async () => {
    const list = await readDigests();
    const existing = list.find((d) => d.id === id);
    if (existing) return { record: existing, stored: "duplicate" as const };
    const record = build();
    await writeDigests([record, ...list]);
    return { record, stored: "new" as const };
  });
}

/**
 * A browser tab as identity sees it. The committed `url` only — never Chrome's
 * `pendingUrl` (docs/ENGINEERING.md §Uncommitted URLs): a digest item must not
 * match a tab that has not arrived anywhere yet.
 */
export function toLiveTab(tab: browser.tabs.Tab, favIconUrl?: string): LiveTab | null {
  if (tab.id === undefined) return null;
  return {
    id: tab.id,
    url: tab.url ?? "",
    windowId: tab.windowId ?? -1,
    incognito: tab.incognito,
    pinned: tab.pinned,
    active: tab.active,
    // Chrome has no `hidden`; on Firefox it approximates another Zen workspace.
    hidden: !IS_CHROME && tab.hidden === true,
    discarded: tab.discarded === true,
    ...(tab.lastAccessed !== undefined && tab.lastAccessed > 0
      ? { lastAccessed: tab.lastAccessed }
      : {}),
    ...(favIconUrl ? { favIconUrl } : {}),
  };
}

/** Tell any open extension page that the digests changed. Nobody listening is normal. */
export function announceDigestsChanged(): void {
  void browser.runtime.sendMessage({ type: "digests-changed" }).catch(() => {});
}
