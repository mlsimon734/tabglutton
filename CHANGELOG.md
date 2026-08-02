# Changelog

All notable changes to Tabglutton are documented here.

## [0.2.0](https://github.com/mlsimon734/tabglutton/compare/v0.1.2...v0.2.0) (2026-08-01)

First public release. Every earlier 0.1.x was an unlisted build signed for local
testing, so all of this is new to anyone installing from a store.

### Features

- **Dedup.** Finds duplicate tabs by canonicalized URL — fragments and tracking
  parameters stripped, with the strip list configurable — and closes all but one
  keeper. Scoped to the current window, or to visible tabs where the browser
  exposes that. Needs no access to page content.
- **Devour.** A full-screen cockpit over the open tabs, grouped by host with
  duplicates flagged and a per-tab inspector showing exactly where a clip will
  land. Every close is undoable from a toast.
- **Obsidian clipping.** Pages are extracted with Defuddle and filed as markdown
  with Web Clipper-compatible frontmatter, by clipboard handoff or `obsidian://`.
  Per-site subfolder routing and a configurable Clippings folder.
- **Chrome support** alongside Firefox and Zen, from one source tree.
- **Agent bridge.** An MCP sidecar (Gullet) exposing six tools — `tabs_list`,
  `tabs_load`, `tab_read`, `tab_clip`, `tabs_close`, `undo_close` — over a
  token-authenticated loopback WebSocket, so an agent can triage a tab backlog.
  Off until switched on. Several agent sessions share one browser connection,
  and nothing is closed that `undo_close` could not put back.
- **Automatic bridge port.** Both ends discover each other across a small
  ordered candidate set, so there is no port to configure and nothing to keep in
  sync. A fixed port remains available for advanced setups.
- **First-run onboarding**, and a settings page that opens in a tab or embedded
  in the Add-ons Manager.

### Changed

- Chrome asks for site access at first use rather than at install, so the
  install prompt no longer warns about reading data on all websites. Dedup — the
  default flow — never needs it.
- Note names are sanitized per platform (Windows, macOS, other) rather than
  applying the macOS rules everywhere, matching Obsidian Web Clipper on each.

## [0.1.1](https://github.com/mlsimon734/zen-map-reduce/compare/v0.1.1-alpha.1...v0.1.1) (2026-05-16)

## 0.1.1-alpha.1 (2026-05-16)
