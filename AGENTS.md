# Repository Guidelines

## Project Structure & Module Organization

This is a Bun-powered TypeScript WebExtension for Zen Browser, Firefox, and Chrome; the product is "Tabglutton". Core logic lives in `src/`: `background.ts` wires browser events, `dedup.ts` plans duplicate tab closures (keeper-selection lives in `pickKeeper` here, not in a separate policy module), `normalize.ts` canonicalizes URLs, `storage.ts` handles settings, `clip-current.ts` is the Defuddle-based content extractor injected into pages by Devour, `clip-format.ts` builds the Obsidian markdown + frontmatter and the `obsidian://new` URL, and `target.ts` exposes `IS_CHROME` / `IS_FIREFOX` for the few places that need to branch by target. Popup UI files are in `popup/`, options UI files are in `options/`, the Chrome-only `obsidian://` launch shim is in `redirect/`, and static assets are in `icons/`. `manifest.json` defines the Firefox shape and is patched in memory for Chrome. `build.ts` accepts `--target=firefox|chrome|all` and writes `dist-firefox/` or `dist-chrome/`; treat `dist-firefox/`, `dist-chrome/`, `.dev-profile*`, and `web-ext-artifacts/` as generated output.

## Cross-browser build

- Sources stay shared. `src/target.ts` is checked in with `TARGET = "firefox"`. For the Chrome build, `build.ts` overwrites the compiled `dist-chrome/src/target.js` to flip the constant — sources are never mutated.
- Chrome uses `webextension-polyfill` so the `browser.*` call sites keep working. The Chrome service worker is bundled with `Bun.build` (polyfill inlined). Popup/options HTML pages get `<script src="../vendor/browser-polyfill.js"></script>` injected before the module script tag.
- Chrome manifest differences (applied in memory in `build.ts`): drop `browser_specific_settings`, swap `background.scripts` → `background.service_worker`, swap SVG icons → PNG (`icons/icon-chomp-{16,32,48,128}.png`, rasterized via `rsvg-convert`), set `minimum_chrome_version: "116"`.
- Chrome has no `tab.hidden` and no `getBrowserInfo`; `storage.ts` defaults `scope` to `"current-window"` on Chrome, `background.ts` short-circuits `probeHeuristic` and the `hidden: false` query branch, and the options page hides the scope radio group.
- Chrome rejects the Firefox-only `tabs.onUpdated` filter argument (`{ properties: [...] }`) with "This event does not support filters" — at top level that aborts service-worker registration. `background.ts` registers through the `onTabUpdated` helper, which drops the filter on Chrome (the callbacks already guard on `changeInfo.status`).
- `clip-current.js` is injected as a content script via `scripting.executeScript({ files })`. Chrome validates it with `base::IsStringUTF8`, which — unlike plain UTF-8 validity — rejects Unicode noncharacters / unpaired surrogates (e.g. a raw `U+FFFF` the minifier emits inside a Defuddle regex range), reporting "It isn't UTF-8 encoded." `build.ts` escapes those to `\uXXXX` after bundling (`escapeChromeUnsafeCodePoints`); Firefox skips the check.
- The `obsidian://` clip handoff launches through the extension-origin page `redirect/obsidian-redirect.html` on Chrome instead of a direct `tabs.create({ url: "obsidian://…" })`. Chrome only offers a rememberable "Always allow" for a protocol launch that has a page origin; a browser-initiated launch prompts on every clip. The one-time `chrome-extension://<id>` approval is bootstrapped by the onboarding ping (same origin), so clips fire silently after. Firefox launches the protocol directly (dev pref / the user's registered handler).
- `web-ext lint` is Firefox-only tooling; the `lint:ext` script lints `dist-firefox/` only. The Chrome zip is validated by the Chrome Web Store upload flow.

## Build, Test, and Development Commands

- `bun install`: install dependencies.
- `bun run build`: build both `dist-firefox/` and `dist-chrome/`.
- `bun run build:firefox` / `build:chrome`: single-target builds.
- `bun run typecheck`: run `tsc --noEmit -p tsconfig.test.json` (covers `src/` + `tests/`).
- `bun run test`: run the Bun test suite under `tests/`.
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

Pure-module unit tests live in `tests/` and run via `bun test`. Each test file mirrors a module name (`normalize.test.ts`, `dedup.test.ts`, `clip-format.test.ts`, `storage.test.ts`). Scope is intentionally limited to pure logic — browser-API surfaces (`background.ts`, async `storage` helpers, the Defuddle content script) are exercised via `bun run start` or `bun run start:firefox` in a live browser. Test files are typechecked through `tsconfig.test.json` but excluded from `dist/` (the build still uses base `tsconfig.json`).

CI (`.github/workflows/ci.yml`) runs typecheck → test → format:check → oxlint → web-ext lint → package on every push and PR. Locally, `prek install` wires fast format/lint hooks into pre-commit; see `.pre-commit-config.yaml`.

## Version Control

This repo uses [jj](https://github.com/martinvonz/jj) in colocated mode — `.git` and `.jj` coexist, and standard `git` commands work normally on the working tree. **Default to plain `git` commands** (`git status`, `git diff`, `git log`, `git commit`, `git push`) for everyday VCS work. They are well-understood and produce predictable results.

Reach for `jj` only when its unique features are explicitly needed — e.g. `jj op log` / `jj undo` to recover from a mistake, `jj split` / `jj absorb` for hunk-level commit surgery, or `jj describe` to rewrite a description. Do not run `jj bookmark`, `jj rebase`, or other history-rewriting commands without checking with the user first; divergent change-ids and bookmark conflicts are easy to create and hard to clean up non-interactively.

## Commit & Pull Request Guidelines

The current history uses a concise imperative subject with optional scope detail, for example `Initial commit: tab dedup extension v1.1 (TypeScript)`. Keep subjects specific and near 72 characters when practical. Pull requests should describe the user-visible change, list verification commands, mention manifest or permission changes, and include screenshots when popup or options UI changes are visible.

## Security & Configuration Tips

Keep browser permissions in `manifest.json` minimal and justify new permissions in the PR. Do not commit generated profiles, packaged zips, or local browser state. WebExtension tooling should always target `dist-firefox/` or `dist-chrome/`, not source directories directly.
