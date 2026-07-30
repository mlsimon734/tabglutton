# Agent Bridge

Engineering register for the agent bridge: letting a coding agent (Claude Code, Codex, or
any MCP client) see and manage the user's open tabs through Tabglutton. Working name for
the sidecar: **Gullet** — the pipe content passes through on its way down.

**The bridge is shipped; this doc is not a proposal.** What follows is the reasoning behind
the design, the constraints that shaped it, and what is still open. Read "Trust boundary"
as a contract rather than a sketch — it is enforced in code and things depend on it.
Decisions that were made and later found wrong are marked ▸ and left in place rather than
edited away, because the correction is usually worth more than the conclusion.

Where to look instead: `gullet/README.md` to _run_ it, and the MCP schema in
`gullet/src/tools.ts` — which is executable, so it is authoritative — for exact tool
signatures. Code lives in `gullet/` (sidecar) and `src/bridge-protocol.ts`,
`src/bridge-client.ts`, `src/bridge-methods.ts`, `src/undo-log.ts` (extension half).

Companion docs: PRODUCT.md (product register), DESIGN.md (visual system). UI for the bridge
(badge states, consent surfaces) belongs in DESIGN.md when it lands.

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

The bridge deliberately exposes **read + file + close**, plus a separately-gated **load**,
and nothing else:

- No clicking, no form input, no arbitrary script execution in pages, and no navigation to
  any address the agent chooses. `tabs_load` reloads a tab the _user_ opened, at its own
  URL, and is the only tool that touches a page rather than reading one; it ships off and
  has its own settings switch, so enabling the bridge does not enable it.
- No access to page state beyond what the existing Defuddle clipper extracts.
- Closing tabs is the only destructive action, and it leaves an undo trail. It reaches the
  agent through two tools — `tabs_close` and `tab_clip { close: true }` — and both are
  annotated `destructiveHint: true`, since MCP annotations are per tool, not per call.

This keeps the permission story legible: the agent can read what the user already chose to
open, file it, and clean up. It cannot _act as_ the user. If richer automation is ever
wanted, that is a different product (and Claude-in-Chrome already exists for Chrome).

## Architecture

```
┌────────────┐  MCP (stdio)  ┌─────────────┐  WebSocket (127.0.0.1:4589)  ┌───────────────┐
│ Claude Code │◄────────────►│   Gullet    │◄────────────────────────────►│  Tabglutton   │
│ / any MCP   │              │  (sidecar,  │◄───────────────┐             │  background   │
│   client    │              │  Bun + TS)  │                └────────────►│  (Zen/FF and/ │
└────────────┘              └─────────────┘   multiple browsers may dial in │  or Chrome)   │
                                                                          └───────────────┘
```

- **Gullet** is a small Bun/TypeScript process living in this repo (`gullet/`). One side is
  an MCP server over stdio; the other is a WebSocket server bound to loopback on a fixed
  default port (**4589** — GLUT on a phone keypad), configurable.
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

▸ **"No gain" was measured against the wrong thing.** That paragraph weighs native messaging
purely as a _launch_ mechanism, where a second hop really does buy nothing. It misses the
lifecycle property: an open native-messaging port is understood to keep a Firefox MV3 event
page alive, which is precisely the guarantee the whole keepalive-and-alarm apparatus below
exists to counterfeit. Firefox MV3 has no persistent background option, so a loopback socket
can never be more than polling around a lifetime the browser does not know it should extend.
If that property holds, native messaging is not a second hop for no gain — it is the only
supported way to get the thing this design keeps working around. **Unverified**: the
behaviour, the Firefox version it landed in, and Zen's host-manifest path all need
confirming before this becomes a plan. Weigh it against what it costs — a separately
installed host binary and manifest per browser, replacing today's "install the extension,
add one line to `.mcp.json`".

## Lifecycle: nobody launches an app

There is no user-visible application and no manual step per session:

1. **Install once**: the extension update ships the bridge module; the user adds Gullet to
   `.mcp.json` (or `claude mcp add`) in whatever project/agent runs triage.
2. **Session start**: the agent harness spawns Gullet as an ordinary stdio MCP server.
   Gullet opens the loopback port.
