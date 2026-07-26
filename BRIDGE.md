# Agent Bridge

Architecture doc for the planned agent interface: letting a coding agent (Claude Code,
Codex, or any MCP client) see and manage the user's open tabs through Tabglutton. Working
name for the sidecar: **Gullet** — the pipe content passes through on its way down.

Companion docs: PRODUCT.md (product register), DESIGN.md (visual system). This doc is the
engineering register for the bridge; UI for it (badge states, consent surfaces) belongs in
DESIGN.md when it lands.

**Status: v1 is implemented.** `gullet/` holds the sidecar (setup guide in
`gullet/README.md`); `src/bridge-protocol.ts`, `src/bridge-client.ts`,
`src/bridge-methods.ts`, and `src/undo-log.ts` hold the extension half. Two design
decisions changed during implementation and are marked ▸ below.

## Why

The user's job should be _foraging_ — browsing, opening whatever looks interesting — not
_triage_. Today Devour makes triage fast but still manual. The bridge inverts it: an agent
reads the open-tab backlog, surfaces the high-signal pieces, files keepers into Obsidian
via the existing clip pipeline, and proposes closures. The human browses; the agent
digests.

This is the "Triage / agenda" line in PRODUCT.md, resolved: the engine is not an in-
extension model, it is an external agent given a narrow tab API. Intelligence stays in the
agent (prompts, skills, the user's vault context); the extension stays hands and eyes.

## Trust boundary (non-goals)

The bridge deliberately exposes **read + file + close** and nothing else:

- No navigation, no clicking, no form input, no arbitrary script execution in pages.
- No access to page state beyond what the existing Defuddle clipper extracts.
- Closing tabs is the only destructive action, and it leaves an undo trail. It reaches the
  agent through two tools — `tabs_close` and `tab_clip { close: true }` — and both are
  annotated `destructiveHint: true`, since MCP annotations are per tool, not per call.

This keeps the permission story legible: the agent can read what the user already chose to
open, file it, and clean up. It cannot _act as_ the user. If richer automation is ever
wanted, that is a different product (and Claude-in-Chrome already exists for Chrome).

## Architecture

```
┌────────────┐  MCP (stdio)  ┌─────────────┐  WebSocket (127.0.0.1:4588)  ┌───────────────┐
│ Claude Code │◄────────────►│   Gullet    │◄────────────────────────────►│  Tabglutton   │
│ / any MCP   │              │  (sidecar,  │◄───────────────┐             │  background   │
│   client    │              │  Bun + TS)  │                └────────────►│  (Zen/FF and/ │
└────────────┘              └─────────────┘   multiple browsers may dial in │  or Chrome)   │
                                                                          └───────────────┘
```

- **Gullet** is a small Bun/TypeScript process living in this repo (`gullet/`). One side is
  an MCP server over stdio; the other is a WebSocket server bound to loopback on a fixed
  default port (**4588** — GLUT on a phone keypad), configurable.
- **The extension background** runs a reconnect loop that dials the port. When no sidecar
  is running the socket just fails cheaply and the extension idles. When a connection is
  live, the toolbar badge indicates it (design TBD in DESIGN.md).
- **MCP tool calls** are translated 1:1 into JSON-RPC-style messages over the socket; the
  extension executes them with real `browser.*` APIs and returns results.
- Multiple browsers (e.g. Zen and a Chrome profile) can be connected at once. The sidecar
  tags each connection with the browser identity from the hello message; tab ids are
  namespaced per connection and tools accept/return a `browser` field.

### Why not native messaging (for now)

Native messaging hosts are spawned by the _browser_; MCP servers are spawned by the
_agent_. Using native messaging would still require IPC between the browser-spawned host
and the agent — a second hop for no gain. The loopback socket is one process and one hop,
identical on Gecko and Chromium, and trivially debuggable (`bunx wscat`). Native messaging
remains the right tool if the sidecar ever needs to be browser-launched (see Lifecycle),
with the caveat that Zen's `NativeMessagingHosts` directory location needs verification —
Firefox forks differ.

## Lifecycle: nobody launches an app

There is no user-visible application and no manual step per session:

1. **Install once**: the extension update ships the bridge module; the user adds Gullet to
   `.mcp.json` (or `claude mcp add`) in whatever project/agent runs triage.
2. **Session start**: the agent harness spawns Gullet as an ordinary stdio MCP server.
   Gullet opens the loopback port.
3. **Connect**: the extension's reconnect loop (alarm-driven, 30s cadence when idle)
   finds the port and completes the token/origin handshake. Badge lights up.
4. **Session end**: agent exits → Gullet exits → socket drops → extension goes back to
   idle dialing.

This is the same UX shape as Claude-in-Chrome (extension + CLI negotiate a local
connection; no dock icon). The difference is we own both ends, so it works on Zen.

A long-running daemon mode (ambient curation without an active agent session, via native
messaging or launchd) is explicitly deferred until session-scoped triage proves out.

## Wire protocol

One JSON object per WebSocket frame (the frame is the delimiter), versioned:

- Sidecar → extension on connect: `{ type: "challenge", proto: 1, server, nonce }`.
- Extension → sidecar: `{ type: "hello", proto: 1, browser: "firefox" | "chrome",
extVersion, label, nonce, proof }`.
- Sidecar → extension: `{ type: "hello-ack", proto, connectionId, proof }`, or
  `{ type: "hello-error", error }`.
- Sidecar → extension requests: `{ type: "request", id, method, params }`; responses
  `{ type: "response", id, result }` or `{ type: "response", id, error: { code, message } }`.
- Heartbeat ping/pong every ~20s, as application-level messages rather than WebSocket
  control frames. On Chrome this doubles as the MV3 service-worker keepalive (socket
  activity extends worker lifetime since Chrome 116, which is already our
  `minimum_chrome_version`) — control frames the browser answers itself would not.

▸ **The token is not sent.** The sketch had the extension put its token in the hello and
the sidecar echo it back, which proves nothing in the return direction. Instead each side
proves it knows the token by hashing it against a nonce the _other_ side chose:
`proof = SHA-256(len(token):token:nonce)`. The token never crosses the wire, a captured
proof cannot be replayed against a fresh nonce, and the extension's check of the ack is a
real check. Length-prefixing keeps a token containing `:` from being confusable with a
different token/nonce split.

Shared request/response types live in `src/bridge-protocol.ts`, imported by both the
extension and Gullet so the contract is typechecked from one definition.

## Tool surface (v1)

| MCP tool     | Backing APIs                                           | Notes                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs_list`  | `tabs.query`                                           | id, title, url, `lastAccessed`, `discarded`, `pinned`; on Firefox also `hidden` (≈ other Zen workspaces). Metadata only — cheap over hundreds of tabs.                                            |
| `tab_read`   | `scripting.executeScript` + existing `clip-current.ts` | Returns Defuddle markdown + metadata. Fails cleanly on discarded tabs (see below).                                                                                                                |
| `tab_clip`   | existing `clip-format.ts` + `obsidian://new` handoff   | Files into the vault exactly as manual Devour does, including the Chrome redirect-page dance.                                                                                                     |
| `tabs_close` | `tabs.remove`                                          | Batched, ids deduplicated. Entries (title, url, pinned, window, index, private) are recorded in an undo log in `storage.local` _before_ the removal, and the batch id comes back with the result. |
| `undo_close` | reopen from the log                                    | Safety valve for the one destructive act. Omit the batch id to undo the most recent.                                                                                                              |

Deliberately absent: navigate, click, type, evaluate. A gated `tab_load` (reload a
discarded tab so `tab_read` works on authed pages) is a candidate for v1.1, but it is the
first "action" tool, so it ships default-off behind an options toggle.

`tabs_list` with no `browser` argument fans out over every connected browser and tags each
tab with its origin, so discovering what is connected costs no extra round trip. The
tab-scoped tools refuse to guess between two browsers, because ids only mean something
within one.

**Restoring is exact where it can be and safe where it cannot.** A batch is recreated in
ascending index order within each window; inserting a low index after a high one would
shift the tab already placed there. A recorded window id is trusted only when a live window
with that id shares the tab's privacy context — ids start over after a browser restart
while the log persists, and a private tab reopened in a normal window would put its URL
into history and sync. When the original window is gone the tab goes to a window of the
matching context, opening one if the last was closed. Anything that still cannot be
reopened stays in the log under the same batch id so `undo_close` can be retried; only the
tabs that actually came back are dropped from it.

## The discarded-tab problem

With hundreds of tabs, most are unloaded; `scripting.executeScript` cannot run in them.
Strategy, in order:

1. **Triage on metadata first.** The agent workflow should cut on title/url/age before
   reading anything. This is also what makes triaging 300 tabs affordable in tokens.
2. **Sidecar fetch fallback.** For discarded survivors, Gullet fetches the URL itself and
   runs Defuddle over the HTML (`defuddle/node` + a DOM shim). Works for the public-
   article majority of a foraging backlog; loses cookies, so authed/paywalled pages fail
   with a distinct error the agent can report ("needs manual load").
3. **`tab_load`** (v1.1, opt-in) for the authed remainder.

## Security model

- Bind **loopback only**; never 0.0.0.0.
- **Origin check**: WebSocket upgrade requests must carry the extension origin
  (`moz-extension://…` / `chrome-extension://<id>`). This blocks the realistic attacker —
  a hostile web page opening `ws://127.0.0.1:4588` from inside the browser.
- **Shared token**: generated by the extension (options page, one-time copy into Gullet's
  config/env) and required before any method is served. Never transmitted — both ends
  prove knowledge of it against the other's nonce (see Wire protocol). The extension
  refuses to talk to a server that cannot answer its challenge, and the sidecar refuses a
  browser that cannot answer its own.
- **Revocation**: regenerating the token — or changing the port — drops any live socket.
  The handshake pins the token it proved, so a sidecar that authenticated with the revoked
  token cannot keep serving requests on a connection that is already open.
- **Opt-in**: the bridge is off by default and no socket is opened until the user enables
  it and generates a token, so a user who never wants this never dials anything.
- The sidecar holds no credentials and stores no content; tab text flows through it to the
  MCP client and is not persisted.
- Prompt-injection posture: page content is attacker-controlled input to the agent. The
  narrow tool surface is the mitigation — the worst a poisoned page can trick the agent
  into is closing tabs (undoable) or clipping junk into the Obsidian inbox (deletable).
  This posture must be re-evaluated before any richer tool is added.

## Manifest / build changes

- One new permission: `alarms` (reconnect wake). No new permission is needed for the
  WebSocket itself.
- ▸ **An explicit `content_security_policy.extension_pages` turned out to be mandatory.**
  Firefox's default MV3 extension CSP includes `upgrade-insecure-requests`, which applies
  to WebSocket URLs as well as fetches: `ws://127.0.0.1:4588/` is rewritten to `wss://`,
  loopback and all. Gullet then receives a TLS ClientHello instead of an HTTP upgrade, so
  its `fetch` handler never runs and it logs nothing; the extension sees only close code
  **1015**. The connection fails invisibly from both ends. The manifest now declares
  `"script-src 'self'; object-src 'self'"` — the same policy minus that directive. This
  cost most of a debugging session; it is recorded in AGENTS.md too.
- ▸ **`sessions` was not needed.** The plan was to restore through `sessions.restore` where
  available, falling back to the log. But matching a recently-closed session to a log entry
  is only possible by URL, which is ambiguous with duplicate tabs — the exact case this
  extension exists for. Recreating from the log via `tabs.create` is deterministic and
  restores pin state and index, so the permission buys nothing. Per the repo's minimal-
  permission policy, it is not requested.
- No new host permissions (`*://*/*` already covers the clipper).
- `gullet/` is a sibling package with its own `tsconfig.json`, sharing
  `src/bridge-protocol.ts` and the repo's check pipeline (`bun run typecheck` covers both
  projects; `bun test` picks up `gullet/tests/`). It has no dependencies of its own —
  Bun's built-in WebSocket server and a hand-rolled tools-only MCP server are enough, so
  `bun run gullet/gullet.ts` works with nothing installed.
