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

Both requests are gated on a new Connector preference, `externalAPI.allowedExtensions`, which is an
empty array by default: the API answers nothing until the user lists a calling extension's ID in it,
and web pages (which have no `sender.id`) are refused outright. The pref follows the existing
`allowedInterceptHosts` / `allowedCSLExtensionHosts` shape and is editable in the Connector's own
Config Editor, so the patch adds no preferences UI.

## Build the patched Connector

The checked-in patch applies to `zotero/zotero-connectors` master at commit `c279ccc`
(2026-08-21). It was first written against `48ad1fe0` and no longer applies there; upstream moved
`_browserAction` onto `Zotero.HostPermissions.checkChromiumActionPermissions` and added an
`_ensureScriptsInjected` guard, and that guard has to return `false` too or an injection failure
answers `saveTab` with `saved`.

```sh
git clone https://github.com/zotero/zotero-connectors.git
cd zotero-connectors
git submodule update --init   # not --recursive: that pulls the whole Zotero client tree
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
- The port to master `c279ccc` builds both targets with the external API in both generated
  backgrounds. A live Firefox 134.0.2 run (`scratch-chrome/verify-zotero-external-api.ts`, local
  only) installed the patched Connector and `dist-firefox` as temporary add-ons and drove the API
  from Tabglutton's own options page: `getTabInfo` answered `unauthorized` until
  `externalAPI.allowedExtensions` named `tabglutton@addons.local`, and then
  `{ state: "ready", isPDF: false, translator: { itemType: "preprint", label: "arXiv.org" } }` for
  the arXiv abstract. A bad `version` answers `unsupported-version` and a bad `action`
  `unknown-action`.
- **A pref written from a page reaches the running background**, which is what makes the Config
  Editor a real remedy rather than a setting that needs a restart: `Prefs.set` is listed in
  `src/common/messages.js`, so a page's call is proxied to the background, which owns the cache
  `Prefs.get` reads. Measured — the same session that wrote the pref was authorized by it.
- `saveTab` was re-exercised on that same Firefox against a live Zotero client
  (`scratch-chrome/verify-zotero-save.ts`): it answered `{ ok: true, status: "saved" }` in 1.7s, and
  the library held the item a second later — a `preprint` titled "Attention Is All You Need" with a
  note and a `Preprint PDF` attachment, `dateAdded` 2026-08-22 20:16:44 UTC. `firstUse` has to be
  cleared first, because the API refuses to save while the Connector's own onboarding is pending;
  that refusal is deliberate and is not a bug to route around.
- **Confirming a save from outside the client needs the WAL.** Zotero keeps its SQLite in WAL mode,
  so a read opened with `immutable=1` — which ignores the log by design — reported a library frozen
  days earlier and made a save that had just landed look like it had failed. Copy `zotero.sqlite`
  together with its `-wal` and `-shm` and query the copy. The local HTTP API is the cleaner route
  but answers 403 unless the user has switched it on in Zotero's Advanced settings.
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
7. Copy Tabglutton's own ID from `chrome://extensions`, open the Connector's **Preferences →
   Advanced → Config Editor**, and set `externalAPI.allowedExtensions` to `["<that ID>"]`. Until
   this is set, every call comes back `unauthorized`.

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
6. In the Connector's **Preferences → Advanced → Config Editor**, set
   `externalAPI.allowedExtensions` to `["tabglutton@addons.local"]`. Until this is set, every call
   comes back `unauthorized`.

## Keep it installed on Zen

A temporary add-on is gone at the next restart, which makes the POC unusable as a daily route. Zen
can hold the build permanently, and Firefox release cannot: Zen ships `MOZ_REQUIRE_SIGNING: false`
(`omni.ja` → `modules/AppConstants.sys.mjs`, measured on 1.21.15b), so
`modules/addons/AddonSettings.sys.mjs` falls through to the `xpinstall.signatures.required` pref
instead of hard-coding the requirement. Set that pref to `false` in `about:config` and an unsigned
XPI installs and stays installed. On release Firefox the same pref is inert.

**The build needs its own add-on identity first.** The generated Firefox manifest carries Zotero's
ID _and_ `update_url: https://zotero.org/...`, so a same-ID install is a build Zotero's own updater
is entitled to replace. Re-ID and package after every `./build.sh -d`:

```sh
cd build/firefox
jq '.applications.gecko.id = "zotero-connector-poc@tabglutton.local"
  | del(.applications.gecko.update_url)
  | .name = "Zotero Connector (Tabglutton POC)"' manifest.json > m.tmp && mv m.tmp manifest.json
zip -qr ../zotero-connector-poc.xpi . -x '.*'
```

Then `about:addons` → gear → **Install Add-on From File…**, disable the published Connector (two
Connectors both inject and both talk to Zotero on 23119), and paste
`zotero-connector-poc@tabglutton.local` into the Connector ID field in Tabglutton's settings — it is
free text on both engines, not a Chrome-only override. Authorize Tabglutton in the Config Editor as
above; the allowlist is a Connector preference, so it has to be set again for this build.

The Connector→Zotero channel is loopback HTTP, not extension-ID-keyed, so the renamed build talks to
Zotero desktop exactly as the published one does. Zotero's local server has no per-extension
authorization at all: `server.js` blocks browser-shaped requests only until they carry an
`X-Zotero-Connector-API-Version` header.

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

- Authorization is a static allowlist the user edits by hand. It is deliberately the smallest
  defensible model rather than the best one: a first-use approval prompt would not make the user
  find an extension ID and type it into a config editor.
- `saved` means the Connector's page-saving operation resolved without a surfaced failure. It is
  not independent verification of the resulting Zotero library item.
- The Connector ID override is development UI. A production build should use the published ID and
  remove the field once the API is upstream.
- The patch is intentionally kept outside Tabglutton's build. No Zotero AGPL source is bundled into
  the MIT extension.
