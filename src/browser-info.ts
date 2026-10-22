// `browser.runtime.getBrowserInfo` is an IPC round trip whose answer is
// constant for the life of the browser, and several callers want it on the same
// event-page wake (the bridge's connection label, the Zen workspace probe, and
// every duplicate grouping). One memoized call serves the page's lifetime.
// Chrome, which lacks the API, resolves to undefined — as does a call that
// fails, since no caller can do more with the error than fall back.

interface BrowserInfo {
  name?: string;
  /** Only the diagnostics block reads this; the bridge label wants the name alone. */
  version?: string;
  /**
   * Zen's own mark: it answers `name: "Firefox"` but adds this, since Zen
   * 1.18.6b (zen-browser/desktop 466d089f). Plain Firefox has no such field.
   */
  zen?: { version?: string };
}

let cached: Promise<BrowserInfo | undefined> | null = null;

export function getBrowserInfoOnce(): Promise<BrowserInfo | undefined> {
  cached ??= (async (): Promise<BrowserInfo | undefined> => {
    try {
      return await browser.runtime.getBrowserInfo?.();
    } catch {
      return undefined;
    }
  })();
  return cached;
}
