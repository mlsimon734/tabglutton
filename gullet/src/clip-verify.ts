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

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ObsidianVaultPaths } from "./obsidian-vaults.js";

/**
 * - `landed`  the note is on disk. The clip is real.
 * - `missing` the vault path is known and the note is not there. Refuse to
 *   close, and say so.
 * - `mismatched` a fresh note for this page is there, but its text is not what
 *   we handed over. Refuse to close — but it is a different story from
 *   `missing` and has to be told differently: either another session's clip of
 *   the same page landed while ours dropped, or something in the vault rewrites
 *   notes on create, which would make this the answer for every clip. Guessing
 *   between them is not our job; naming both is.
 * - `unknown` the registry could not be read, or names no such vault. Same soft
 *   contract as the vault-override check: inability to verify is never a
 *   failure, so behaviour falls back to what it was before.
 */
export type ClipVerdict = "landed" | "missing" | "mismatched" | "unknown";

/**
 * What a verification has to go on, weakest to strongest. Only `since` is
 * required: an embedder that can supply nothing else gets freshness-only
 * verification, which is where this check started.
 */
export interface ClipEvidence {
  /**
   * Taken before the clip is requested. Mere existence is not proof: re-clipping
   * a page that was already filed would find the OLD note and call a dropped
   * handoff verified, which is exactly the case this check exists for.
   */
  since: number;
  /**
   * The clipped tab's URL, as the extension reported it. Freshness cannot tell
   * two concurrent clips apart — same title, same requested name, both
   * timestamps before both writes — so a note whose own `source` names a
   * different page never vouches.
   */
  sourceUrl?: string;
  /**
   * SHA-256 of the exact text handed to Obsidian. Stronger than `sourceUrl`,
   * and the only evidence that separates two clips of the *same* page: it
   * identifies the invocation rather than the destination. Absent from older
   * extensions, so it is never required.
   */
  contentHash?: string;
}

export type ClipVerifier = (
  vault: string,
  file: string,
  evidence: ClipEvidence,
) => Promise<ClipVerdict>;

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
  /** A note's text, null when absent, "unreadable" when it cannot be checked. */
  readNote?: (path: string) => Promise<string | null | "unreadable">;
  /** SHA-256 hex of a note's text. Injected for tests. */
  hashNote?: (content: string) => Promise<string>;
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

async function defaultReadNote(path: string): Promise<string | null | "unreadable"> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    return isNotFound(err) ? null : "unreadable";
  }
}

/**
 * The `source` property `markdownForClip` writes into every clip's frontmatter:
 * a double-quoted scalar in the leading `---` block, in which `"` — and only `"`
 * — is backslash-escaped. So the value runs to the *last* quote on the line, not
 * to the first unescaped one: a URL ending in a backslash leaves the writer's
 * output ambiguous, and reading it the strict way returned null for a note that
 * was perfectly fine.
 *
 * Deliberately not shared with `clip-format.ts`: that module's import graph
 * reaches browser-typed code, and Gullet's tsconfig has no DOM. The coupling is
 * one line of output format, `tests/clip-source.test.ts` pins the two together,
 * and drift degrades to "cannot attribute" rather than to a wrong answer — see
 * `noteOwnership`.
 */
export function noteSourceUrl(content: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (frontmatter === undefined) return null;
  const value = /^source:[ \t]*"(.*)"[ \t]*$/m.exec(frontmatter)?.[1];
  return value === undefined ? null : value.replaceAll('\\"', '"');
}

/**
 * SHA-256 of a note's text, hex — the same digest `src/clip-hash.ts` takes of
 * what the extension handed Obsidian. Injectable only so tests need not hash
 * real strings.
 *
 * CRLF is folded to LF for the same reason it is on the extension side, and it
 * has to be folded on *both*: in clipboard clip mode the note's text reaches
 * Obsidian through the OS clipboard, and Windows carries plain text as
 * CF_UNICODETEXT with CRLF endings, so the bytes on disk are not the bytes that
 * were hashed. Normalizing here is what keeps that path from reporting every
 * landed clip as `mismatched`. `tests/clip-source.test.ts` pins the two halves.
 */
export async function clipContentHash(content: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(content.replaceAll("\r\n", "\n")).digest("hex");
}

