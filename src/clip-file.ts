// The file destination: the same note `clip-format.ts` composes, written to the
// browser's download folder instead of handed to Obsidian. It exists so the
// install gate stops being "do you use Obsidian" — nothing here needs a
// protocol handler, a vault, or a host permission the clipper does not already
// hold. It is never a fallback: the extension cannot tell a refused
// `obsidian://` launch from a successful one, so it could never know when to
// switch, and the destination is a setting the user picks.

import { clipNotePath, type ClipPayload, type FilePlatform } from "./clip-format.js";
import type { SiteRule } from "./site-rules.js";
import { IS_CHROME } from "./target.js";

/**
 * The downloads API enforces rules a vault does not, and enforces them by
 * rejecting the whole call rather than by cleaning the name up: no empty path
 * component, none that starts or ends with a dot, and no `../` back-reference.
 * Obsidian accepts all three, and the base folder is free text a user typed, so
 * the vault-relative path is trimmed again on its way to disk rather than being
 * sanitized differently at the source. Backslashes go too — they are a path
 * separator on Windows, so one left inside a title would invent a folder.
 */
function downloadSegment(segment: string): string {
  return segment
    .replace(/\\/g, "")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");
}

/**
 * Where a clip lands in file mode, relative to the browser's download folder.
 * Deliberately the same path Obsidian mode would file it at — same base folder,
 * same per-site subfolder, same per-platform note name — plus the `.md` a vault
 * infers and a download folder does not.
 */
export function clipDownloadPath(
  payload: ClipPayload,
  rule: SiteRule | null,
  baseFolder: string,
  platform: FilePlatform,
): string {
  const parts = clipNotePath(payload, rule, baseFolder, platform).split("/");
  // Popped before the folders are filtered: a note name that trims away to
  // nothing would otherwise promote its folder into the file name.
  const name = downloadSegment(parts.pop() ?? "") || "Untitled";
  const folders = parts.map(downloadSegment).filter(Boolean);
  return [...folders, `${name}.md`].join("/");
}

/**
 * The note as a `data:` URL. `btoa` reads its argument as Latin-1, so the text
 * is encoded to UTF-8 bytes first — without that step every clip containing a
 * non-ASCII character throws rather than writing a mangled note. Chunked
 * because `String.fromCharCode(...bytes)` overflows the argument list on a
 * long article.
 */
