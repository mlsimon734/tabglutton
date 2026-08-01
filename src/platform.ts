// `browser.runtime.getPlatformInfo` is an IPC round trip whose answer cannot
// change while the browser runs, and every clip asks it the same question:
// which filesystem's naming rules does this note name have to satisfy? One
// memoized call serves the page's lifetime, as with `getBrowserInfoOnce`.
//
// A failed call answers "other" rather than throwing into the clip path — that
// is the conservative rule set, so an unanswerable platform costs a slightly
// over-sanitized file name, never a clip.

import type { FilePlatform } from "./clip-format.js";

let cached: Promise<FilePlatform> | null = null;

export function getFilePlatformOnce(): Promise<FilePlatform> {
  cached ??= (async (): Promise<FilePlatform> => {
    try {
      const { os } = await browser.runtime.getPlatformInfo();
      return os === "win" ? "win" : os === "mac" ? "mac" : "other";
    } catch {
      return "other";
    }
  })();
  return cached;
}