/**
 * Obsidian Web Clipper — and so `clip-format.ts` — drops a scroll-to-text
 * fragment from the recorded source, because it addresses a position in the
 * page rather than the page. Both sides are stripped so the comparison is
 * against the same page identity the note recorded.
 */
function clipSourceIdentity(url: string): string {
  return url.replace(/#:~:text=[^&]+(&|$)/, "");
}

/**
 * Whether a note that is otherwise a candidate belongs to *this* clip.
 *
 * Only a `source` we could read and that names a different page is a refusal.
 * A note with no parseable frontmatter source — a hand-written note sharing the
 * name, a clip from an older format, a future format change here — falls back to
 * freshness alone, which is what this check replaced. Positive disagreement
 * disqualifies; absence of evidence never does.
 */
function noteOwnership(content: string, sourceUrl: string): "mine" | "other" {
  const recorded = noteSourceUrl(content);
  if (recorded === null) return "mine";
  return clipSourceIdentity(recorded) === clipSourceIdentity(sourceUrl) ? "mine" : "other";
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
  const readNote = options.readNote ?? defaultReadNote;
  const hashNote = options.hashNote ?? clipContentHash;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now());

  /**
   * Notes already spent as proof, by absolute path and the mtime that was
   * accepted. The second line of defence behind the `source` check, and the only
   * one left when two clips of the *same* page race: a note vouches for exactly
   * one clip, so a dropped handoff cannot ride on the one write that landed.
   * Once claimed, only a newer write to the same path counts (Obsidian never
   * overwrites, so a second real clip is a different path anyway; a newer mtime
   * on the same path means the note was deleted and the page re-filed).
   *
   * Process-local, and the reason it is not the primary defence: two Gullets
   * sharing one browser — a hub and a peer — each keep their own map. Attributing
   * by `source` needs no shared state and holds across processes.
   *
   * With `contentHash` present it is a backstop rather than the argument: the
   * hash already identifies the invocation, and two clips that hash the same are
   * two clips of byte-identical text, where which note belongs to which cannot
   * matter. It still carries the older extensions that send no hash.
   *
   * Be precise about what a `landed` verdict is worth. Hashed, it says this
   * exact text is on disk. Unhashed, only that a fresh note for this page is.
   * Either way it is not a guarantee when the check cannot run: `unknown` is
   * fail-open by design, and there the old behaviour stands, dropped handoffs
   * included.
   */
  const claimed = new Map<string, number>();

  return async (vault, file, { since, sourceUrl, contentHash }) => {
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
    // A fresh note for this page that we refused on its hash. Kept so the
    // timeout can say "someone wrote this, it just was not us" rather than the
    // flatly wrong "nothing was written".
    let sawForeign = false;
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
        // Fresh and correctly named is not yet proof this clip wrote it. A
        // concurrent clip of a same-titled page asks for the same name, so read
        // the note before letting it close a tab.
        if (contentHash !== undefined || sourceUrl !== undefined) {
          const content = await readNote(path);
          if (content === "unreadable") return "unknown";
          // Written between our listing and our read; it will be back next poll.
          if (content === null) continue;
          // Obsidian creates the note and fills it a beat later — measured live,
          // both of this user's real vaults. An empty file is that window, never
          // a landed clip, and without this it is exactly the note that has no
          // parseable `source` and so falls through as "mine".
          if (content.trim() === "") continue;
          if (contentHash !== undefined) {
            // The invocation's own fingerprint: a note that does not hash to it
            // was written by some other clip, whatever page it names.
            if ((await hashNote(content)) !== contentHash) {
              // Only a note naming *our* page is worth reporting as a mismatch;
              // a neighbouring clip that merely shares a title is not evidence
              // about ours either way.
              if (sourceUrl === undefined || noteOwnership(content, sourceUrl) === "mine") {
                sawForeign = true;
              }
              continue;
            }
          } else if (noteOwnership(content, sourceUrl ?? "") === "other") {
            continue;
          }
        }
        const spentAt = claimed.get(path);
        if (spentAt !== undefined && mtime <= spentAt) continue;
        claimed.set(path, mtime);
        prune(claimed, now() - timeoutMs - CLIP_MTIME_SLACK_MS);
        return "landed";
      }
      if (now() >= deadline) return sawForeign ? "mismatched" : "missing";
      await sleep(POLL_INTERVAL_MS);
    }
  };
}
