# Repository Guidelines

## Project Structure & Module Organization

This is a Bun-powered TypeScript WebExtension for Zen Browser, Firefox, and Chrome; the product is "Tabglutton". Core logic lives in `src/`: `background.ts` wires browser events, `dedup.ts` plans duplicate tab closures (keeper-selection lives in `pickKeeper` here, not in a separate policy module), `normalize.ts` canonicalizes URLs, `storage.ts` handles settings, `clip-current.ts` is the Defuddle-based content extractor injected into pages by Devour, `clip-format.ts` builds the Obsidian markdown + frontmatter and the `obsidian://new` URL, and `target.ts` exposes `IS_CHROME` / `IS_FIREFOX` for the few places that need to branch by target. The agent bridge (see `BRIDGE.md`) lives in `bridge-protocol.ts` (wire contract, shared with the sidecar), `bridge-client.ts` (loopback WebSocket client + alarm-driven reconnect), `bridge-methods.ts` (the five tool implementations), and `undo-log.ts` (close/undo trail). Popup UI files are in `popup/`, options UI files are in `options/`, the Chrome-only `obsidian://` launch shim is in `redirect/`, and static assets are in `icons/`. `manifest.json` defines the Firefox shape and is patched in memory for Chrome. `build.ts` accepts `--target=firefox|chrome|all` and writes `dist-firefox/` or `dist-chrome/`; treat `dist-firefox/`, `dist-chrome/`, `.dev-profile*`, and `web-ext-artifacts/` as generated output.

## Cross-browser build

