# Gullet

The sidecar half of Tabglutton's agent bridge — the pipe tab content passes through on its
way to a coding agent. One side is an **MCP server over stdio**, spawned by whatever agent
harness you use; the other is a **WebSocket server on loopback** that browsers running
Tabglutton dial into.

Architecture, trust boundary, and phasing live in [`../BRIDGE.md`](../BRIDGE.md). This file
is the setup guide.

```
Claude Code ──MCP (stdio)──► Gullet ──WebSocket (127.0.0.1:4589)──► Zen / Firefox / Chrome
```

Zero dependencies: it runs on Bun's built-ins alone, so there is nothing to install beyond
having the repo checked out.

**Two names, one product.** "Gullet" is the internal name for this sidecar; everything a
user or an agent sees says **Tabglutton**. So the MCP server registers as `tabglutton`, the
tools appear under that namespace, and the token is `TABGLUTTON_TOKEN`. `GULLET_TOKEN` and
`GULLET_PORT` still work as aliases.

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
       "tabglutton": {
         "command": "bun",
         "args": ["run", "/path/to/tabglutton/gullet/gullet.ts", "--port", "4589"],
         "env": { "TABGLUTTON_TOKEN": "<token from the settings page>" }
       }
     }
   }
   ```

   For Claude Code specifically:

   ```sh
   claude mcp add tabglutton --env TABGLUTTON_TOKEN=<token> -- bun run /path/to/tabglutton/gullet/gullet.ts
   ```

3. **Start a session.** The agent spawns Gullet, Gullet opens the port, and the extension's
   reconnect loop finds it — typically within a few seconds (it re-probes the port every 3s
   while the browser's extension page is awake), worst case ~30 seconds (the alarm cadence,
   when the page had suspended). The toolbar badge shows a terracotta dot while the
   connection is live. When the session ends, Gullet exits and the extension goes back to
   idle dialling.

There is no app to launch and no per-session step. Multiple browsers can be connected at
once — a Zen window and a Chrome profile, say — and each tool call picks one with the
`browser` argument.

## Configuration

| Flag      | Env                | Default | Notes                                                                              |
| --------- | ------------------ | ------- | ---------------------------------------------------------------------------------- |
| `--port`  | `TABGLUTTON_PORT`  | `4589`  | Must match the port in Tabglutton's settings.                                      |
| `--token` | `TABGLUTTON_TOKEN` | —       | Required. Prefer the env var: process arguments are readable by other local users. |

Diagnostics go to **stderr**; stdout is the MCP transport and carries nothing else.

## Tools

| Tool         | What it does                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs_list`  | Metadata for every open tab — id, title, url, `lastAccessed`, `discarded`, `pinned`, `active`, window, and `hidden` on Firefox/Zen. No page content, so it stays cheap across hundreds of tabs. |
| `tabs_load`  | Reloads discarded tabs so they can be read, ≤20 per call, a few at a time. Off by default — see below.                                                                                          |
| `tab_read`   | Extracts one loaded tab as clean markdown via Defuddle.                                                                                                                                         |
| `tab_clip`   | Files a tab into Obsidian exactly as the popup's Devour does. Optionally closes it after.                                                                                                       |
| `tabs_close` | Closes tabs. Records the batch first and returns a `batchId`.                                                                                                                                   |
| `undo_close` | Reopens a recorded batch.                                                                                                                                                                       |

Deliberately absent: navigate, click, type, evaluate. The agent can read what you already
chose to open, file it, and clean up — it cannot act as you. Adding anything richer means
revisiting the prompt-injection posture in `BRIDGE.md` first.

`tabs_load` is the one tool that acts on a page rather than observing it, so it has its own
switch — **Agent bridge → "Let agents load unloaded tabs"** in Tabglutton's settings — and
enabling the bridge does not enable it. Until it is on, the tool answers `not-enabled` with
that instruction, so an agent can tell you what to flip. Even on, all it does is reload a
tab you already opened; the URL never comes from the agent.

`tabs_list` with no `browser` argument fans out across every connected browser and tags
each tab with its origin. The tab-scoped tools refuse to guess between two browsers, since
tab ids only mean something within one.

