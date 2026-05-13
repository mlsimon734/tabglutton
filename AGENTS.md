# Repository Guidelines

## Project Structure & Module Organization

This is a Bun-powered TypeScript WebExtension for Zen Browser and Firefox; the product is "Tabglutton". Core logic lives in `src/`: `background.ts` wires browser events, `dedup.ts` plans duplicate tab closures (keeper-selection lives in `pickKeeper` here, not in a separate policy module), `normalize.ts` canonicalizes URLs, `storage.ts` handles settings, `clip-current.ts` is the Defuddle-based content extractor injected into pages by Devour, and `clip-format.ts` builds the Obsidian markdown + frontmatter and the `obsidian://new` URL. Popup UI files are in `popup/`, options UI files are in `options/`, and static assets are in `icons/`. `manifest.json` defines permissions and entry points. `build.ts` compiles TypeScript and copies assets into `dist/`; treat `dist/`, `.dev-profile*`, and `web-ext-artifacts/` as generated output.

## Build, Test, and Development Commands

- `bun install`: install dependencies.
- `bun run build`: type-compile sources and prepare `dist/`.
- `bun run typecheck`: run `tsc --noEmit -p tsconfig.test.json` (covers `src/` + `tests/`).
- `bun run test`: run the Bun test suite under `tests/`.
- `bun run format` / `format:check`: run oxfmt over the tree (or check only).
- `bun run lint`: runs `lint:js` (oxlint) then `lint:ext` (build + `web-ext lint`).
- `bun run check`: typecheck + format:check + lint + test. Run before committing.
- `bun run start`: build and launch Zen Browser with the extension loaded from `dist/`.
- `bun run start:firefox`: build and launch regular Firefox with a persistent dev profile.
- `bun run package`: build a zip in `web-ext-artifacts/`.

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

Keep browser permissions in `manifest.json` minimal and justify new permissions in the PR. Do not commit generated profiles, packaged zips, or local browser state. WebExtension tooling should always target `dist/`, not source directories directly.
