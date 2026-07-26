# Gullet

The sidecar half of Tabglutton's agent bridge — the pipe tab content passes through on its
way to a coding agent. One side is an **MCP server over stdio**, spawned by whatever agent
harness you use; the other is a **WebSocket server on loopback** that browsers running
Tabglutton dial into.

Architecture, trust boundary, and phasing live in [`../BRIDGE.md`](../BRIDGE.md). This file
is the setup guide.

```
Claude Code ──MCP (stdio)──► Gullet ──WebSocket (127.0.0.1:4588)──► Zen / Firefox / Chrome
```

Zero dependencies: it runs on Bun's built-ins alone, so there is nothing to install beyond
having the repo checked out.

## Setup

1. **Turn the bridge on in the browser.** Tabglutton → Settings → _Agent bridge_ → enable,
   then **Generate** a token and copy it. The bridge is off until you do this, and no
   socket is opened while it is off.

2. **Register Gullet with your agent.** The settings page renders a ready-made config with
   your token and port filled in — _Copy config_ and paste it into `.mcp.json` (or
   `~/.claude.json`), replacing the placeholder path with wherever you cloned this repo:

   ```json
   {
     "mcpServers": {
       "gullet": {
         "command": "bun",
         "args": ["run", "/path/to/tabglutton/gullet/gullet.ts", "--port", "4588"],
         "env": { "GULLET_TOKEN": "<token from the settings page>" }
       }
     }
   }
   ```

   For Claude Code specifically:

   ```sh
   claude mcp add gullet --env GULLET_TOKEN=<token> -- bun run /path/to/tabglutton/gullet/gullet.ts
   ```

3. **Start a session.** The agent spawns Gullet, Gullet opens the port, and the extension's
   reconnect loop finds it within ~30 seconds. The toolbar badge shows a terracotta dot
   while the connection is live. When the session ends, Gullet exits and the extension goes
   back to idle dialling.

There is no app to launch and no per-session step. Multiple browsers can be connected at
once — a Zen window and a Chrome profile, say — and each tool call picks one with the
`browser` argument.

## Configuration

| Flag      | Env            | Default | Notes                                                                              |
| --------- | -------------- | ------- | ---------------------------------------------------------------------------------- |
| `--port`  | `GULLET_PORT`  | `4588`  | Must match the port in Tabglutton's settings.                                      |
| `--token` | `GULLET_TOKEN` | —       | Required. Prefer the env var: process arguments are readable by other local users. |

Diagnostics go to **stderr**; stdout is the MCP transport and carries nothing else.

## Tools

| Tool         | What it does                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs_list`  | Metadata for every open tab — id, title, url, `lastAccessed`, `discarded`, `pinned`, `active`, window, and `hidden` on Firefox/Zen. No page content, so it stays cheap across hundreds of tabs. |
| `tab_read`   | Extracts one loaded tab as clean markdown via Defuddle.                                                                                                                                         |
| `tab_clip`   | Files a tab into Obsidian exactly as the popup's Devour does. Optionally closes it after.                                                                                                       |
| `tabs_close` | Closes tabs. Records the batch first and returns a `batchId`.                                                                                                                                   |
| `undo_close` | Reopens a recorded batch.                                                                                                                                                                       |

Deliberately absent: navigate, click, type, evaluate. The agent can read what you already
chose to open, file it, and clean up — it cannot act as you. Adding anything richer means
revisiting the prompt-injection posture in `BRIDGE.md` first.

`tabs_list` with no `browser` argument fans out across every connected browser and tags
each tab with its origin. The tab-scoped tools refuse to guess between two browsers, since
tab ids only mean something within one.

## Suggested workflow

Triage on metadata first. In a 300-tab backlog most tabs are discarded (unloaded), and
`tab_read` cannot reach those — it fails with `tab-discarded` so the agent can report
"needs manual load" rather than retrying. Cutting on title, URL, and age before reading
anything is also what makes triaging that many tabs affordable in tokens.

## Troubleshooting

**"No browser is connected."** The bridge is off in Tabglutton's settings, no token has
been generated, the ports do not match, or the browser has not re-dialled yet — the retry
alarm runs on a 30s cadence, on Firefox too. The settings page shows live connection
status.

**The browser dials but nothing reaches Gullet.** If the extension's console shows a
WebSocket close code of **1015** and Gullet logs nothing at all, the extension CSP is
upgrading `ws://` to `wss://` and Gullet is being handed a TLS ClientHello. `manifest.json`
must declare `content_security_policy.extension_pages` explicitly — Firefox's MV3 default
includes `upgrade-insecure-requests`, which does this to loopback WebSockets as well.

**"Token mismatch."** `GULLET_TOKEN` and the token in Tabglutton's settings differ.
Regenerating the token in settings invalidates any sidecar still holding the old one.

**"could not listen on 127.0.0.1:4588"** Another Gullet — usually from a second agent
session — already holds the port. One sidecar can serve several browsers, but two sidecars
cannot share a port; give the second one a different `--port` and match it in settings.

**Nothing in the logs.** Gullet writes to stderr, which most agent harnesses hide. Run it
by hand to watch it:

```sh
GULLET_TOKEN=<token> bun run gullet/gullet.ts
```

Then poke the socket directly:

```sh
bunx wscat -c ws://127.0.0.1:4588 -H 'Origin: moz-extension://test'
```

You should get a `challenge` frame back. Without the `Origin` header the upgrade is
refused with 403 — that check is what stops a hostile web page from opening the socket
from inside your browser.

## Development

```sh
bun run typecheck:gullet   # from the repo root
bun test                   # protocol, config, selection, MCP, and a live-socket hub test
```

The wire contract lives in [`../src/bridge-protocol.ts`](../src/bridge-protocol.ts) and is
imported by both halves, so extension and sidecar are typechecked against one definition.
