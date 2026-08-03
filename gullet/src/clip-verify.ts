// Confirm that a clip Obsidian was handed actually reached the vault.
//
// The browser cannot answer this. A refused `obsidian://` launch is
// indistinguishable from a successful one from inside the extension: the
// ephemeral launch tab sits at about:blank with status "complete" either way,
// raises no dialog and fires no error (measured on Firefox 134, both pref
// states). So the extension reports the path it *intended* to write, and a
// silently dropped handoff reads as success — which is how a clip could vanish
// while `tab_clip({ close: true })` still closed the tab.
//
// Gullet can answer it, because it runs beside the vault and already reads
// Obsidian's registry to resolve vault names. Filesystem truth replaces the
// browser's optimism.

import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ObsidianVaultPaths } from "./obsidian-vaults.js";

/**
 * - `landed`  the note is on disk. The clip is real.
 * - `missing` the vault path is known and the note is not there. Refuse to
 *   close, and say so.
 * - `unknown` the registry could not be read, or names no such vault. Same soft
 *   contract as the vault-override check: inability to verify is never a
 *   failure, so behaviour falls back to what it was before.
 */
export type ClipVerdict = "landed" | "missing" | "unknown";

/**
 * `since` is taken before the clip is requested. Mere existence is not proof:
 * re-clipping a page that was already filed would find the OLD note and call a
 * dropped handoff verified, which is exactly the case this check exists for. The
 * note must have been written since we asked.
 */
export type ClipVerifier = (vault: string, file: string, since: number) => Promise<ClipVerdict>;

/** Obsidian writes asynchronously; give it a moment before calling it missing. */
export const CLIP_VERIFY_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 200;

/**
 * Filesystem mtime and our own clock are not the same source, and a note written
 * a moment before we sampled `since` should still count. Slack absorbs that
 * rather than turning a real clip into a reported failure.
 */
export const CLIP_MTIME_SLACK_MS = 2_000;

/**
 * Not-there and cannot-look are different answers and must stay different. Only
 * ENOENT is "not written yet"; a permission or I/O failure on a vault Obsidian
 * can reach is the soft contract's "cannot check", and collapsing both to `null`
 * reported a real clip as missing.
 */
export type FileTime = number | null | "unreadable";
export type DirListing = string[] | "missing" | "unreadable";

export interface ClipVerifierOptions {
  timeoutMs?: number;
  /** Last-modified time in ms, null when absent, "unreadable" when it cannot be checked. */
  modifiedAt?: (path: string) => Promise<FileTime>;
  /** Names in a directory, or why they could not be read. Injected for tests. */
  readDir?: (dir: string) => Promise<DirListing>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

async function defaultModifiedAt(path: string): Promise<FileTime> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (err) {
    return isNotFound(err) ? null : "unreadable";
  }
}

async function defaultReadDir(dir: string): Promise<DirListing> {
  try {
    return await readdir(dir);
  } catch (err) {
    return isNotFound(err) ? "missing" : "unreadable";
  }
}

/**
 * Every name Obsidian might have used for this clip.
 *
 * `obsidian://new` does not overwrite: handed a name that is taken it writes
 * "Note 1.md", then "Note 2.md", and so on — verified live against Obsidian on
 * macOS. The extension only ever reports the name it *asked* for, so checking
 * that one path alone calls a landed clip missing the second time a page is
 * filed. Matching is exact rather than by regex because a note title may contain
 * anything, including regex metacharacters.
 */
export function isClipNoteName(entry: string, base: string): boolean {
  if (!entry.endsWith(".md")) return false;
  const stem = entry.slice(0, -3);
  if (stem === base) return true;
  if (!stem.startsWith(`${base} `)) return false;
  const suffix = stem.slice(base.length + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

/**
 * `file` is the vault-relative note path the extension reported, without an
 * extension — Obsidian appends `.md`. A name that already carries one is left
 * alone rather than becoming `note.md.md`.
 */
export function clipNotePath(vaultPath: string, file: string): string {
  const relative = file.endsWith(".md") ? file : `${file}.md`;
  return join(vaultPath, relative);
}

/**
 * Forget claims no verification could still be looking at. The oldest freshness
 * floor any in-flight verification can hold is its start (at most `timeoutMs`
 * ago) minus the mtime slack, so a claim below that could never be reused as
 * proof regardless — and the map must not grow for the life of a session.
 */
function prune(claimed: Map<string, number>, floor: number): void {
  for (const [path, mtime] of claimed) {
    if (mtime < floor) claimed.delete(path);
  }
}

export function createClipVerifier(
  vaultPaths: ObsidianVaultPaths,
  options: ClipVerifierOptions = {},
): ClipVerifier {
  const timeoutMs = options.timeoutMs ?? CLIP_VERIFY_TIMEOUT_MS;
  const modifiedAt = options.modifiedAt ?? defaultModifiedAt;
  const readDir = options.readDir ?? defaultReadDir;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now());

  /**
   * Notes already spent as proof, by absolute path and the mtime that was
   * accepted.
   *
   * Two clips of pages with the same title produce the same requested name, and
   * the second is written as "Note 1.md" — but only if it was written at all.
   * With both requests in flight, both timestamps precede both writes, so if one
   * handoff is dropped the single fresh note satisfies both verifications and
   * `close: true` closes the tab whose content was never saved. A note can
   * therefore vouch for exactly one clip: once claimed, only a *newer* write to
   * the same path counts (Obsidian never overwrites, so a real second clip is a
   * different path anyway; the same path with a newer mtime means the user
   * deleted the note and re-filed it).
   *
   * Process-local. Two Gullets sharing one browser — a hub and a peer — each run
   * their own verifier, so the same interleaving across two agent sessions is
   * still possible; it needs the same page clipped from both within seconds.
   */
  const claimed = new Map<string, number>();

  return async (vault, file, since) => {
    let paths: ReadonlyMap<string, string> | null;
    try {
      paths = await vaultPaths();
    } catch {
      return "unknown";
    }
    const vaultPath = paths?.get(vault);
    // A vault absent from the registry is "cannot check", not "did not land":
    // the registry is undocumented and Obsidian owns it.
    if (!vaultPath) return "unknown";

    const target = clipNotePath(vaultPath, file);
    const dir = dirname(target);
    const base = basename(target).slice(0, -3);
    const fresh = since - CLIP_MTIME_SLACK_MS;
    const deadline = now() + timeoutMs;
    for (;;) {
      const entries = await readDir(dir);
      // The folder not existing yet is a legitimate "not written", but a folder
      // we cannot read at all is "cannot check" — the soft contract again.
      if (entries === "unreadable") return "unknown";
      for (const entry of entries === "missing" ? [] : entries) {
        if (!isClipNoteName(entry, base)) continue;
        const path = join(dir, entry);
        const mtime = await modifiedAt(path);
        // A note we can see but cannot stat is the same "cannot check".
        if (mtime === "unreadable") return "unknown";
        if (mtime === null || mtime < fresh) continue;
        const spentAt = claimed.get(path);
        if (spentAt !== undefined && mtime <= spentAt) continue;
        claimed.set(path, mtime);
        prune(claimed, now() - timeoutMs - CLIP_MTIME_SLACK_MS);
        return "landed";
      }
      if (now() >= deadline) return "missing";
      await sleep(POLL_INTERVAL_MS);
    }
  };
}
