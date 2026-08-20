# Gullet

The sidecar half of Tabglutton's agent bridge — the pipe tab content passes through on its
way to a coding agent. One side is an **MCP server over stdio**, spawned by whatever agent
harness you use; the other is a **WebSocket server on loopback** that browsers running
Tabglutton dial into.

Architecture, trust boundary, and phasing live in
[`docs/BRIDGE.md`](https://github.com/mlsimon734/tabglutton/blob/main/docs/BRIDGE.md).
This file is the setup guide.

```
Claude Code ──MCP (stdio)──► Gullet ──WebSocket (automatic loopback port)──► browsers
```

Zero dependencies: it runs on Bun's built-ins alone. Install Bun, then let your MCP client
launch the published package with `bunx tabglutton-gullet`; no checkout is required.

**Two names, one product.** "Gullet" is the internal name for this sidecar; everything a
user or an agent sees says **Tabglutton**. So the MCP server registers as `tabglutton`, the
tools appear under that namespace, and the token is `TABGLUTTON_TOKEN`. `GULLET_TOKEN` and
`GULLET_PORT` still work as aliases.

## Setup

1. **Turn the bridge on in the browser.** Tabglutton → Settings → _Agent bridge_ → enable,
   then **Generate** a token and copy it. The bridge is off until you do this, and no
   socket is opened while it is off.

2. **Write the global token file.** The settings page renders a shell command with your
   token filled in. _Copy setup command_ and run it once. It creates the directory privately
   and writes the secret to `~/.config/tabglutton/token` with mode `0600` (under
   `$XDG_CONFIG_HOME` instead when set). The token does not go into an MCP config.

3. **Register Gullet with your agent.** Pick the shape your client accepts.

   Claude Code, for every project:

   ```sh
   claude mcp add --scope user tabglutton -- bunx tabglutton-gullet
   ```

   Codex CLI and Codex desktop, in `~/.codex/config.toml`:

   ```toml
   [mcp_servers.tabglutton]
   command = "bunx"
   args = ["tabglutton-gullet"]
   startup_timeout_sec = 30
   tool_timeout_sec = 120
   ```

   Claude Desktop/Cowork and clients that accept the standard JSON shape:

   ```json
   {
     "mcpServers": {
       "tabglutton": { "command": "bunx", "args": ["tabglutton-gullet"] }
     }
   }
   ```

   `npx -y tabglutton-gullet` is also supported when a client already standardizes on
   `npx`; the package still requires Bun because its executable uses Bun's runtime.

   To run an unpublished checkout while developing, replace the command with:

   ```sh
   bun run /path/to/tabglutton/gullet/gullet.ts
   ```

4. **Start a session.** The agent spawns Gullet, which attaches to the background hub —
   starting one on an approved port if none is running yet (see _The background hub_ below).
   The browser is usually connected to it already; if it is not, its reconnect loop finds it
   within a few seconds while its extension page is awake, worst case ~30 seconds when the
   page had suspended. The toolbar badge shows a terracotta dot while the connection is live.
   When the session ends its Gullet exits, and the hub stays listening for the next one.

There is no app to launch and no per-session step. Multiple browsers can be connected at
once — a Zen window and a Chrome profile, say — and each tool call picks one with the
`browser` argument.

## Configuration

Gullet reads settings from `${XDG_CONFIG_HOME:-$HOME/.config}/tabglutton/config.json`.
The file is safe to keep in a dotfiles repository because Gullet rejects an inline
`"token"` key; it may contain only settings and a pointer to the secret.

```jsonc
{
  "port": "auto",
  "tokenFile": "token",
}
```

`tokenFile` defaults to `${XDG_CONFIG_HOME:-$HOME/.config}/tabglutton/token`. Relative
paths are resolved from the directory containing `config.json`. To read from a secret
manager instead, use `tokenCommand` in place of `tokenFile`:

```jsonc
{
  "port": "auto",
  "tokenCommand": "op read op://Private/Tabglutton/token",
}
```

The command runs through `sh` from the config directory and its trimmed stdout is the
token. Gullet bounds each attempt at five seconds. A timeout or nonzero exit is reported
to the MCP client with stderr attached while the process keeps retrying with backoff;
unlocking the secret manager heals the same MCP session.

Resolution is additive, so existing setups keep working. The first configured token wins:

```text
--token -> TABGLUTTON_TOKEN / GULLET_TOKEN
        -> tokenCommand -> tokenFile -> the default global token file
        -> ./.env
```

`./.env` is consulted **last**, and only when the global token file is not there at all. It
is the one source read out of a directory you did not choose — an MCP host sets this
process's working directory to whatever project your agent session started in, so a cloned
repository can ship a `.env` naming a token its author knows. Last means it can supply a
token nothing else had, and can never silently replace the one the setup command wrote.
(It moved there in 0.4.0; before that it outranked the global file.)

Port selection uses `--port`, then `TABGLUTTON_PORT` / `GULLET_PORT`, then the global
config, then automatic discovery. A fixed number must match the browser's fixed-port
setting. Process arguments are visible to other local users, so `--token` is best kept for
temporary diagnosis; prefer the global file, a secret-manager command, or the environment.

Automatic mode uses the ordered candidate set shared with the extension: `4589`, `20317`,
`17483`, `27613`, and `24193`. It discovers an existing same-token hub before binding, so
multiple Claude Code and Codex sessions converge even if an earlier candidate later frees up.

Diagnostics go to **stderr**; stdout is the MCP transport and carries nothing else.

### The background hub

The process your agent harness spawns does not talk to the browser itself. The first one to
find no hub running starts a small **detached hub** and attaches to it; every session after
that attaches to the same one. The point is the browser's side of it: with a hub always
listening, the browser holds a connection that already exists when your session starts,
instead of one that has to be discovered and dialled each time — which is where this bridge
has historically lost its first tool call.

It stays out of the way by design. It exits by itself after six hours with no session
attached, it stands aside when a newer Gullet arrives, it keeps your browser's background
page awake only while a session is actually attached, and it holds nothing beyond the same
loopback port, token, and origin check every other part of the bridge uses. Its log is
`${XDG_STATE_HOME:-$HOME/.local/state}/tabglutton/hub.log`, rewritten each time a hub
starts.

Pass `--no-detach` (or `"detach": false` in `config.json`) to serve the browser from the
session process instead, which is the older behaviour and the easier one to debug — the
hub's diagnostics then come out on that process's stderr with everything else.

## Tools

| Tool         | What it does                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs_list`  | Metadata for every open tab — id, title, url, `lastAccessed`, `discarded`, `pinned`, `active`, window, and `hidden` on Firefox/Zen. No page content, so it stays cheap across hundreds of tabs. |
| `tabs_load`  | Reloads discarded tabs so they can be read, ≤20 per call, a few at a time. Off by default — see below.                                                                                          |
| `tab_read`   | Extracts one loaded tab as clean markdown via Defuddle.                                                                                                                                         |
| `tab_clip`   | Files a tab exactly as the popup's Devour does — into Obsidian or as a markdown file, per your setting. Reports which, and who confirmed it. Optionally closes it after.                        |
| `tabs_close` | Closes tabs. Records the batch first and returns a `batchId`.                                                                                                                                   |
| `undo_close` | Reopens a recorded batch.                                                                                                                                                                       |

Deliberately absent: navigate, click, type, evaluate. The agent can read what you already
chose to open, file it, and clean up — it cannot act as you. Adding anything richer means
revisiting the prompt-injection posture in
[`docs/BRIDGE.md`](https://github.com/mlsimon734/tabglutton/blob/main/docs/BRIDGE.md)
first.

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

**Several agent sessions at once.** Supported, and nothing needs configuring. Sessions
attach to the shared background hub described above and proxy through it, so every session
sees the same tabs. You may see more `tabglutton-gullet` processes than you have sessions —
some MCP clients spawn more than one, and one of them is the hub, which is meant to outlive
all of them.

**A Gullet process that will not go away.** That is the hub, and it is doing its job:
holding the browser's connection open between your sessions. It exits on its own after six
idle hours, retires when a newer Gullet attaches, and takes a `SIGTERM` if you want it gone
now. `--no-detach` keeps every future session's hub inside the session process instead.

**"No browser is connected."** The bridge is off in Tabglutton's settings, no token has
been generated, fixed-port settings do not match, or the browser has not re-dialled yet — a first
call waits up to 45s for the browser's backstop alarm (30s cadence, on Firefox too) to
fire and the dial to land, so this answer normally means configuration, not timing. The
settings page shows live connection status. A browser with no session attached deliberately
lets its background page suspend, so it is _usually_ but not always connected between
sessions; the wait covers that gap.

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

**Every candidate is unavailable.** Gullet reports one summary and keeps retrying with
backoff. A same-token Gullet is joined automatically; markerless services, incompatible
versions, and different-token realms are skipped. Freeing any candidate heals the running
MCP session. If policy requires one known endpoint, select **Fixed port** in Tabglutton and
pass that number with `--port`.

**Nothing in the logs.** Gullet writes to stderr, which most agent harnesses hide. Run it
by hand to watch it:

```sh
TABGLUTTON_TOKEN=<token> bunx tabglutton-gullet
```

Then poke the selected socket directly (stderr prints the chosen port; `4589` is shown here):

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

The wire contract lives in
[`src/bridge-protocol.ts`](https://github.com/mlsimon734/tabglutton/blob/main/src/bridge-protocol.ts)
and is imported by both halves, so extension and sidecar are typechecked against one definition.
