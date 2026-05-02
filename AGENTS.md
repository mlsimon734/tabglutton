# Repository Guidelines

## Project Structure & Module Organization

This is a Bun-powered TypeScript WebExtension for Zen Browser and Firefox (product name "Reduce"; the gecko addon ID remains `tab-dedup@addons.local` for install continuity). Core logic lives in `src/`: `background.ts` wires browser events, `dedup.ts` plans duplicate tab closures (keeper-selection lives in `pickKeeper` here, not in a separate policy module), `normalize.ts` canonicalizes URLs, `storage.ts` handles settings, `clip-current.ts` is the Defuddle-based content extractor injected into pages by Clip Reduce, and `clip-format.ts` builds the Obsidian markdown + frontmatter and the `obsidian://new` URL. Popup UI files are in `popup/`, options UI files are in `options/`, and static assets are in `icons/`. `manifest.json` defines permissions and entry points. `build.ts` compiles TypeScript and copies assets into `dist/`; treat `dist/`, `.dev-profile*`, and `web-ext-artifacts/` as generated output.

## Build, Test, and Development Commands

- `bun install`: install dependencies.
- `bun run build`: type-compile sources and prepare `dist/`.
- `bun run typecheck`: run `tsc --noEmit` without producing output.
- `bun run lint`: build, then run `web-ext lint` against `dist/`.
- `bun run start`: build and launch Zen Browser with the extension loaded from `dist/`.
- `bun run start:firefox`: build and launch regular Firefox with a persistent dev profile.
- `bun run package`: build a zip in `web-ext-artifacts/`.

## Coding Style & Naming Conventions

Use TypeScript ES modules with explicit relative `.js` import specifiers, as in `import "./normalize.js"`. Keep strict typing clean under `tsconfig.json`; unused locals, unused parameters, implicit `any`, and switch fallthroughs are disallowed. Follow the current two-space indentation, double-quoted strings, trailing commas in multiline calls, and small exported functions/interfaces. Use kebab-case for filenames (`keep-newest.ts`) and camelCase for functions and variables.

## Testing Guidelines

There is no dedicated automated test suite yet. For every change, run `bun run typecheck` and `bun run lint`; use `bun run start` or `bun run start:firefox` for live browser checks. If adding tests, colocate them near the related module or under `tests/`, name them after the behavior under test, such as `normalize.test.ts`, and prioritize pure modules like `normalize.ts` and `dedup.ts`.

## Commit & Pull Request Guidelines

The current history uses a concise imperative subject with optional scope detail, for example `Initial commit: tab dedup extension v1.1 (TypeScript)`. Keep subjects specific and near 72 characters when practical. Pull requests should describe the user-visible change, list verification commands, mention manifest or permission changes, and include screenshots when popup or options UI changes are visible.

## Security & Configuration Tips

Keep browser permissions in `manifest.json` minimal and justify new permissions in the PR. Do not commit generated profiles, packaged zips, or local browser state. WebExtension tooling should always target `dist/`, not source directories directly.
