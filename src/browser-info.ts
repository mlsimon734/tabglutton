// `browser.runtime.getBrowserInfo` is an IPC round trip whose answer is
// constant for the life of the browser, and two startup-path callers want it on
// the same event-page wake (the bridge's connection label and the Zen workspace
// probe). One memoized call serves the page's lifetime. Chrome, which lacks the
// API, resolves to undefined — as does a call that fails, since neither caller
// can do more with the error than fall back.

interface BrowserInfo {
  name?: string;
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
