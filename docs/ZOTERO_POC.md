# Zotero Connector routing proof of concept

This proof of concept lets Tabglutton ask a separately built Zotero Connector to identify and save
scholarly tabs. It is local development machinery, not a production integration: the published
Connector does not expose this API yet.

The patch is checked in so the experiment and a future upstream proposal are reproducible. It
cannot be applied automatically when Tabglutton is installed: browser-store extensions are signed,
isolated packages, and one extension cannot rewrite another installed extension. Until Zotero ships
the API, testing therefore requires a separately built, unpacked Connector as described below.

## What it proves

- Cross-extension messages use the standard `runtime.sendMessage(extensionId, message)` and
  `runtime.onMessageExternal` path shared by Firefox and Chromium.
- Tabglutton can use Zotero's existing per-tab translator result instead of maintaining a brittle
  list of arXiv, OpenReview, PubMed, bioRxiv, publisher, journal, proxy, and PDF hostnames.
- Scholarly item types (`journalArticle`, `conferencePaper`, `preprint`, `thesis`, `report`,
  `manuscript`, and `bookSection`) and standalone PDFs route to Zotero. Other pages retain the
  existing Obsidian path.
- A Zotero-bound tab closes only after the patched Connector's save promise resolves. Detection,
  messaging, or surfaced save failures leave it open.

The proof of concept adds two versioned requests:

```json
{ "action": "getTabInfo", "version": 1, "tabId": 123 }
{ "action": "saveTab", "version": 1, "tabId": 123 }
```

`getTabInfo` is the main finding beyond the forum proposal. A generic `saveTab` entry point invokes
the toolbar action, but it cannot by itself tell Tabglutton which tabs are papers. Exposing the
Connector's already-computed top translator type avoids duplicating Zotero's site coverage.

## Build the patched Connector

The checked-in patch was verified against `zotero/zotero-connectors` commit
`48ad1fe09defb770f83a3268cf8ebe72ab9aba52`.

```sh
git clone https://github.com/zotero/zotero-connectors.git
cd zotero-connectors
git submodule update --init
npm install
git apply /absolute/path/to/tabglutton/poc/zotero-connector.patch
./build.sh -d
```

The development builds are written to:

- `build/firefox/`
- `build/manifestv3/` for Chrome

## Verification so far

- The full Tabglutton test suite passes, and both Tabglutton targets build.
- The patched Connector builds both `build/firefox/` and `build/manifestv3/` with the external API
  present in their generated backgrounds.
- A live Chrome 151 test loaded both unpacked MV3 extensions in a throwaway profile. Tabglutton's
  background reached the Connector by its generated extension ID, and `getTabInfo` classified
  `https://arxiv.org/abs/1706.03762` as `{ itemType: "preprint", label: "arXiv.org" }`.
- The same setup exercised Tabglutton's full selected-tab route for that paper. The Connector saved
  it to Zotero, Tabglutton reported one Zotero save with no failures, and the source tab closed.
- Firefox source and output are validated, but its end-to-end browser smoke test remains manual. The
  Firefox 134 automation runtime available during this POC predates WebDriver BiDi's
  `webExtension.install` command and could not install both temporary add-ons programmatically.

## Load it in Chrome

1. Build Tabglutton with `bun run build:chrome`.
2. Open `chrome://extensions`, enable Developer mode, and temporarily disable the published Zotero
   Connector.
3. Choose **Load unpacked** and select the Connector's `build/manifestv3/` directory.
4. Copy the ID Chrome assigns that unpacked Connector.
5. Load Tabglutton's `dist-chrome/` directory as another unpacked extension.
6. In Tabglutton settings, enable **Route papers to Zotero** and paste the unpacked Connector ID.

The published Chrome Connector ID remains the default so the override can disappear if the API is
accepted upstream.

## Load it in Firefox or Zen

1. Build Tabglutton with `bun run build:firefox`.
2. The patched Connector retains Zotero's normal Gecko ID, `zotero@chnm.gmu.edu`, so disable the
   installed Connector before loading the development build.
3. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select
   `build/firefox/manifest.json`.
4. Load `dist-firefox/manifest.json` the same way.
5. In Tabglutton settings, enable **Route papers to Zotero**. The default Connector ID is already
   correct.

## Suggested smoke test

With Zotero ready to receive saves, select a mixture of tabs in Tabglutton:

- an arXiv abstract;
- an OpenReview paper;
- a PubMed or journal-article page;
- a standalone paper PDF; and
- a general webpage.

Run Devour. The paper tabs should be saved through the Zotero Connector and then closed. The general
webpage should follow the existing Obsidian flow. If the Connector API is missing, still detecting,
or reports a save error, Tabglutton shows a retryable **Zotero failed** result and leaves the tab
open.

## Deliberate limitations

- The POC rejects web pages but accepts calls from any browser extension with a `sender.id`. A real
  upstream implementation still needs an allowlist, approval UI, or another authorization model.
- `saved` means the Connector's page-saving operation resolved without a surfaced failure. It is
  not independent verification of the resulting Zotero library item.
- The Connector ID override is development UI. A production build should use the published ID and
  remove the field once the API is upstream.
- The patch is intentionally kept outside Tabglutton's build. No Zotero AGPL source is bundled into
  the MIT extension.
