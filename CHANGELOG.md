# Changelog

All notable changes to Tabglutton are documented here.

## [0.3.0](https://github.com/mlsimon734/tabglutton/compare/v0.2.0...v0.3.0) (2026-08-12)

Mostly about trusting the bridge on a real backlog: a clip is now confirmed on disk
before its tab is closed, and `tabs_list` is usable at the scale this product is for.

### Breaking

- **The bridge wire protocol is now 2, and mixed versions are refused rather than
  allowed to look successful.** Update the extension and Gullet together. A protocol-1
  Gullet would omit `tabs_list`'s limit and silently lose tabs; a protocol-1 extension
  would ignore `tab_clip`'s vault override and file the note somewhere the caller did
  not ask for. Neither is recoverable downstream and both would be reported as success.

### Features

- **`tabs_list` works on a large backlog.** Filter with a query, group by domain, and
  cap the result — and every answer reports `matched` and `truncated`, so a complete
  listing is distinguishable from a partial one. The tool description now pushes callers
  to triage on metadata before reading anything.
- **A clip is verified on disk before the tab closes.** Gullet runs beside the vault, so
  it can answer what the browser cannot: a refused `obsidian://` handoff is
  indistinguishable from a successful one from inside the extension. A note is matched by
  freshness, by the `source` it records, and by a SHA-256 of exactly the text handed to
  Obsidian — so a clip that never landed can no longer cost you the tab. Being unable to
  check is never treated as failure.
- **`tab_clip` can name its vault**, validated against Obsidian's own registry rather
  than trusted blindly.
- **Academic papers can route to Zotero** instead of Obsidian, opt-in and off by default,
  using the Zotero Connector's own classification rather than a hostname list. Requires a
  Connector exposing the external API — see `docs/ZOTERO_POC.md`.
- **Gullet is globally configurable and publishable.** Settings live at
  `${XDG_CONFIG_HOME:-$HOME/.config}/tabglutton/config.json`, which is deliberately safe
  to commit — an inline token is refused. Tokens resolve by an additive precedence chain
  ending at a `0600` file.

### Fixed

- **Obsidian handoffs no longer fail silently on Firefox.** The launch now goes through
  an extension-origin page, so the one-time external-protocol approval has a principal
  the browser can remember ([#18](https://github.com/mlsimon734/tabglutton/issues/18)).
- **A transient tab-read failure is retried** without masking a genuinely restricted page.
  Firefox reports both as `Missing host permission for the tab`, and a page on its
  restricted-domains list can never satisfy a retry, so those report the engine's own
  message instead of advice that cannot be followed.
- **The toolbar icon is the extension's own mark.** It had drifted to an unrelated
  drawing, unnoticed because the toolbar icon and the popup header are never in frame
  together; the copies are now pinned to each other by a test.
- **The cockpit's chrome floats over the list** rather than displacing it.

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