3. **Connect**: the extension's reconnect loop finds the port and completes the
   token/origin handshake. Badge lights up. Discovery is a ~3s HTTP probe loop while
   the background page is awake, with a 30s alarm as the backstop that survives page
   suspension — probing is free where dialling is not (see the reconnect notes in
   AGENTS.md), so a sidecar is found in seconds rather than within one alarm period.
4. **Session end**: agent exits → Gullet exits → socket drops → extension goes back to
   idle dialing.

This is the same UX shape as Claude-in-Chrome (extension + CLI negotiate a local
connection; no dock icon). The difference is we own both ends, so it works on Zen.

A long-running daemon mode (ambient curation without an active agent session, via native
messaging or launchd) is explicitly deferred until session-scoped triage proves out.

▸ **The daemon was weighed as a feature and deferred as one; it is coming back as a fix.**
What the ambient-curation framing missed is that the daemon's lifetime is the answer to a
reliability problem that polling cannot fully solve: because the hub dies with its agent
session, every session start re-runs port discovery, and discovery-by-polling races the
first call's connect wait. The probe loop above shrinks that race to a few seconds; a hub
that outlives sessions removes it. See "Session-start connect latency" under Open
questions for the sketch.

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
  activity extends worker lifetime since Chrome 116, below our
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

| MCP tool     | Backing APIs                                           | Notes                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs_list`  | `tabs.query`                                           | id, title, url, `lastAccessed`, `discarded`, `pinned`; on Firefox also `hidden` (≈ other Zen workspaces). Metadata only — cheap over hundreds of tabs.                                                          |
| `tabs_load`  | `tabs.reload` + `tabs.onUpdated`                       | Wakes discarded tabs so they can be read. Batched (≤20), three at a time, under a 30s deadline; per-tab `ready`/`pending`/`failed`. Gated on a settings toggle, default off — answers `not-enabled` until then. |
| `tab_read`   | `scripting.executeScript` + existing `clip-current.ts` | Returns Defuddle markdown + metadata. Fails cleanly on discarded tabs (see below).                                                                                                                              |
| `tab_clip`   | existing `clip-format.ts` + `obsidian://new` handoff   | Files into the vault exactly as manual Devour does, including the Chrome redirect-page dance.                                                                                                                   |
| `tabs_close` | `tabs.remove`                                          | Batched, ids deduplicated. Entries (title, url, pinned, window, index, private) are recorded in an undo log in `storage.local` _before_ the removal, and the batch id comes back with the result.               |
| `undo_close` | reopen from the log                                    | Safety valve for the one destructive act. Omit the batch id to undo the most recent.                                                                                                                            |

Deliberately absent: navigate, click, type, evaluate.

▸ **`tab_load` shipped as `tabs_load`, plural.** It was sketched as a per-tab v1.1 tool.
But loading is dominated by the network wait, not by IPC, and the workflow that needs it —
"here are the 30 discarded survivors of a metadata cut" — is inherently a batch. One tab per
call would have serialised 30 page loads into 30 round trips, each of them mostly idle. So
it takes an id array like `tabs_close`, loads a few concurrently, and answers per tab.

Being a batch is also what forces the rest of its shape. Its wall-clock budget
(`TABS_LOAD_DEADLINE_MS`, 30s) sits deliberately under `BRIDGE_REQUEST_TIMEOUT_MS` (45s):
a batch that overran the request timeout would reach the agent as a bare timeout even though
most of its tabs had in fact loaded, and the agent would then redo work the browser had
already done. Stopping first lets every tab in the request get an outcome, with the ones it
never reached marked `pending` rather than silently missing. `pending` and `failed` are kept
apart for the same reason: one means "ask again", the other means "asking again will not
help". The batch cap (20) and the concurrency limit (3) are the memory manners — anyone with
a backlog big enough to need this is running an auto-discarder precisely because memory is
scarce, and waking twenty pages at once would spend exactly what the discarder saved.

The gate is a real one and it is separate from `bridgeEnabled`: `bridgeAllowTabLoad`,
default off, surfaced as **Agent bridge → "Let agents load unloaded tabs"**. A refused call
returns the `not-enabled` code — distinct from `unsupported` because this one has a fix the
agent can state to the user.

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
3. **`tabs_load`** — _shipped, opt-in_. Wakes the survivors so `tab_read` reaches them,
   including the authed and paywalled ones a sidecar fetch could never get. In practice this
   inverts the order above rather than sitting behind it: once loading is switched on, waking
   30 tabs the user is already logged into beats fetching them cookie-less, so the fetch
   fallback matters mainly when loading is left off.