- `build.ts` gains nothing target-specific: the bridge module is shared source; the only
  Chrome divergence is the keepalive note above. `gullet/` is outside the extension
  tsconfig's `include`, so it never lands in `dist-*`.

## Phasing

1. **Bridge v1** — _shipped_: `gullet/` + extension socket client + the five tools +
   token/origin auth + undo log. Definition of done: from a Claude Code session, list tabs
   in Zen and in Chrome, read a loaded tab, clip it to Obsidian, close it, undo the close.
   Protocol, auth, config, target selection, MCP framing, and a live-socket handshake and
   routing test are covered by `bun test`; the browser-API surface is verified by running
   the definition-of-done end to end against a real browser. **All five tools verified live
   against Zen and against Chrome 150**, on TypeScript 7 and Defuddle 0.19. Also verified:
   with both connected at once (14 tabs across the two), a tab-scoped call naming no
   `browser` is refused with `ambiguous-target` rather than guessing; and a sidecar started
   mid-session is picked up by the idle reconnect loop without a reload.
   - The close/undo and revocation semantics above are verified the same way, driven from a
     script that runs the real hub against **Chrome 150** over CDP: duplicate ids collapse to
     one close, a tab closed before its navigation commits is still recorded, out-of-order
     ids restore to their recorded index order, a batch whose window vanished comes back in a
     window of the same privacy context, a private batch reopens private (and is left failed,
     never normalised, when private access is off), a partial undo keeps its failures for a
     retry, and regenerating the token drops the live socket rather than letting the old one
     keep serving. Run against pre-fix code the same script fails six of those; the Firefox
     path is unproven, as with `tab-discarded` below.
   - `tab_read` on a genuinely discarded tab returns a clean `tab-discarded` — exercised on
     **Chrome only**, where `chrome.tabs.discard()` can manufacture the fixture over CDP.
     The guard is one shared, target-agnostic line reading the standard `tab.discarded`, but
     the Firefox path is unproven, and it is the one that matters most: Zen restores tabs
     lazily, so a large session is full of discarded tabs from the moment it opens.
2. **Curation workflow**: a `/triage-tabs` skill (lives with the agent, not this repo):
   metadata cut → read survivors → digest note in Obsidian ("12 high-signal, 40 clipped,
   180 proposed closures — approve?"). Closure stays behind human approval.
3. **v1.1**: sidecar fetch fallback, `tab_load` opt-in, autonomy ratchets (auto-close
   known-noise domains, auto-close anything clipped), scheduled runs.

## Open questions

- Zen `NativeMessagingHosts` path (only matters for the deferred daemon mode).
- Whether `tabs_list` should expose Zen workspace _names_ (no API today; `hidden` is the
  only signal — see the workspace-heuristic notes in AGENTS.md).
- Whether the idle reconnect loop keeps the Firefox event page from ever suspending. The
  cadence itself is confirmed (below); what is untested is the page's own lifetime, and
  whether a 30s alarm is worth the wakeups it costs when no sidecar will ever answer.
- Whether `tab_clip` batching needs throttling on the `obsidian://` handoff (Obsidian URI
  handling under burst load is untested beyond manual Devour rates).
