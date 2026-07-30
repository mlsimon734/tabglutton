<div align="center">

# Tabglutton

**Devour a sprawling tab list.** Close duplicates, file the keepers into Obsidian —
or hand the whole backlog to a coding agent and let it triage.

For [Zen Browser](https://zen-browser.app/), Firefox, and Chrome.

[![ci](https://github.com/mlsimon734/tabglutton/actions/workflows/ci.yml/badge.svg)](https://github.com/mlsimon734/tabglutton/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![firefox](https://img.shields.io/badge/Firefox-MV3-FF7139?logo=firefoxbrowser&logoColor=white)](#install)
[![chrome](https://img.shields.io/badge/Chrome-120%2B-4285F4?logo=googlechrome&logoColor=white)](#install)
[![zen](https://img.shields.io/badge/Zen%20Browser-supported-F76F53)](#scope)
[![bun](https://img.shields.io/badge/built%20with-Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![mcp](https://img.shields.io/badge/MCP-server-8A63D2)](#agent-bridge)
[![no telemetry](https://img.shields.io/badge/telemetry-none-4f6a3a)](#privacy)

</div>

---

<!-- DEMO SLOT
     These stills are honest but static. The asset worth having is a ~20s screen
     recording of the cockpit emptying a real backlog: filter → select → Devour →
     notes landing in Obsidian → Undo. Record at 1440×900, export GIF under 10 MB
     (GitHub's attachment cap), drop it at docs/media/demo.gif, and put it above
     the <picture> block below.
-->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/cockpit-dark.png">
  <img alt="Tabglutton's Devour cockpit: open tabs grouped by host, with duplicates detected" src="docs/media/cockpit-light.png">
</picture>

## The problem

You open thirty tabs a day out of mild interest. Some are honest duplicates — the same
thread reached from two links, the same repo opened twice. Most are things you've already
mentally finished but don't want to lose. They belong in a notes vault, not in the tab
strip. So they sit there, and by Friday there are four hundred of them.

Tabglutton does three things about that.

## What it does

### 1. Dedup

The toolbar badge counts duplicate tabs in scope. Open the popup to see them grouped by
canonical URL, then close them all in one action — the keeper is chosen by `lastAccessed`,
then `active`, then `pinned`. A toast offers Undo for ~6 seconds and restores tabs to
their original positions.

URLs are canonicalized first (`src/normalize.ts`): lowercased host, `www.` and trailing
slash stripped, tracking params (`utm_*`, `fbclid`, `gclid`, `si`, …) dropped, remaining
params sorted, and optionally the `#fragment` removed.

### 2. Devour → Obsidian

Select tabs and hit **Devour**. Each one is read through
[Defuddle](https://github.com/kepano/defuddle) — the same extractor behind Obsidian's own
Web Clipper — formatted as markdown with frontmatter (title, source URL, author, site,
published date), filed into your vault under `Clippings/`, and closed.

The full-screen **Devour cockpit** (`Alt+Shift+D`) is the workspace for this: tabs grouped
by host, an inspector previewing exactly where each note will land, and keyboard triage
throughout — `j`/`k` to move, `space` to toggle, `d` to devour, `x` to close, `/` to filter.

### 3. Agent bridge <a id="agent-bridge"></a>

This is the part that isn't like other tab extensions.

Tabglutton ships **Gullet**, a local MCP server. Turn the bridge on in settings, point
Claude Code or Codex at it, and your agent can work your actual open tabs:

| Tool         | What it does                                            |
| ------------ | ------------------------------------------------------- |
| `tabs_list`  | Metadata for every tab in scope — cheap across hundreds |
| `tab_read`   | Full Defuddle extraction of one page                    |
| `tabs_load`  | Wake tabs the browser unloaded, so they become readable |
| `tab_clip`   | File a tab into Obsidian, optionally closing it         |
| `tabs_close` | Close a batch, returning a `batchId`                    |
| `undo_close` | Reverse any batch                                       |

So "go through my 400 tabs, tell me what's worth keeping, clip the good ones and close the
noise" becomes a thing you can actually ask for. The agent triages on metadata first, reads
only the survivors, and every close is reversible.

**It is deliberately hard to make this dangerous.** The bridge is off until you enable it.
It binds loopback only, authenticates with a shared token that never crosses the wire
(both ends prove knowledge of it against a nonce the other side chose), and checks the
extension origin. Waking tabs is a _second_, separate opt-in, because it's the only method
that acts on a page rather than reading one. Nothing is ever closed that the undo log
couldn't put back — if a tab can't be recorded, it's left open and reported as skipped.

Setup lives in [`gullet/README.md`](gullet/README.md); the design rationale, wire protocol,
and a long list of hard-won browser quirks are in [`BRIDGE.md`](BRIDGE.md).

## Install

Not in the add-on stores yet. Two ways to run it today:

**From source** (either browser):

```bash
bun install
bun run build              # → dist-firefox/ and dist-chrome/
```

- **Firefox / Zen** — `about:debugging` → This Firefox → Load Temporary Add-on → pick any
  file in `dist-firefox/`. For an install that survives restarts, see
  [signing](#dogfooding-a-signed-build).
- **Chrome** — `chrome://extensions` → enable Developer mode → Load unpacked →
  `dist-chrome/`. Chrome ignores the manifest's suggested shortcuts, so bind
  `Alt+Shift+G` (popup) and `Alt+Shift+D` (cockpit) yourself at
  `chrome://extensions/shortcuts`.

**Dev loop:**

```bash
bun start                  # build + launch Zen with the extension loaded
bun run start:firefox      # same, against regular Firefox
bun run start:chrome       # same, against Chromium
bun run check              # typecheck + format + lint + test — run before committing
```

## Scope

Zen has no workspace API for extensions, so "active workspace" is a heuristic:
`tab.hidden === false`. If it looks broken (every tab in the window reads as visible) the
popup warns you and you can fall back to "current window only" in settings. Regular Firefox
and Chrome have no workspaces, so they use current-window scope directly.

## Privacy

No analytics, no telemetry, no remote server, no account. Page content is extracted
in-page and goes exactly two places: your Obsidian vault, and — only if you turn the bridge
on — a loopback socket to an MCP server running on your own machine. The extension
requests no permissions beyond what dedup and clipping need.

## Settings

Right-click the toolbar icon → Manage Extension → Preferences.

- **Strip URL fragment** (default on) — treat `page#a` and `page#b` as the same URL.
- **Extra params to strip** — additional query params beyond the built-in tracking list.
- **Scope** — active workspace (Zen heuristic) or current window only.
- **Obsidian vault** — required for Devour; ignored by dedup.
- **Agent bridge** — off by default. Enable, generate a token, optionally allow tab loading.

## Dogfooding a signed build

To run on your real profile so it survives restarts, sign through Mozilla AMO's _unlisted_
channel (signed, not publicly listed). Create an AMO account, generate JWT credentials,
then:

```bash
cp .env.sample .env        # fill in WEB_EXT_API_KEY / WEB_EXT_API_SECRET
bun run sign               # builds, uploads, signs → web-ext-artifacts/*.xpi
```

Drag the `.xpi` onto `about:addons`. Upgrades are in-place and preserve extension storage.
Versions are `major.minor.patch.build`; bump the release triple normally and let
`bun run sign:dev` own the fourth part.

## Architecture

TypeScript compiled by Bun into `dist-firefox/` and `dist-chrome/` from one shared source
tree. `manifest.json` describes the Firefox shape and is patched in memory for Chrome;
`src/target.ts` is the single compile-time switch. Chrome additionally gets
`webextension-polyfill` inlined into a bundled service worker.

| Path                                         | Role                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `src/background.ts`                          | Event wiring, badge, tab readiness                      |
| `src/dedup.ts` · `src/normalize.ts`          | Duplicate planning and URL canonicalization             |
| `src/clip-current.ts` · `src/clip-format.ts` | Defuddle extraction → markdown → `obsidian://`          |
| `src/bridge-*.ts` · `src/undo-log.ts`        | Agent bridge client, wire protocol, reversible closes   |
| `gullet/`                                    | MCP server + loopback WebSocket hub (zero dependencies) |
| `popup/` · `options/` · `onboarding/`        | UI surfaces, sharing one token system                   |

Contributor notes are in [`AGENTS.md`](AGENTS.md) — including a fairly brutal catalogue of
cross-browser behaviours that cost real debugging time (Chrome minting new tab ids on
discard, Gecko's failed-WebSocket reconnect penalty, CSP silently upgrading `ws://` to
`wss://`, and more).

## Acknowledgements

Page extraction is powered by [Defuddle](https://github.com/kepano/defuddle) by Steph Ango
([@kepano](https://github.com/kepano)), MIT licensed. Type is
[Vollkorn](https://github.com/FAlthausen/Vollkorn-Typeface) by Friedrich Althausen and
[Geist](https://github.com/vercel/geist-font) by Vercel, both under the SIL Open Font
License. All three licenses ship with the packaged extension under `THIRD_PARTY_LICENSES/`.

## License

[MIT](LICENSE) © Michael Simon