## Suggested workflow

Triage on metadata first. In a 300-tab backlog most tabs are discarded (unloaded), and
`tab_read` cannot reach those. Cutting on title, URL, and age before reading anything is
what makes triaging that many tabs affordable in tokens — and it also keeps the survivors
few enough to be worth waking.

Then wake the survivors in batches: one `tabs_load` per 20 tabs, not one per tab. Loads run
three at a time under a fixed budget per call, so a batch is bounded by the slowest few
pages rather than by their sum, and each tab comes back `ready`, `pending` (still loading,
or not reached — ask again), or `failed` (gone, or not an http(s) page). Read the `ready`
ones. With loading switched off, `tab_read` fails with `tab-discarded` instead and those
tabs are yours to open by hand.

## Troubleshooting

**Several agent sessions at once.** Supported, and nothing needs configuring. The first
Gullet to start binds the port and serves the browser; later ones attach to it and proxy
through, so every session sees the same tabs. When the one holding the port exits, the
others re-race and one takes over within a second. You may see more `bun run gullet` processes
than you have sessions — some MCP clients spawn more than one — which is harmless now that
losing the race is not fatal.

**"No browser is connected."** The bridge is off in Tabglutton's settings, no token has
been generated, the ports do not match, or the browser has not re-dialled yet — a first
call waits up to 45s for the browser's backstop alarm (30s cadence, on Firefox too) to
fire and the dial to land, so this answer normally means configuration, not timing. The
settings page shows live connection status.

**Tool calls cancelled by the client.** A first call can legitimately hold for the 45s
connect wait, and a slow method holds for its own 45s request budget after that — ~90s
worst case for one tool call. Most MCP clients default to a 60s deadline (the MCP
TypeScript SDK and Codex both do); give your client at least 100s or a slow-but-healthy
call surfaces as a bare cancellation instead of an answer. Claude Code: `MCP_TOOL_TIMEOUT`
(milliseconds). Codex: `tool_timeout_sec` per server — this repo's `.codex/config.toml`
sets it to 120.

**The browser dials but nothing reaches Gullet.** If the extension's console shows a
WebSocket close code of **1015** and Gullet logs nothing at all, the extension CSP is
upgrading `ws://` to `wss://` and Gullet is being handed a TLS ClientHello. `manifest.json`
must declare `content_security_policy.extension_pages` explicitly — Firefox's MV3 default
includes `upgrade-insecure-requests`, which does this to loopback WebSockets as well.

**Discovery takes minutes instead of seconds.** If the extension only connects long after
Gullet started — or not at all — inspect the extension's background console via
`about:debugging#/runtime/this-firefox` → Tabglutton → _Inspect_ (its `[tabglutton]`
lines do not appear in the Browser Console). `bridge dial timed out after 120000ms`
repeating against a Gullet that answers `curl` instantly means the browser itself cannot
complete a loopback WebSocket: verified live in a ~1,050-tab Zen where dials sat two full
minutes without a SYN ever reaching the wire, while the Browser Console (Cmd-Shift-J)
showed Firefox's own Push service failing with
`PushServiceWebSocket … NS_ERROR_SOCKET_CREATE_FAILED`. The bridge is not misconfigured
and no setting fixes it — restart the browser.

**"Token mismatch."** `TABGLUTTON_TOKEN` and the token in Tabglutton's settings differ.
Regenerating the token in settings invalidates any sidecar still holding the old one.

**"could not listen on 127.0.0.1:4589"** Another Gullet — usually from a second agent
session — already holds the port. One sidecar can serve several browsers, but two sidecars
cannot share a port; give the second one a different `--port` and match it in settings.

**Nothing in the logs.** Gullet writes to stderr, which most agent harnesses hide. Run it
by hand to watch it:

```sh
TABGLUTTON_TOKEN=<token> bun run gullet/gullet.ts
```

Then poke the socket directly:

```sh
bunx wscat -c ws://127.0.0.1:4589 -H 'Origin: moz-extension://test'
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
