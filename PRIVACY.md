# Privacy Policy — Tabglutton

_Last updated: 30 July 2026_

Tabglutton collects nothing. There is no analytics, no telemetry, no crash reporting, no
remote server, and no account. The developer receives no data from this extension of any
kind, and there is no mechanism in the code by which they could.

This document explains what the extension touches anyway, because "collects nothing" is
easy to say and worth being specific about.

## What is stored, and where

Everything Tabglutton stores lives in your browser's local extension storage
(`browser.storage.local`) on your own machine. It is never synced or transmitted.

| Data               | Why it exists                                                          |
| ------------------ | ---------------------------------------------------------------------- |
| Your settings      | Vault name, URL-normalization preferences, scope, clip mode            |
| Agent bridge token | Authenticates the local bridge, if you enable it                       |
| Undo log           | Title, URL, window and position of recently closed tabs, so Undo works |

The undo log is what makes every close reversible. It holds only the metadata needed to
reopen a tab — never page content — and it is trimmed as it ages.

Uninstalling the extension removes all of it.

## What happens to page content

When you Devour a tab (or an agent calls `tab_read` / `tab_clip`), Tabglutton runs
[Defuddle](https://github.com/kepano/defuddle) inside that page to extract the article
text, and converts it to markdown. That extraction happens entirely in your browser.

The result goes to exactly three places, all of them on your own computer:

1. **Your Obsidian vault**, through the `obsidian://` protocol. Because a URL cannot carry
   a long article, the note body is placed on your system clipboard and Obsidian reads it
   from there; the URL carries only the destination and the frontmatter. (You can switch
   to URL-only mode in settings, which avoids the clipboard at the cost of failing on long
   pages.)
2. **A markdown file in your download folder**, if you chose that destination in settings
   instead of Obsidian. It is written through the browser's own downloads API, touches no
   clipboard, and leaves the file exactly where every other download goes.
3. **A local MCP server**, but only if you have turned the agent bridge on. See below.

Page content is never written to extension storage, never sent over the public internet,
and never seen by the developer.

## The agent bridge

The bridge lets a coding agent on your machine — Claude Code, Codex, or anything else that
speaks MCP — work with your open tabs. It is **off until you turn it on**, and while it is
off no socket is opened at all.

When you do enable it:

- The connection is a WebSocket to `127.0.0.1` (loopback) only. It cannot leave your
  machine, and nothing outside your machine can reach it.
- Both ends authenticate with a shared token that you generate. The token itself never
  crosses the wire — each side proves it knows the token against a nonce the other side
  chose.
- The server checks the extension's origin before accepting a connection.
- **Waking discarded tabs is a second, separate opt-in**, because it is the only bridge
  operation that acts on a page rather than reading one.
- Every close made through the bridge is recorded in the undo log first and is reversible.
  If a tab cannot be recorded, it is left open rather than closed.

The MCP server (`gullet/`) runs on your machine, is spawned by your own agent harness, and
has zero third-party dependencies. Whatever your agent then does with the tab content it
reads is governed by that agent's own privacy policy, not this one.

## Permissions, and why each one is needed

| Permission               | Why                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `tabs`                   | Read tab titles and URLs to find duplicates and populate the triage list. This is the extension's core function.               |
| `<all_urls>` (`*://*/*`) | Inject the Defuddle extractor into whichever page you choose to clip. Tabglutton cannot know in advance which sites those are. |
| `scripting`              | Run that extractor in the page you selected.                                                                                   |
| `activeTab`              | Clip the current tab from the popup.                                                                                           |
| `storage`                | Persist the settings and undo log described above.                                                                             |
| `clipboardWrite`         | Hand a long note body to Obsidian, which a `obsidian://` URL cannot carry.                                                     |
| `alarms`                 | Drive the agent bridge's reconnect timer. Unused when the bridge is off.                                                       |
| `downloads` (optional)   | Write the clip as a markdown file, only if you pick that destination. Never requested otherwise, and revocable at any time.    |

The broad host permission is the one worth being precise about: it is a capability, not a
behaviour. Tabglutton does not run on pages in the background, does not read pages you have
not selected, and injects nothing until you press Devour or an agent calls a read tool on a
specific tab.

## No remote code

All code that runs is contained in the package you installed from the store. Nothing is
downloaded, evaluated, or executed from a remote source at runtime.

## Changes

Material changes to this policy will be noted in
[`CHANGELOG.md`](https://github.com/mlsimon734/tabglutton/blob/main/CHANGELOG.md) and the
date above updated.

## Contact

Questions, or a privacy problem you have found:
[open an issue](https://github.com/mlsimon734/tabglutton/issues) on the source repository.
The full source of everything described here is at
<https://github.com/mlsimon734/tabglutton>.
