# Tabglutton

A Firefox / Zen Browser extension that devours your sprawling tab list — closing duplicates in a workspace, or saving pages into your Obsidian vault and closing them.

## Why

Zen workspaces accumulate tabs fast. Some are honest duplicates (the same Reddit thread opened twice, the same blog post followed from two different links, the same X post via a notification). Others are pages you've already mentally finished with but want to keep — they belong in a notes vault, not in the tab strip. Tabglutton handles both: it deduplicates on demand, and it offers a one-click pipeline from open tab to Obsidian note.

## What it does

### Close duplicate tabs

The toolbar icon shows a red badge with the number of duplicate tabs currently in scope. Open the popup to see them grouped by canonical URL.

- **Dedup** button: closes duplicates across all groups in one action, keeping the best tab per group. The keeper is chosen by `lastAccessed` (most recently focused wins), then `active`, then `pinned` — see `src/dedup.ts:pickKeeper`.
- **Per-tab actions**: pick which copy to close yourself, or focus an existing tab instead of closing.
- **Undo**: a toast appears for ~6 seconds after a bulk close. Click Undo to reopen the closed tabs in their original positions.

### Devour → Obsidian

Select tabs in the popup and click **Devour**. For each selected tab, Tabglutton:

1. injects a Defuddle-based extractor into the page (`src/clip-current.ts`),
2. formats the result as markdown with frontmatter — title, source URL, author, site, published date (`src/clip-format.ts:markdownForClip`),
3. opens an `obsidian://new` URL targeting your configured vault, filed under `Clippings/` with the page title as the note name (`src/clip-format.ts:obsidianNewNoteUrl`),
4. closes the original tab.

Requires the **Obsidian vault** option to be set. Only `http(s)` pages are clippable.

## Scope

- **Zen Browser**: tries to scope to the _active workspace_ by filtering on `tab.hidden === false`. Zen's workspace API is not exposed to extensions — this is a heuristic. If the heuristic looks broken (every tab in the window is "visible"), the popup shows a warning and you can fall back to "current window only" in options.
- **Regular Firefox**: scope falls through to "current window only" since Firefox has no workspaces.

## Settings

Open via right-click → Manage Extension → Preferences.

- **Strip URL fragment** (default ON): treat `page#a` and `page#b` as the same URL when grouping.
- **Extra params to strip**: comma-separated query params to drop in addition to the built-in tracking-param list.
- **Scope**: `Active workspace (Zen)` (the `hidden-false` heuristic) or `Current window only`.
- **Obsidian vault**: vault name used by Devour. Required for clipping; ignored by dedup.

## URL normalization

Used to canonicalize URLs before grouping (see `src/normalize.ts`):

- lowercase host, strip leading `www.`, strip trailing `/`,
- drop these query params: `utm_*`, `fbclid`, `gclid`, `ysclid`, `msclkid`, `ref`, `ref_src`, `ref_url`, `mc_cid`, `mc_eid`, `_ga`, `igshid`, `si`,
- sort remaining params alphabetically,
- optionally strip `#fragment`.

## Keyboard shortcut

`Alt+Shift+D` opens the popup. Inside the popup, `/` focuses the search field.

## Install (development)

```bash
bun install
bun start              # build (TypeScript → dist/) + launch Zen with the extension loaded
bun run start:console  # same, with Zen's Browser Console open for chrome logs
bun run start:firefox  # same, against regular Firefox
bun run lint           # type-check + manifest/WebExtension lint
bun run build          # one-shot TS compile + asset copy into dist/
bun run watch          # tsc --watch for fast iteration (run alongside bun start)
bun run typecheck      # tsc --noEmit
bun run package        # produce an unsigned .zip (for CI artifact / web-ext lint)
```

The toolchain: TypeScript compiles `src/`, `popup/`, `options/` into `dist/` mirroring the structure; static assets (HTML, CSS, manifest, icons) are copied alongside. `web-ext` runs against `dist/` only — never against source. The `dist/` directory is gitignored.

## Install (dogfood / signed)

To run Tabglutton on your real Zen profile (not a `.dev-profile`) so it survives restarts, sign the build via Mozilla AMO's unlisted channel and drag the resulting `.xpi` into Zen. AMO unlisted means the addon is signed but not publicly listed in the store.

**One-time setup**:

1. Create a Mozilla AMO developer account at https://addons.mozilla.org/developers/.
2. Generate JWT credentials at https://addons.mozilla.org/developers/addon/api/key/.
3. Store them in `~/.config/tabglutton/amo-credentials` (chmod 600):

   ```bash
   export WEB_EXT_API_KEY="user:XXXX:YYY"
   export WEB_EXT_API_SECRET="<64 hex chars>"
   ```

**Sign and install**:

```bash
source ~/.config/tabglutton/amo-credentials
bun run sign
```

`web-ext` uploads `dist/` to AMO, which lints and typically auto-signs in minutes for the unlisted channel. The signed `.xpi` lands in `web-ext-artifacts/tabglutton-<version>.xpi`.

Open Zen → `about:addons` → drag the `.xpi` onto the page (or use the gear menu → "Install Add-on from File") → accept the install prompt.

Rare: broad host permissions can route the first submission to human review. If `web-ext` exits with a "pending review" message, watch the AMO developer dashboard / email — meanwhile, `bun start` is the right temporary fallback.

**Updating**: bump `version` in both `manifest.json` and `package.json` (AMO rejects re-uploads of the same version), then re-run `bun run sign` and drag the new `.xpi` into `about:addons`. The upgrade is in-place; extension storage is preserved.

## Roadmap

The current build does dedup and clip-to-Obsidian by direct rules. A planned next step is to put a local Claude Code or Codex agent on the loop — looking at each open tab and proposing keep / clip / discard, with the user approving. The Devour pipeline is the seam where that swaps in.

## Acknowledgements

Devour's page extraction is powered by [Defuddle](https://github.com/kepano/defuddle) by Steph Ango ([@kepano](https://github.com/kepano)), used under the MIT license. Defuddle is the same engine behind Obsidian's Web Clipper, which makes it a natural fit for this extension's "page → markdown → Obsidian vault" pipeline. The packaged extension ships Defuddle's license alongside the bundled code under `THIRD_PARTY_LICENSES/`.