## Security model

- Bind **loopback only**; never 0.0.0.0.
- **Origin check**: WebSocket upgrade requests must carry the extension origin
  (`moz-extension://…` / `chrome-extension://<id>`). This blocks the realistic attacker —
  a hostile web page opening `ws://127.0.0.1:4589` from inside the browser.
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
  into is closing tabs (undoable), clipping junk into the Obsidian inbox (deletable), or
  loading a tab the user already had open. `tabs_load` was weighed against this before it
  shipped: the agent chooses _which_ tab to wake but never its URL, so the reachable set is
  exactly the user's own open tabs, and the delta is that a page the user opened once runs
  again. That is small, but it is not nothing — it is why the tool is gated rather than
  simply added. This posture must be re-evaluated before any richer tool.

## Manifest / build changes

- One new permission: `alarms` (reconnect wake). No new permission is needed for the
  WebSocket itself.
- ▸ **An explicit `content_security_policy.extension_pages` turned out to be mandatory.**
  Firefox's default MV3 extension CSP includes `upgrade-insecure-requests`, which applies
  to WebSocket URLs as well as fetches: `ws://127.0.0.1:4589/` is rewritten to `wss://`,
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

Deliberately short: git records what shipped when, so this keeps only what each phase
_proved_. Anything still unproven has moved to Open questions, where it gets read.

1. **Bridge v1** — shipped. Six tools, token/origin auth, undo log. Verified end to end on
   both engines by scripts driving the real hub against a real browser: **Chrome 150** over
   CDP (17 checks) and **Zen 1.21.9b** over Marionette (15 checks). Between them: duplicate
   ids collapse to one close, out-of-order ids restore to their recorded index order, a batch
   whose window vanished returns to a window of the same privacy context, a private batch
   reopens private, a partial undo keeps its failures for a retry, and regenerating the token
   drops the live socket instead of letting it keep serving. The same scripts against pre-fix
   code fail 6 checks on Chrome and 11 on Zen — they discriminate, rather than merely passing.
   Two engine differences fell out of that run and live in AGENTS.md: uncommitted navigations
   have no recoverable URL on Gecko, and Zen mirrors essential tabs into every window, so
   "this window's tabs" is a bigger batch there than it looks.
2. **v1.1 `tabs_load`** — shipped, verified on **both** engines. Chrome
   150.0.7871.187 over CDP against the merged bridge, 23 checks: `tabs_load` wakes a
   genuinely discarded tab without churning its id (the open question above), a mid-load
   tab is listed and closed under its `pendingUrl` rather than dropped address-less from
   the undo log, a batch mixing a live id with a stale one ends at
   `closed === entries.length` with the stale id in `missing` — in **both** orders, which
   is what proves the per-id retry rather than luck with Chrome's fail-at-first-bad-id
   ordering — duplicate ids collapse to one close, and an all-stale batch carries
   `STALE_ID_HINT`. Two behaviours worth naming because they are easy to misread as
   faults: while a socket is live the heartbeat keeps the MV3 service worker alive (so it
   does not idle out at all), and a request racing a worker kill fails fast with
   `no-connection` in ~4ms rather than waiting out `BRIDGE_CONNECT_WAIT_MS` — correct for
   a call that may already have executed, and the next call reconnects and serves in ~3ms.
   Zen 1.21.9b against a real ~975-tab
   session: two lazily-discarded tabs woken in one call (`2 ready, 0 pending, 0 failed`),
   neither stealing focus, both then readable through Defuddle, nothing else altered. The
   fixtures being tabs Zen had discarded on its own is what also finally exercised the Gecko
   `tab-discarded` path, which phase 1 could only manufacture on Chrome.
