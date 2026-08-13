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
 * Writes one clip and resolves only once it is on disk. Devour closes the tab
 * on success, and unlike the `obsidian://` handoff — which is indistinguishable
 * from a refused one, hence Gullet's whole verification layer — this
 * destination can prove the file exists, so it proves it before the tab goes.
 */
export async function saveClipFile(path: string, markdown: string): Promise<void> {
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
    await settled(id);
  } finally {
    // Object URLs must outlive the download that reads them (MDN says exactly
    // this); data URLs carry their own bytes and have nothing to release.
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

/**
 * The completion listener is attached before the state is read, for the reason
 * `ensureTabReady` documents: the read is an IPC round trip, and a download of
 * bytes already in memory routinely finishes inside it — firing into a listener
 * that does not exist yet and then sitting until the timeout.
 */
async function settled(id: number): Promise<void> {
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

  let existing: browser.downloads.DownloadItem | undefined;
  try {
    [existing] = await browser.downloads.search({ id });
  } catch (err) {
    cleanup();
    throw err;
  }
  if (existing && existing.state !== "in_progress") {
    // Cleared, so `done` simply never settles — nothing awaits it after this.
    cleanup();
    if (existing.state === "complete") return;
    throw new Error(interruptedMessage(existing.error));
  }
  await done;
}

function interruptedMessage(error: string | undefined): string {
  return error ? `Download interrupted: ${error}` : "Download interrupted";
}