- Sources stay shared. `src/target.ts` is checked in with `TARGET = "firefox"`. For the Chrome build, `build.ts` overwrites the compiled `dist-chrome/src/target.js` to flip the constant — sources are never mutated.
- Chrome uses `webextension-polyfill` so the `browser.*` call sites keep working. The Chrome service worker is bundled with `Bun.build` (polyfill inlined). Popup/options HTML pages get `<script src="../vendor/browser-polyfill.js"></script>` injected before the module script tag.
- Chrome manifest differences (applied in memory in `build.ts`): drop `browser_specific_settings`, swap `background.scripts` → `background.service_worker`, swap SVG icons → PNG (`icons/icon-chomp-{16,32,48,128}.png`, rasterized via `rsvg-convert`), set `minimum_chrome_version: "116"`.
- Chrome has no `tab.hidden` and no `getBrowserInfo`; `storage.ts` defaults `scope` to `"current-window"` on Chrome, `background.ts` short-circuits `probeHeuristic` and the `hidden: false` query branch, and the options page hides the scope radio group.
- Chrome rejects the Firefox-only `tabs.onUpdated` filter argument (`{ properties: [...] }`) with "This event does not support filters" — at top level that aborts service-worker registration. `background.ts` registers through the `onTabUpdated` helper, which drops the filter on Chrome (the callbacks already guard on `changeInfo.status`).
- `clip-current.js` is injected as a content script via `scripting.executeScript({ files })`. Chrome validates it with `base::IsStringUTF8`, which — unlike plain UTF-8 validity — rejects Unicode noncharacters / unpaired surrogates (e.g. a raw `U+FFFF` the minifier emits inside a Defuddle regex range), reporting "It isn't UTF-8 encoded." `build.ts` escapes those to `\uXXXX` after bundling (`escapeChromeUnsafeCodePoints`); Firefox skips the check.
- The `obsidian://` clip handoff launches through the extension-origin page `redirect/obsidian-redirect.html` on Chrome instead of a direct `tabs.create({ url: "obsidian://…" })`. Chrome only offers a rememberable "Always allow" for a protocol launch that has a page origin; a browser-initiated launch prompts on every clip. The one-time `chrome-extension://<id>` approval is bootstrapped by the onboarding ping (same origin), so clips fire silently after. Firefox launches the protocol directly (dev pref / the user's registered handler).
- `web-ext lint` is Firefox-only tooling; the `lint:ext` script lints `dist-firefox/` only. The Chrome zip is validated by the Chrome Web Store upload flow.
- Chrome assigns a **new tab id** when it discards a tab (verified on 150: `chrome.tabs.discard(766110265)` returns a tab with id `766110267`). Firefox keeps the id. Any flow that lists tabs and acts on them later — which is the whole shape of a bridge triage run — can therefore meet ids that no longer resolve even though the tabs still exist, so `bridge-methods.ts` appends `STALE_ID_HINT` to every "no such tab id" error rather than letting it read as "the tab was closed."
- Neither engine gives you a tab's real URL **until its navigation commits**, and they disagree on what they give you instead. Chrome reports `url: ""` and parks the target in the Chrome-only `pendingUrl`; Gecko reports `about:blank` (verified on Zen 1.21.9b) and exposes the target nowhere. So a tab caught mid-load looked address-less on Chrome — silently dropped from `tabs_list` and, far worse, from the undo log, making that one close unreversible. `bridge-methods.ts` reads both fields through the `tabUrl` helper; any new code reading `tab.url` on Chrome needs the same fallback. On Gecko the same close records `about:blank` and reopens blank, which is a limitation, not a bug we can fix — triage acts on tabs from a listing, which have long since committed.
- Chrome's **`tabs.remove` rejects the whole call on a duplicate id** ("No tab with id: N") — the first removal succeeds, the second finds nothing — so a batch containing the same id twice closes the tab _and_ reports failure. `parseTabsCloseParams` deduplicates before anything acts on the list.
- **`manifest.json` must keep its explicit `content_security_policy.extension_pages`.** Firefox's _default_ MV3 extension CSP includes `upgrade-insecure-requests`, and that directive rewrites WebSocket URLs too — `ws://127.0.0.1:4588/` silently becomes `wss://`, loopback included. The bridge sidecar then receives a TLS ClientHello, so Bun's `fetch` handler never runs and the connection is invisible from _both_ ends: nothing logged in gullet, and the extension sees only close code **1015** (TLS handshake failure). Declaring `"script-src 'self'; object-src 'self'"` explicitly drops the directive and the dial succeeds. If bridge connections start failing with 1015, this key is the first thing to check.

## Gullet (agent bridge sidecar)

`gullet/` is a sibling package, not part of the extension bundle: an MCP server over stdio on one side, a loopback WebSocket hub on the other. It shares `src/bridge-protocol.ts` with the extension so both ends are typechecked against one definition, has its own `gullet/tsconfig.json` (`lib: ES2022`, `types: bun-types` — no DOM, no `browser`), and has zero dependencies. It is excluded from the extension `tsconfig.json`'s `include`, so it never reaches `dist-*`. Setup and troubleshooting live in `gullet/README.md`.

Tests that stand up a real socket bind to port 0 for an ephemeral port. Diagnostics in gullet go to **stderr only** — stdout is the MCP transport and a stray `console.log` corrupts the session.

## Build, Test, and Development Commands

- `bun install`: install dependencies.
- `bun run build`: build both `dist-firefox/` and `dist-chrome/`.
- `bun run build:firefox` / `build:chrome`: single-target builds.
- `bun run typecheck`: typecheck the extension (`typecheck:ext`, `tsconfig.test.json` over `src/` + `tests/`) then the sidecar (`typecheck:gullet`).
- `bun run test`: run the Bun test suite under `tests/` and `gullet/tests/`.
- `bun run format` / `format:check`: run oxfmt over the tree (or check only).
- `bun run lint`: runs `lint:js` (oxlint) then `lint:ext` (Firefox `web-ext lint`).
- `bun run check`: typecheck + format:check + lint + test. Run before committing.
- `bun run start`: build firefox and launch Zen with the extension loaded from `dist-firefox/`.
- `bun run start:firefox`: build firefox and launch regular Firefox with a persistent dev profile.
- `bun run start:chrome`: build chrome and launch Chromium via `web-ext --target=chromium`.
- `bun run package`: produce both `tabglutton-firefox-<version>.zip` and `tabglutton-chrome-<version>.zip` in `web-ext-artifacts/`.

## Coding Style & Naming Conventions

Use TypeScript ES modules with explicit relative `.js` import specifiers, as in `import "./normalize.js"`. Keep strict typing clean under `tsconfig.json`; unused locals, unused parameters, implicit `any`, and switch fallthroughs are disallowed. Follow the current two-space indentation, double-quoted strings, trailing commas in multiline calls, and small exported functions/interfaces. Use kebab-case for filenames (`keep-newest.ts`) and camelCase for functions and variables.

## Testing Guidelines

Pure-module unit tests live in `tests/` and run via `bun test`. Each test file mirrors a module name (`normalize.test.ts`, `dedup.test.ts`, `clip-format.test.ts`, `storage.test.ts`, `bridge-protocol.test.ts`, `undo-log.test.ts`). Scope is intentionally limited to pure logic — browser-API surfaces (`background.ts`, `bridge-methods.ts`, `bridge-client.ts`, async `storage` helpers, the Defuddle content script) are exercised via `bun run start` or `bun run start:firefox` in a live browser. Sidecar tests live in `gullet/tests/`; `hub.test.ts` is the one exception to the pure-logic rule, standing up a real loopback socket to cover the handshake and request routing end to end. Test files are typechecked through `tsconfig.test.json` but excluded from `dist/` (the build still uses base `tsconfig.json`).

CI (`.github/workflows/ci.yml`) runs typecheck → test → format:check → oxlint → web-ext lint → package on every push and PR. Locally, `prek install` wires fast format/lint hooks into pre-commit; see `.pre-commit-config.yaml`.

## Version Control

This repo uses [jj](https://github.com/martinvonz/jj) in colocated mode — `.git` and `.jj` coexist, and standard `git` commands work normally on the working tree. **Default to plain `git` commands** (`git status`, `git diff`, `git log`, `git commit`, `git push`) for everyday VCS work. They are well-understood and produce predictable results.

Reach for `jj` only when its unique features are explicitly needed — e.g. `jj op log` / `jj undo` to recover from a mistake, `jj split` / `jj absorb` for hunk-level commit surgery, or `jj describe` to rewrite a description. Do not run `jj bookmark`, `jj rebase`, or other history-rewriting commands without checking with the user first; divergent change-ids and bookmark conflicts are easy to create and hard to clean up non-interactively.

## Versioning

Versions are `major.minor.patch.build`, and Firefox accepts **at most four parts**. The first three are the release version and are the only ones that belong in `package.json` / `manifest.json`; the fourth is a counter for signed test builds and is owned entirely by `bun run sign:dev`, which writes it into the artifact and a local git tag and then restores both files. Keeping `package.json` at three parts is also what lets `commit-and-tag-version` work at all — semver has no fourth position.

Committing a four-part version breaks that invariant (it happened once, in `ebbb933 Release 0.1.2.1`). `sign-dev.ts` now slices to the release triple so it cannot emit a five-part version AMO would reject, and counts the build number from `max(highest local tag, any fourth part in package.json)` — AMO requires versions to be unique and strictly increasing, and the tags are local and unpushed, so they are not trustworthy on their own. Bump the release version normally; let the build counter take care of itself.

## Commit & Pull Request Guidelines

The current history uses a concise imperative subject with optional scope detail, for example `Initial commit: tab dedup extension v1.1 (TypeScript)`. Keep subjects specific and near 72 characters when practical. Pull requests should describe the user-visible change, list verification commands, mention manifest or permission changes, and include screenshots when popup or options UI changes are visible.

## Security & Configuration Tips

Keep browser permissions in `manifest.json` minimal and justify new permissions in the PR. Do not commit generated profiles, packaged zips, or local browser state. WebExtension tooling should always target `dist-firefox/` or `dist-chrome/`, not source directories directly.