3. **Curation workflow** — next, and deliberately not in this repo: a `/triage-tabs` skill
   living with the agent. Metadata cut → read survivors → digest note in Obsidian ("12
   high-signal, 40 clipped, 180 proposed closures — approve?"). Closure stays behind human
   approval.

## Open questions

- **Why the first `tabs_list` of a session times out on a large backlog.** Recurring, not a
  one-off: the first call after an extension reload fails with `timeout` at the full 45s
  `BRIDGE_REQUEST_TIMEOUT_MS`, and an immediate retry of the same call succeeds. Observed on
  Zen 1.21.9b at 730 tabs in one window (~1000 total) with extension 0.1.3.7.
  - **Ruled out.** Not the connection: a `tab_read` on the same `connectionId` answered
    correctly and instantly inside the same window of time. Not a stale hub entry: `selectOne`
    would have reported `ambiguous-target` and did not, so exactly one browser was registered.
    Not `tabsList` itself: unchanged across the whole fix series, and it succeeds seconds later
    against the same tab set.
  - **Two hypotheses, and the observation does not separate them.**
    1. _Startup contention._ The background page is single-threaded. `init()` runs
       `bridge.start()` first — deliberately, so the handshake lands before the slow work — and
       then `probeHeuristic()` and `refreshBadge()` over the entire tab set. But a completed
       handshake does not mean the page is free to _serve_: a request arriving during the badge
       pass queues behind it, and at this scale that pass is not cheap.
    2. _Response size._ `tabs_list` for that window is ~253 KB of JSON in one WebSocket frame.
       `tab_read` — the call that worked at the same moment — is a small fraction of that, so
       size and timing were confounded in the observation and neither is excluded.
  - **Discriminating test.** Immediately after an extension reload, call `tabs_list` twice back
    to back. First fails and second succeeds ⇒ startup contention. Large responses failing
    intermittently well after startup ⇒ size, and the thing to measure is `JSON.stringify` cost
    plus whether the 45s budget is covering the frame write rather than the query. Worth timing
    `queryAllTabs()`, `probeHeuristic()` and `refreshBadge()` in isolation at this scale first —
    the answer may be visible without reproducing the failure at all.
  - **Why it matters more than its frequency suggests.** It lands on the first call of a
    session and reads to an agent as a dead bridge — the exact failure mode the reconnect work
    was meant to eliminate — so it spends the credibility that work bought back.
- **Session-start connect latency: mitigated by faster discovery; ended by a detached
  hub.** The recurring "first connection window misses, the retry succeeds" was a race
  between two ~30s timers: discovery was strictly alarm-cadenced (30s) while
  `BRIDGE_CONNECT_WAIT_MS` was 35s, and the 5s margin was eaten by alarm jitter plus the
  wake cost of `init()` at ~1000 tabs. Shipped mitigation: the extension re-probes every
  3s while its page is awake — probing is plain HTTP, exempt from Gecko's
  `FailDelayManager`, so the loop costs nothing and dials nothing until a server answers
  — the alarm is demoted to the suspension backstop, and the wait is now 45s so even the
  backstop path fits inside the first call. While the page is awake, session-start
  connect drops from 0–30s to a few seconds — and the five-minute post-drop keepalive
  linger makes back-to-back sessions the loop's strongest case; a page that did suspend
  still pays up to one alarm period, which the 45s wait now covers. The wait is one
  number for both kinds of session: a Gullet that loses the port election serves its
  first call with the hub's own `BRIDGE_CONNECT_WAIT_MS`, and the peer's outer RPC
  deadline sits strictly above the hub's inner budget (`PEER_RPC_SLACK_MS`) so a hub
  still legitimately waiting can never read as a dead one.
  - ▸ **A durable blind-dial counter shipped inside this mitigation and was reverted the
    same session.** Persisting `probeMisses` in `storage.session` — so the blocked-`fetch`
    escape valve would fire reliably across suspensions — inverted a load-bearing
    accident: the instance counter dying with the page was precisely what kept blind
    dials, the only input to Gecko's reconnect penalty, rare. Made durable, wake-time
    misses accumulated and the valve fired often enough to rebuild a near-ceiling
    `FailDelayManager` record in ~15 minutes; the first live session-start after the
    change logged `bridge socket open after 48129ms` against a sidecar answering HTTP in
    microseconds — the exact "stuck on Connecting…" the probe architecture exists to
    prevent, manufactured by code meant to make startup fast. The valve keeps its
    ephemeral counter; its unreliability under suspension is the design.
  - ▸ **The browser itself intermittently fails to create sockets, which reopens the
    attribution.** The build with the counter reverted showed the same ~5-minute
    session-start discovery on the same day — and that browser's own console carries
    recurring `PushServiceWebSocket: beginWSSetup: asyncOpen failed
NS_ERROR_SOCKET_CREATE_FAILED` bursts: Firefox's Push service, no Tabglutton
    involvement, unable to open a WebSocket at the OS socket layer. A bridge dial landing
    inside such a burst fails instantly, and every one of those failures is a real failed
    WebSocket connect — exactly what feeds `FailDelayManager` — while the HTTP probe can
    keep succeeding off a pooled connection, so the extension keeps deciding to dial into
    a wall. That would produce both observations without the counter: the 48s penalized
    dial and multi-minute discovery on either build. Raw fd exhaustion is measured out
    (1,409 fds against a 184,320 per-process cap at the time of check; ~430 sockets, most
    of them QUIC/UDP one-per-origin at ~1000 tabs), so the burst mechanism — necko
    internal socket limits, or transient `EMFILE`-class spikes — is not yet pinned. The
    discriminating check when discovery is slow: open the Browser Console and look for
    `NS_ERROR_SOCKET_CREATE_FAILED` lines clustering around the window. If they are
    there, the machine, not the bridge, is the bottleneck — and it is one more reason
    the detached hub below is the real fix, since a standing connection only has to win
    a socket once, not once per session.
  - ▸ **A controlled reproduction settled it: discovery is exonerated, the dial itself
    hangs inside Gecko.** 2026-07-29, after 4+ hours of extension idle: Gullet bound the
    port at 03:24:56.6Z and the extension dialled at 03:24:56.8Z — the probe loop found
    the sidecar in **180ms**, exactly to spec. The dial then sat in CONNECTING for the
    full 120s `BRIDGE_DIAL_TIMEOUT_MS`, twice consecutively, while an external `lsof`
    watch on the port saw **no SYN ever reach TCP** — Firefox's own "can't establish a
    connection" errors surfaced only after our abort. The third dial established TCP in
    ~1.3s, but the WebSocket upgrade never completed: Gullet saw no connection, the
    extension never reached `open`, and the socket was gone minutes later.
    `FailDelayManager` cannot produce this shape — its ceiling is 60s and a hold ends in
    a normal connect — so the earlier "socket open after 48129ms" and "after 33819ms"
    reads as the mild form of the same thing, and the blockage sits deeper in necko
    (per-host WebSocket admission serialization and socket-transport pressure are the
    candidates), in a browser whose own Push service was failing with
    `NS_ERROR_SOCKET_CREATE_FAILED` the same day at ~1,050 tabs. Everything we control
    behaved correctly: probe found the port instantly, the dial deadline fired, the
    retry kept the client live. A browser restart is the clearing action. A shorter
    dial deadline (dials are probe-gated now, so an aborted dial against a live server
    is cheap) is a candidate experiment, but it rests on this one run — and the run is
    the strongest argument yet for the detached hub, which dials once per browser
    session instead of once per agent session.
  - **The structural fix is to make the connection predate the session.** Polling exists
    only because the hub's lifetime is bound to the agent session that spawned it. The
    hub/peer election already lets N sessions share one browser connection; the missing
    piece is a hub that outlives them: the first Gullet that finds no listener spawns a
    _detached_ hub and attaches to it as a peer, exactly as later sessions already do.
    The extension then holds one long-lived socket (the 20s heartbeat already maintains
    it) and session start becomes a peer attach — local, instant, no window at all.
  - Lifecycle sketch: the detached hub self-exits after long idle (no peers for some
    hours); version skew rides the hello (`proto` is already checked) — a newer peer
    asks an older hub to retire and re-races the port, which binding already settles
    atomically; token regeneration already drops live sockets, so revocation is
    unchanged. Nothing about the trust boundary moves: same port, same token, same
    origin check.
  - The honest open problem is the **keepalive entitlement**. Today a live socket _is_
    proof an agent session exists, which is what justifies holding the event page awake
    (`KEEPALIVE_PING_MS`). A persistent hub breaks that proof: staying connected around
    the clock means the page never suspends, spending wakeups on nobody. The likely
    shape is the hub advertising whether any peer is attached, with the extension
    holding the page awake only then — which keeps the instant-attach property (the hub
    is always listening, so the probe loop reconnects in seconds even from a drop)
    without pinning the browser for idle hours.
  - What it settles for free: the event-page-lifetime question below becomes empirical —
    a permanently connected extension either stays up or provably does not — and native
    messaging remains the fallback if Firefox turns out to suspend the page out from
    under a long-lived socket in practice, that being the one property native messaging
    uniquely buys (see the ▸ note under "Why not native messaging").
  - What it does _not_ fix: the first-`tabs_list` timeout above is post-connect and
    orthogonal — a persistent connection may even surface it more often, since
    connect-window failures will stop masking it.
- ~~`tabs_load` on Chrome is unverified.~~ **Resolved: discard churns the id, waking does
  not.** The worry was that waking a discarded tab churns its id a _second_ time, so the
  completion event would name an id `ensureTabReady` is not watching and the wait would
  time out on a tab that had in fact loaded. It does not. Verified on **Chrome
  150.0.7871.187** over CDP against extension 0.1.3: `chrome.tabs.discard(1700729749)`
  returned id `1700729751` (churn confirmed, as AGENTS.md records), `tabs_load` on
  `1700729751` answered `1 ready, 0 pending, 0 failed` in 34–47ms across four runs, the id
  survived the wake every time, and a subsequent `tab_read` extracted the page. The
  re-read-before-answering path in `ensureTabReady` is therefore belt-and-braces on Chrome
  rather than the load-bearing thing it was written to be — keep it, since nothing says a
  future Chrome cannot start churning, but it is no longer the only reason `tabs_load`
  works there.
- Outstanding for v1.1 beyond `tabs_load` itself: sidecar fetch fallback, autonomy ratchets
  (auto-close known-noise domains, auto-close anything clipped), scheduled runs.
- Zen `NativeMessagingHosts` path (only matters for the deferred daemon mode).
- Whether `tabs_list` should expose Zen workspace _names_ (no API today; `hidden` is the
  only signal — see the workspace-heuristic notes in AGENTS.md).
- Whether the idle reconnect loop keeps the Firefox event page from ever suspending. The
  cadence itself is confirmed (below); what is untested is the page's own lifetime, and
  whether a 30s alarm is worth the wakeups it costs when no sidecar will ever answer.
  The answer now also sizes the idle probe loop: the loop's fetches reset no idle timer
  on either engine (not a WebExtension API call, which is what Gecko counts; not an
  event, which is what Chrome counts), but if the page never suspends in practice then
  "while awake" means continuously, and an enabled bridge with no sidecar issues a
  loopback probe every 3s — ~29k/day. Cheap, but a fact to own rather than discover.
- Whether `tab_clip` batching needs throttling on the `obsidian://` handoff (Obsidian URI
  handling under burst load is untested beyond manual Devour rates).
- ~~One port, many sessions.~~ **Resolved: hub mode.** The sidecar no longer assumes it owns
  the browser. Whichever Gullet binds the port becomes the _hub_ and serves the browser; every
  later one attaches to it as a _peer_ over the same socket and proxies its MCP calls through,
  so N agent sessions share one browser connection. When the hub exits, its peers see the
  socket drop and re-race for the port; binding is the election, so the OS settles it
  atomically and two processes can never both believe they are the hub. See
  `gullet/src/backend.ts` (election), `gullet/src/peer.ts` (the attached side), and
  `gullet/src/peer-protocol.ts` (the sidecar-only wire types).
  - What forced it: **nothing guarantees one Gullet per agent session.** The old design read
    a bind failure as "another session has it" and told the user to close that session or pick
    another port. Both are wrong — observed live, a single `codex` process spawned _two_
    sidecars eight seconds apart, and the one its MCP client was actually talking to was the
    loser. Port arbitration cannot fix that at any retry rate, because the winner is the
    loser's own sibling with an identical lifetime.
  - The peer leg reuses the browser handshake — same token, same challenge/proof in both
    directions — and is told apart by an optional `role: "peer"` on the hello. A peer proves
    the token like anything else, and the hub proves it back, so a process squatting the port
    cannot collect another session's tool traffic. Peers are held in their own map: a peer is
    a source of requests, never a target for one, so it can never be offered to an agent as a
    browser.
