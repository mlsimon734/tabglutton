// Where the settings page opens, for Tabglutton's own settings buttons.
//
// `options_ui.open_in_tab` is a static manifest value, so a runtime toggle
// cannot simply flip it. The Firefox manifest declares the *embedded* form,
// because that is the one an extension cannot produce on its own — nothing lets
// us navigate to about:addons — while a full tab is just a URL we can open.
//
// Chrome is the mirror image and takes neither branch: `build.ts` gives it
// `open_in_tab: true`, so `openOptionsPage` already opens and raises a tab, and
// the toggle is hidden there (Chrome's embedded form is a modal on
// chrome://extensions that this page does not fit). Reading `optionsInTab` on
// Chrome would only let a stale stored value produce that modal.

import { loadSettings } from "./storage.js";
import { IS_CHROME } from "./target.js";

export function optionsPageUrl(): string {
  return browser.runtime.getURL("options/options.html");
}

export async function openOptionsUi(): Promise<void> {
  if (IS_CHROME) {
    await browser.runtime.openOptionsPage();
    return;
  }
  const { optionsInTab } = await loadSettings();
  if (!optionsInTab) {
    await browser.runtime.openOptionsPage();
    return;
  }
  const url = optionsPageUrl();
  // `openOptionsPage` raises an already-open settings tab rather than opening a
  // second one, so opening the URL ourselves has to do the same by hand. The
  // query is best-effort: `url` there is a match pattern, and the extension
  // schemes are not part of the pattern grammar every engine accepts. A throw
  // must cost a duplicate tab, not the settings page.
  const existing = await browser.tabs.query({ url }).catch(() => []);
  const open = existing[0];
  if (open?.id !== undefined) {
    await browser.tabs.update(open.id, { active: true });
    if (open.windowId !== undefined) {
      await browser.windows.update(open.windowId, { focused: true });
    }
    return;
  }
  await browser.tabs.create({ url });
}