export function markdownDataUrl(markdown: string): string {
  const bytes = new TextEncoder().encode(markdown);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:text/markdown;base64,${btoa(binary)}`;
}

/**
 * Each engine gets the only handle it accepts. Gecko's downloads schema refuses
 * a `data:` URL outright, and a Chrome MV3 service worker has no
 * `URL.createObjectURL` to make the object URL Gecko wants. Chrome's ceiling is
 * the data URL's own length, which a pathological page could exceed; that
 * rejects the one clip and is reported like any other failure.
 */
function downloadUrlFor(markdown: string): string {
  return IS_CHROME
    ? markdownDataUrl(markdown)
    : URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
}

/** How long one note may take to reach disk before the clip is called failed. */
const DOWNLOAD_SETTLE_TIMEOUT_MS = 15000;

/**
 * What the browser was able to tell us about one write.
 *
 * Two facts, kept apart because they fail apart. `confirmed` is the only thing
 * that licenses closing a tab; `path` is where to find the note and is a
 * courtesy, absent whenever the browser no longer has a record to read it from.
 */
export interface SavedClipFile {
  /**
   * The download was **seen** to reach `state: "complete"`. False means the
   * browser could not say — never that the write failed, which throws.
   */
  confirmed: boolean;
  /**
   * Absolute path the browser reported writing. Never the path we asked for:
   * `conflictAction: "uniquify"` renames a clip whose name is taken, so the
   * request is a prediction and only this is an answer. Absent rather than
   * substituted, because a relative guess an agent cannot tell from a real path
   * is worse than no path at all.
   */
  path?: string;
}

/**
 * Writes one clip and resolves only once the browser has finished with it,
 * answering with what the browser could actually attest to. Unlike the
 * `obsidian://` handoff — indistinguishable from a refused one, hence Gullet's
 * whole verification layer — this destination can normally prove the file
 * exists, and it says so rather than leaving the caller to assume it.
 *
 * Throws only on a download the browser reports as interrupted. A download
 * whose record has been erased is neither proof nor failure: it comes back
 * `confirmed: false`, and the decision about the tab belongs to the caller.
 */
export async function saveClipFile(path: string, markdown: string): Promise<SavedClipFile> {
  const url = downloadUrlFor(markdown);
  try {
    const id = await browser.downloads.download({
      url,
      filename: path,
      // `obsidian://new` never overwrites either — handed a taken name it
      // writes "Note 1.md" — so a repeat clip behaves the same either way.
      conflictAction: "uniquify",
      // A Devour run is tens of tabs, so a save dialog per note would be
      // unusable; this also overrides Firefox's browser-wide "always ask".
      saveAs: false,
    });
    const confirmed = await settled(id);
    const landed = await landedPath(id);
    return { confirmed, ...(landed !== undefined ? { path: landed } : {}) };
  } finally {
    // Object URLs must outlive the download that reads them (MDN says exactly
    // this); data URLs carry their own bytes and have nothing to release.
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

/**
 * What the browser actually wrote, absolute — worth the extra round trip
 * because the requested path is a prediction and this is the answer, and an
 * agent reading a `tab_clip` result has no other way to find the note.
 * Undefined when the record is gone or unreadable, which the caller reports as
 * "no path" rather than papering over with the path it asked for.
 */
async function landedPath(id: number): Promise<string | undefined> {
  try {
    const [item] = await browser.downloads.search({ id });
    return item?.filename || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Waits for the browser to finish with a download, answering whether it was
 * **seen** to complete. False is "cannot say", not "did not happen": only an
 * interruption throws.
 *
 * The completion listener is attached before the state is read, for the reason
 * `ensureTabReady` documents: the read is an IPC round trip, and a download of
 * bytes already in memory routinely finishes inside it — firing into a listener
 * that does not exist yet and then sitting until the timeout.
 */
async function settled(id: number): Promise<boolean> {
  let cleanup = (): void => {};
  const done = new Promise<void>((resolve, reject) => {
    const listener = (delta: browser.downloads._OnChangedDownloadDelta): void => {
      if (delta.id !== id) return;
      const state = delta.state?.current;
      if (state === undefined || state === "in_progress") return;
      cleanup();
      if (state === "complete") resolve();
      else reject(new Error(interruptedMessage(delta.error?.current)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Download did not finish within ${DOWNLOAD_SETTLE_TIMEOUT_MS}ms`));
    }, DOWNLOAD_SETTLE_TIMEOUT_MS);
    cleanup = (): void => {
      clearTimeout(timer);
      browser.downloads.onChanged.removeListener(listener);
    };
    browser.downloads.onChanged.addListener(listener);
  });
  // Marked handled straight away. A download of bytes already in memory can
  // fail inside the IPC round trip below — before anything awaits `done` — and
  // an unhandled rejection there would log a spurious error on every one. The
  // `await` at the end still sees the same rejection.
  done.catch(() => {});

  let existing: browser.downloads.DownloadItem | undefined;
  try {
    [existing] = await browser.downloads.search({ id });
  } catch (err) {
    cleanup();
    throw err;
  }
  if (!existing) {
    // The id we were just handed has no record, so it was erased from history —
    // which only happens once a download is over. Nothing more will be reported
    // about it, and waiting out the timeout would fail a clip whose file is on
    // disk, which costs a duplicate when the user re-clips. So this stays
    // fail-open, the same call the vault verifier makes.
    //
    // But "over" includes *interrupted* — a history cleaner erases failures
    // too — so this branch has seen nothing and must not be reported as if it
    // had. `unknown` is fail-open, and a fail-open answer is not a confirmation.
    cleanup();
    return false;
  }
  if (existing.state !== "in_progress") {
    // Cleared, so `done` simply never settles — nothing awaits it after this.
    cleanup();
    if (existing.state === "complete") return true;
    throw new Error(interruptedMessage(existing.error));
  }
  await done;
  return true;
}

function interruptedMessage(error: string | undefined): string {
  return error ? `Download interrupted: ${error}` : "Download interrupted";
}
