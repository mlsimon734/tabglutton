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
`src/bridge-client.ts`, `src/bridge-methods.ts`, `src/undo-log.ts` (extension half). Paths
here are relative to the repo root, not to this file.

Companion docs: `docs/PRODUCT.md` (product register), `docs/DESIGN.md` (visual system),
`AGENTS.md` at the root (contributor notes and the browser-quirk catalogue). UI for the
bridge (badge states, consent surfaces) belongs in DESIGN.md when it lands.

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
┌────────────┐  MCP (stdio)  ┌─────────────┐  WebSocket (auto loopback)  ┌───────────────┐
│ Claude Code │◄────────────►│   Gullet    │◄───────────────────────────►│  Tabglutton   │
│ / any MCP   │              │  (sidecar,  │◄──────────────┐             │  background   │
│   client    │              │  Bun + TS)  │               └────────────►│ (Zen/FF/Chrome)│
└────────────┘               └─────────────┘  multiple browsers may dial  └───────────────┘
```

- **Gullet** is a small Bun/TypeScript process living in this repo (`gullet/`). One side is
  an MCP server over stdio; the other is a WebSocket server bound to one port from the
  shared automatic candidate set. A fixed-port override remains available.
- **The extension background** runs a reconnect loop that probes the same set. When no sidecar
  is running the extension idles without opening WebSockets against empty ports. When a
  connection is live, the toolbar badge indicates it.
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

▸ **A shipping MCP browser extension already does it this way, which settles the product
question but not the technical one.** `mcp-chrome` (MIT) connects its extension to an MCP
server over **native messaging**, via a globally installed `mcp-chrome-bridge` host binary
with its own `register` step. So "users will not install a host binary" is not a real
objection — they do. But it is **Chrome-only**, so it is no evidence at all for the
property this note is actually about: whether an open native-messaging port keeps a
**Firefox MV3 event page** alive. That still needs measuring. Worth noting the trade runs
the other way on distribution: their extension is unpacked-only from GitHub releases
because of that binary, where Tabglutton is a store install plus one `.mcp.json` line. Do
not spend that advantage cheaply.

## Lifecycle: nobody launches an app

There is no user-visible application and no manual step per session:

1. **Install once**: the extension update ships the bridge module; the user adds Gullet to
   `.mcp.json` (or `claude mcp add`) in whatever project/agent runs triage.
2. **Session start**: the agent harness spawns Gullet as an ordinary stdio MCP server.
   Gullet finds the hub already listening and attaches to it as a peer — or, if none is
   running, spawns a **detached hub** and attaches to that.
3. **Connect**: the extension holds a connection to that hub whenever its background page
   is awake, so by session start it is usually already there. Otherwise its reconnect loop
   finds the port: a ~3s HTTP probe loop while awake, with a 30s alarm as the backstop that
   survives page suspension — probing is free where dialling is not (see the reconnect
   notes in AGENTS.md).
4. **Session end**: agent exits → its peer detaches → the hub tells the extension no
   sessions remain → the extension stops holding its page awake. The hub keeps listening,
   and exits by itself after six idle hours.

This is the same UX shape as Claude-in-Chrome (extension + CLI negotiate a local
connection; no dock icon). The difference is we own both ends, so it works on Zen.

▸ **The daemon was weighed as a feature, deferred as one, and came back as a fix**
([#29](https://github.com/mlsimon734/tabglutton/issues/29), shipped). What the
ambient-curation framing missed is that the hub's lifetime was the answer to a reliability
problem polling cannot solve: while the hub died with its agent session, every session
start re-ran discovery and every session's first dial went into a port that had appeared
seconds ago. The probe loop shrank that race to a few seconds; the detached hub removes it.
Ambient curation without an active agent session is still not a goal — the hub serves
sessions, it does not act on its own.

## Automatic candidate-port discovery

The original bridge used one configured port. That was enough for many browsers and many
agent sessions — both are multiplexed behind one hub — but it makes the port itself shared
configuration between two runtimes that cannot read each other's settings. It also makes a
changed default sticky in exactly the wrong way: extension storage preserves the old value,
and a sidecar already in memory preserves the old code.

This stopped being hypothetical on 2026-07-31. A Claude session started before the default
moved was still serving the old, unmarked Gullet response on **4588**; a newer Codex session
was serving the current marked endpoint on **4589**. Chrome had persisted `bridgePort: 4588`,
so its new extension code correctly classified the old generic `403 Forbidden` as foreign
and displayed “Port in use by another program,” while the compatible hub sat one candidate
away. Nothing about the hub prevented Chrome and Zen connecting together — rendezvous had
split across versions.

The implementation is an **automatic candidate mode**, not an arbitrary port scan and not a
contiguous numeric range. The fixed-port path remains for debugging, policy, and deliberate
isolation.

### Configuration contract

- The options page offers **Automatic (recommended)** and **Fixed port**; the numeric input
  belongs to fixed mode only. Extension storage keeps `bridgePortMode` (the user's setting)
  apart from `bridgePort` (authoritative only in fixed mode) and from `bridgeLastPort` — a
  non-setting `storage.local` cache of the last authenticated automatic endpoint, excluded
  from settings change handling, which may improve ordering but must never narrow the
  candidate set or become configuration.
- Gullet mirrors it: no `--port` and no `TABGLUTTON_PORT` means automatic mode, a numeric
  value pins exactly that port, and `--port auto` is accepted for explicitness though
  generated snippets simply omit the flag.
- **Existing numeric MCP configurations stay fixed.** Gullet cannot tell whether an explicit
  `--port 4588` was copied from a shipped default or deliberately chosen, so entering
  automatic mode means removing the flag or environment value — and the options page's
  automatic-mode snippet must not put it back.
- The token is the bridge realm. Same-token browsers and sidecars converge on one hub and are
  selected by `browser` / `connectionId`; a different token may hold another candidate
  without gaining access to the first.

The extension's one-time settings migration (`storage.ts`, pinned in `tests/storage.test.ts`)
reads an absent `bridgePortMode` as automatic when `bridgePort` is a historical default
(`4588` or `4589`) and as fixed at that value otherwise, preserving the token, enablement, and
load permission — changing discovery mode is not token rotation. It therefore treats someone
who manually chose a number that was also a shipped default as automatic. There is no evidence
in the old schema that can recover that intent, and retaining the stale-default failure for
every existing install would defeat the migration. Fixed mode remains one click away.

### Candidate-set contract

- `BRIDGE_PORT_CANDIDATES` lives in `src/bridge-protocol.ts`, beside
  `DEFAULT_BRIDGE_PORT`, and is imported by both builds. The initial ordered set is
  **4589, 20317, 17483, 27613, 24193**.
- The set is ordered, short, non-contiguous, and append-only within a bridge protocol major
  version. Ordering is part of the election contract; two compatible sidecars must never
  see the same candidates in a different order.
- `bridgePortCandidates()` beside it is the one resolver: fixed port if configured, the
  canonical set otherwise, deduped and filtered to bindable ports. All three sidecar call
  sites — the Supervisor's election, a detached hub's bind sweep, and the parent watching
  for the hub it spawned — go through it, so the order cannot drift between them. It was
  three inlined copies, and two of them had already lost the dedupe.
- Additional ports get the same recorded scrutiny as 4589: unassigned by IANA, absent from
  Chromium and Gecko restricted-port lists, and checked for real developer-tool defaults.
  “The next few numbers” is explicitly not a selection rule — the neighbourhood around 4589
  already contains registered and historically busy ports.
- The set stays small enough that one candidate rotation at the awake 3s cadence completes
  comfortably inside `BRIDGE_CONNECT_WAIT_MS`. Tests receive an injected candidate set and
  use ephemeral ports; they never depend on the production numbers being free.
- Candidate additions are compatibility fallbacks, not silent replacements. Older clients
  know only their prefix of the list; if every port they know is occupied, updating that
  client is the honest recovery.

The set was checked on 2026-08-01. Every candidate has no row in the
[IANA service-name and port registry](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml),
is absent from Chromium's
[`kRestrictedPorts`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/port_util.cc)
and Gecko's
[`gBadPortList`](https://hg.mozilla.org/mozilla-central/file/tip/netwerk/base/nsIOService.cpp),
and sits below Linux's default `32768-60999` ephemeral range documented in the
[kernel IP sysctls](https://docs.kernel.org/networking/ip-sysctl.html#ip-local-port-range).
The current macOS host uses `49152-65535`. Developer-convention checks found no dominant
localhost tool on the fallbacks. These registries and defaults can change, and custom OS
ephemeral ranges exist, so additions must repeat the review and append rather than reorder.

### Gullet election across candidates

The invariant generalises from “one port, one hub” to **at most one compatible hub per token
realm across the candidate set**. A round has two phases:

1. **Discovery sweep.** Probe every candidate that answers as Gullet and attempt the peer
   handshake. Attach immediately to the first compatible, same-token hub in canonical
   order. A Gullet with a different token or unsupported protocol occupies that candidate
   but is not our hub; continue the sweep. An HTTP service that does not present Gullet's
   marker is never handed a peer proof.
2. **Binding sweep.** Only after the full discovery sweep found no same-token hub, try to
   bind free candidates in canonical order. The first successful bind becomes the hub.
3. **Race closure.** If a bind loses, re-probe and attempt authenticated peer attachment on
   _that candidate_ before advancing. Two same-token processes starting together will both
   contest the same first usable port; the loser must attach to the winner, not create a
   second hub one slot later.
4. **Exhaustion.** If no candidate can be joined or bound, publish one `startupError` that
   summarises occupied, incompatible, and foreign candidates without tokens or proofs. Keep
   the existing backing-off election alive so freeing a port heals the MCP session in place.

The full discovery sweep before any bind is load-bearing. A same-token hub may live on a
later candidate because earlier ports were occupied when it started; if one of those earlier
ports later becomes free, a new sidecar must still find and join the existing later hub
rather than compacting itself into a split brain.

Hub loss uses the same algorithm. Peers re-elect, one bind wins atomically, and the rest
attach. The proposed detached-hub lifecycle, if implemented later, also uses this election;
automatic ports neither require nor imply a daemon.

### Extension discovery across candidates

Fixed mode keeps today's single-port behaviour. In automatic mode the extension orders the
scan with `bridgeLastPort` first when it is still a candidate, then the remaining canonical
candidates without duplication, and each trigger — startup, an explicit settings sync, an
alarm wake, an `IDLE_PROBE_MS` tick — probes **one** candidate and advances an in-memory
cursor. A full five-port rotation therefore takes about 15 seconds while the page is awake,
and one trigger never becomes N probes or N blind dials. A probe is positive only when the
response carries Gullet's marker with a supported protocol: foreign listeners are skipped, and
a marked endpoint that then fails the token or protocol check advances to the next marked
candidate rather than latching a global conflict. Only mutual proof reaching `hello-ack`
caches a candidate — a cached silent or foreign endpoint is merely tried first and never
blocks fallback — at most one dial is in flight, and the first authenticated connection wins
the pass and cancels the remaining probe work.

The HTTP probe remains a safety device, not an absolute gate. A future browser rule could
block loopback `fetch` while still allowing WebSockets, so the current blind-dial escape
valve survives with a strict bound: after the same instance-only counted misses, an eligible
non-idle tick may blind-dial **one** candidate, rotating from the last-known/default choice.
The 3s idle loop never increments that counter, and one tick never bursts across the set.
Automatic discovery must not turn one Gecko `FailDelayManager` input into N — which is also
why that counter dies with the page rather than persisting; see Open questions.

An unmarked legacy Gullet is indistinguishable from another generic local HTTP service and
is therefore foreign. Automatic mode does not weaken the marker check for compatibility;
it finds a current marked hub on another candidate or reports that none exists. Restarting
the old agent session is the upgrade path.

### Status and diagnostics

- Connected automatic mode displays the selected endpoint, e.g. **Connected on 4589**.
- Fixed mode retains **Port in use by another program** because one foreign answer exhausts
  the user's explicit choice.
- Automatic mode reports **No compatible sidecar found** while it keeps rotating. A foreign
  candidate is evidence about that port, not a reason to stop scanning.
- Gullet writes its selected port, hub/peer role, and candidate-exhaustion summary to stderr.
  The extension logs candidate and classification but never settings wholesale. Neither
  side logs the token, its proof, or a token-derived stable identifier.
- The options-page config snippet omits the port in automatic mode and includes the numeric
  flag only in fixed mode.

▸ **"Connected on \<port\>" and "no browser is connected" can both be true at once.** When
the token changes while an older agent session is still running, the two sidecars are in
different realms: the newer one cannot peer with the older hub — a mismatched token must
never be handed a proof — so it binds a different candidate, and the browser attaches to
whichever realm it finds first. If that is the older one, the extension's badge reports a
healthy connection on a real port while every tool call in the new session insists nothing
is attached. Every component behaves exactly as designed and the pair of facts still reads
as a broken bridge. Observed live; it cost real time to unpick.

The election already knew: `tryExistingHub` records a compatible-marker candidate it could
not join. `Backend.rivalHubs()` now re-probes the candidates on the "no browser" path —
live rather than from those recorded observations, since a rival can appear long after we
settled — and the tool error names the endpoint it found and points at the token as the
reason two sidecars did not merge. Best-effort by construction: a throw inside the
diagnosis must never replace the error it was explaining.

**A normal extension update does not cause this.** `bridgeToken` is minted only by an
explicit action in the options page (default `""`, never auto-regenerated) and
`bridgeLastPort` is written to `storage.local` and put first by
`orderedBridgePortCandidates` on the next start — both survive an update. Only an
_uninstall_ clears `storage.local`. That is the path that produced this: a
delete-and-reinstall regenerated the token, and the new token, not the reinstall, is what
split the realms. Worth stating because the endpoint moving looks like update fragility and
is not.

A filesystem rendezvous file is not part of this design. Gullet, Claude, and Codex could all
read one, but a WebExtension cannot read an arbitrary config directory. Such a file may be
useful later for human diagnostics; it cannot make the two halves discover each other
without native messaging or another fixed bootstrap service.

### Security and failure semantics

- Every candidate remains loopback-only and keeps the extension-origin check and mutual
  nonce proof. Expanding discovery does not expand the tool surface or browser permissions.
- A plain probe may touch a foreign loopback service, but no WebSocket, browser identity, or
  proof is sent unless the endpoint first presents Gullet's marker. The marker is routing
  evidence, not authentication — a malicious local process can imitate it, after which the
  existing mutual proof still decides whether the endpoint belongs to the token realm. As
  today, Gullet publishes no CORS permission, so ordinary web pages cannot read its marker.
- Different-token Gullet hubs may coexist. Authentication failure selects another candidate;
  it never downgrades to sharing and never reports the other realm's browsers.
- Candidate exhaustion is non-fatal to the MCP transport. Tools receive the live startup
  fault while the supervisor continues its bounded, backing-off recovery loop.
- A connected socket is pinned to its authenticated token and endpoint. Token regeneration
  tears it down and starts a fresh full discovery pass; a candidate change alone is not
  revocation.

### Verification

Candidate ordering, migration, election, and probe classification are unit-tested behind
injectable probes and candidate arrays; socket tests bind ephemeral ports, so nothing depends
on the production numbers being free, and those numbers are validated separately against the
selection criteria above.

Three properties are not faithfully represented by any of that, because event-page
suspension, alarm cadence, and Gecko's reconnect delay are not, and are worth re-running on
current Chrome and Zen after changes here: two same-token browsers sharing one auto-selected
hub (with a tab-scoped call refusing to guess between them), hub loss followed by peer
re-election and extension rediscovery without a settings change, and candidate exhaustion
healing in place — an actionable MCP fault while every candidate is occupied, then a normal
session once one frees, with no client restart.

## Wire protocol

One JSON object per WebSocket frame (the frame is the delimiter), versioned:

- Sidecar → extension on connect: `{ type: "challenge", proto: 2, server, nonce }`.
- Extension → sidecar: `{ type: "hello", proto: 2, browser: "firefox" | "chrome",
extVersion, label, nonce, proof }`.
- Sidecar → extension: `{ type: "hello-ack", proto, connectionId, proof, sessions? }`, or
  `{ type: "hello-error", error }`.
- Sidecar → extension requests: `{ type: "request", id, method, params }`; responses
  `{ type: "response", id, result }` or `{ type: "response", id, error: { code, message } }`.
- Sidecar → extension: `{ type: "sessions", count }` whenever the number of agent sessions
  the hub serves changes. This is the extension's entitlement to hold its background page
  awake, which a hub outliving its sessions can no longer imply from the socket alone. An
  **absent** `sessions` on the ack means "assume one" — a hub old enough not to send it
  dies with its session, so for that hub the socket really is the proof.
- Heartbeat ping/pong, as application-level messages rather than WebSocket control frames.
  Every ~20s while a session is attached, dropping to ~5 minutes while none is. Both
  cadences are set by the entitlement above rather than by connection health: on Chrome a
  socket message extends MV3 worker lifetime (since 116, below our
  `minimum_chrome_version`), so a fast beat into an idle hub would pin the worker for
  nobody, and five minutes is comfortably past both engines' ~30s idle timeouts. Control
  frames the browser answers itself would serve neither purpose.

Protocol 2 is an intentional compatibility boundary. Protocol 1 predates both the default
`tabs_list` limit and `tab_clip`'s `vault` override: an old Gullet would omit the limit and
silently lose tabs when talking to a new extension, while an old extension would ignore the
vault and file into the configured destination. The handshake rejects both mixed-version
pairings instead of allowing either call to appear successful with the wrong result.

The bump is not the default for a new field, and the test is whether the other end ignoring
it produces a _wrong_ answer or merely a less precise one. `matched` and `query` are
tolerated across versions precisely because an extension that ignores them costs nothing
the sidecar cannot recompute from what it did send — `tabsList` recomputes both. A missing
`limit` returns tabs that were silently dropped, and a missing `vault` files a clip
somewhere the caller did not ask for; neither is recoverable downstream, and both are
reported as success. Recoverable skew is tolerated; a confidently wrong result forces a
bump.

▸ **The token is not sent.** The sketch had the extension put its token in the hello and
the sidecar echo it back, which proves nothing in the return direction. Instead each side
proves it knows the token by hashing it against a nonce the _other_ side chose:
`proof = SHA-256(len(token):token:nonce)`. The token never crosses the wire, a captured
proof cannot be replayed against a fresh nonce, and the extension's check of the ack is a
real check. Length-prefixing keeps a token containing `:` from being confusable with a
different token/nonce split.

Shared request/response types live in `src/bridge-protocol.ts`, imported by both the
extension and Gullet so the contract is typechecked from one definition.

## Tool surface (v2)

| MCP tool     | Backing APIs                                                                          | Notes                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tabs_list`  | `tabs.query`                                                                          | id, title, url, `windowId` (hoisted when shared), and — only when true — `lastAccessed`, `discarded`, `pinned`, `active`, `hidden`. Filtered with `query`, ordered with `sort`, capped by `limit`, or collapsed to counts with `groupBy: "domain"`. **On Zen, covers the active workspace only.** See below. |
| `tabs_load`  | `tabs.reload` + `tabs.onUpdated`                                                      | Wakes discarded tabs so they can be read. Batched (≤20), three at a time, under a 30s deadline; per-tab `ready`/`pending`/`failed`. Gated on a settings toggle, default off — answers `not-enabled` until then.                                                                                              |
| `tab_read`   | `scripting.executeScript` + existing `clip-current.ts`                                | Returns Defuddle markdown + metadata. Fails cleanly on discarded tabs (see below).                                                                                                                                                                                                                           |
| `tab_clip`   | existing `clip-format.ts` + `obsidian://new` handoff, or `clip-file.ts` + `downloads` | Files exactly as manual Devour does, into whichever destination `clipDestination` names — the vault (including the extension-origin redirect-page dance on both engines) or a markdown file. An optional `vault` overrides the destination for that one call. See below.                                     |
| `tabs_close` | `tabs.remove`                                                                         | Batched, ids deduplicated. Entries (title, url, pinned, window, index, private) are recorded in an undo log in `storage.local` _before_ the removal, and the batch id comes back with the result.                                                                                                            |
| `undo_close` | reopen from the log                                                                   | Safety valve for the one destructive act. Omit the batch id to undo the most recent.                                                                                                                                                                                                                         |

Deliberately absent: navigate, click, type, evaluate.

▸ **`tab_clip` read `obsidianVault` directly, and that was a split rather than a
limitation.** When `clipDestination` landed, a user set to `file` had a working popup and an
agent clip that failed on a missing vault
([#38](https://github.com/mlsimon734/tabglutton/issues/38)). The setting is the user's
answer to "where do clips go", so the bridge obeys it rather than keeping a second,
Obsidian-only notion of the same thing. The two destinations are not equal in what they can
promise, though, and the result says so instead of flattening them: `destination` is
`"obsidian"` or `"file"`, and `confirmedBy` is `"browser"`, `"gullet"`, or `"nobody"`.

A file clip is confirmed by the browser. `saveClipFile` resolves only once the download
reaches `state: "complete"`, which is precisely what an `obsidian://` handoff can never
report, so the extension has already answered from closer to the disk than Gullet ever
stands — and it answers with the path the browser says it wrote, since
`conflictAction: "uniquify"` makes the requested name a prediction. Gullet therefore skips
verification entirely for that destination. Re-checking the download folder would verify the
same fact from further away, against a directory that is not a configured location the way a
vault is and a name it cannot predict.

`"nobody"` is the honest third answer and is never an error, but it does not mean the same
thing about the tab in both destinations. For Obsidian it is the familiar fail-open: no
vault check could run, and the close, if asked for, still happens — the handoff was never
observable, so the pre-verification behaviour is the baseline. For a file it means the
browser had already erased the download's record, which is as consistent with an interrupted
write as a finished one; the result then carries no `file` path either, and Gullet answers
`closed: false` with a `closeSkipped` reason rather than taking a tab over a write nobody
saw. A destination that can see its own writes must not close tabs on weaker evidence than
one that cannot see anything.

Gullet still sends `close: false` for both destinations. The destination is in the answer,
not in the question, so forwarding the caller's `close: true` to find out would already have
closed an Obsidian tab unverified. A file clip pays one extra round trip for that, which is
the cheaper of the two mistakes.

▸ **A Gullet older than the extension swallows a file clip's close.** Its guard is
`if (!result || !vault || !file) return raw`, and a file-destination result carries no
`vault` — so it returns early, having already rewritten `close: true` to `false` on the
wire, and the tab quietly stays open with no `closed` field to explain it. It heals by
itself in the normal case, because a detached hub retires for a newer peer, but a pinned or
long-cached `bunx tabglutton-gullet` against an auto-updated extension is a real pairing.
Not worth a compatibility shim on the extension side — the fix is in the sidecar, and it is
already there.

▸ **`tab_clip`'s `vault` overrides a destination, it does not change a setting.** The
motivating case is a two-vault user: an agent-managed vault that agents file into by
default, and a main vault that occasionally deserves something directly, without a
staging hop it would only have to be moved out of later. The tempting shape for that is a
tool that writes `obsidianVault` — and it is the wrong one. Settings are the user's, edited
in a UI they can see; a tool that mutates one leaves the extension describing a destination
the user never chose, silently, for every clip after it, including the ones from the popup.
A per-call parameter expresses the same intent and expires by construction, so the blast
radius of an agent's mistake is exactly one note. The tool description therefore says to use
it **only when the user names a vault**, and the result reports the `vault` it filed into on
every clip, override or not — an agent that cannot see where a note went cannot tell the
user, and this is precisely the call where that matters. Naming a vault also names Obsidian
for a user whose `clipDestination` is `file`: the override is a destination stated outright,
and writing a download instead would answer the request with a different one.

It does not fall back to the configured vault on a
blank string: `obsidianClipRequest` appends `&vault=` only for a truthy value, so a blank
reaching Obsidian means "whichever vault is open" — but silently substituting settings would
report a destination the caller did not ask for. Both readings are wrong, so `""` is a
`bad-request`. Gullet also checks an explicit name against Obsidian's local `obsidian.json`
vault registry before forwarding it. A readable, understood registry that does not contain
the name produces a `bad-request` listing the vaults that registry knows. This is deliberately
a soft check: the registry is undocumented and incomplete, and its location varies outside a
standard install, so an absent, unreadable, malformed, unfamiliar, or empty registry preserves
the old pass-through behavior. The extension still cannot validate the destination — its handoff
is a URL given to the OS — and Gullet's error therefore describes _known_ vaults rather than
claiming to enumerate every vault on disk. The lookup caches parsed contents by modification
time and size, so a vault added while Gullet is running appears on the next changed-file check.
The string itself is also checked through the same `vaultWarningFor` the options page uses,
so a filesystem path is rejected where a vault name belongs.

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

`tabs_list` with no `browser` argument fans out over every connected browser, so
discovering what is connected costs no extra round trip. The tab-scoped tools refuse to
guess between two browsers, because ids only mean something within one — and for the same
reason a listing targeting two stamps `connectionId` on each returned tab, even when only
one browser matched. It is omitted only when one browser was targeted, because the
top-level `browsers` entry already identifies every returned id then.

▸ **A listing is budgeted against a model's context, not against the socket.** The
measurement that drove this, from a real 874-tab Zen: 306 KB of JSON in one tool result,
which is past the client's tool-result ceiling — so the agent got _nothing_, and there was
no narrower call available to fall back to. `browser` and `connectionId` were constants
repeated once per tab (13%). `discarded`, `hidden`, `active`, and `pinned` were 17.6%
while carrying eleven `true` values between them — `hidden` was `false` on all 874.

**Deleting the boilerplate was not enough, and that is the point.** Reconstructing that
listing from its reported per-field byte totals (within 0.5% of the original) and applying
the shape changes alone lands at **215 KB, 252 bytes a tab** — a 29% cut that is still far
past the ceiling, so the call still fails and the agent still gets nothing. What makes it
usable is narrowing. Measured over the same 874 tabs:

|                                                                 | whole backlog | per tab | at the default limit |
| --------------------------------------------------------------- | ------------- | ------- | -------------------- |
| original                                                        | 306 KB        | 363 B   | — (no limit existed) |
| constants hoisted, false flags dropped                          | 215 KB        | 252 B   | 49 KB                |
| `index` dropped, `windowId` hoisted, title clipped, URL trimmed | 158 KB        | 185 B   | **36 KB**            |
| `groupBy: "domain"`                                             | **0.4 KB**    | —       | —                    |

So the shape work is worth having — it halved the per-tab cost, and per-tab cost is what
decides how many tabs fit under a given limit — but it is a constant factor on something
that scales with the user's backlog. Only the filter changes the shape of the problem.

Five changes, in the order they matter:

1. **`query`, `limit`, `sort`.** The one that actually mattered: the session that produced
   the measurement wanted "the x.com tabs" and had to ask for all 874 to find them.
   `query` is a case-insensitive AND over whitespace-separated terms, matched against title
   and URL together, so "github pull" finds a tab whose title and URL each carry one term.
   Deliberately not a regex: an agent-authored regex is an unbounded backtracking risk on a
   thousand strings, and substring terms are what triage actually needs.
2. **`groupBy: "domain"`** — counts only, no tabs. The real triage primitive: one cheap
   call says what the backlog is made of and what to pass as `query` next. It honours
   `query` too, so it can count one slice rather than the whole backlog, and it gets its
   own tighter default limit (`TABS_LIST_DEFAULT_GROUP_LIMIT`, 50): the real 874-tab
   browser held **298 distinct domains**, and everything past roughly the fiftieth was a
   single tab — 250 rows of noise around the ~20 that describe the backlog. The domain is
   the hostname minus `www.`, not the registrable domain: eTLD+1 needs the Public Suffix
   List, which `bridge-protocol.ts` cannot take as a dependency and which goes stale, and
   `mail.google.com` vs `docs.google.com` is the distinction triage wants anyway.
3. **False and unknown fields are omitted**, not sent. Absent means false; absent
   `lastAccessed` means the browser reported none.
4. **Constants are hoisted** out of the tabs — `browser`/`connectionId` into the existing
   top-level `browsers` array per the stamping rule above, and `windowId` to the top level
   whenever every tab shares one window, which on a single-window Zen is all of them.
   `index` is gone outright: it duplicated the array order under `sort: "window"`, meant
   nothing under the others, and nothing consumed it — the undo log takes position from
   the live `browser.tabs.Tab`, not from a listing.
5. **Titles are clipped and URLs trimmed** (`src/tabs-view.ts`). Titles at
   `TAB_TITLE_MAX` (120) with a trailing `…`; there is no gentler cap, because the mean
   title in that backlog was ~104 characters, so anything tighter cuts into the body of
   the distribution rather than its tail. What a clipped title loses is cheap — titles are
   front-loaded and the tail is usually the site suffix (`" | GitHub"`) the URL already
   gives you.

   URLs are **not** clipped by default, because a URL cut mid-string stops being a URL:
   it cannot be handed back to the user, and two distinct tabs can clip to the same prefix
   and read as duplicates. They are trimmed structurally instead — `displayUrl` drops the
   click-tracking params (sharing `isTrackingParam` with `normalizeUrl`, so there is one
   list), the `www.`, and the trailing slash, which is where long URLs get long. It keeps
   the scheme, so the result is still copyable, and keeps the fragment, which for an SPA
   is the entire page identity. `TAB_URL_MAX` (200) is a backstop for data: URIs and
   pathological paths, not the mechanism.

Two things about `limit` are load-bearing. It **defaults** to `TABS_LIST_DEFAULT_LIMIT`
(200) rather than being opt-in, because the failure it prevents is total — an unbounded
listing returns nothing usable — and truncation is always visible: `matched` counts what
the filter hit, `truncated` says the answer is partial. And the default `sort` is `recent`
rather than the browser's own window order, which is what makes truncation defensible: the
tail that gets cut is the tabs the user touched longest ago, not an arbitrary slice.

The filter/sort/limit pipeline (`selectTabs`) lives in `bridge-protocol.ts` and runs
**twice**. In the extension, so a backlog never crosses the socket whole; and again in
Gullet over the merged results, because a limit applied per browser is not the limit the
agent asked for. Running it a second time also means an older extension that ignores
`query` still yields a filtered answer instead of a flood. `groupBy` is the exception:
Gullet asks the extension for the full filtered set and groups it there, since a limit
applied before grouping would corrupt the counts — and the full list crossing loopback
costs nothing, which is the whole point of where the budget actually is.

**Selection and rendering are separate passes for a reason.** `renderTabs`
(`src/tabs-view.ts`) runs _once_, in Gullet, at the very end — never in the extension,
even though clipping there would shrink the socket frame. Gullet re-applies `query` over
the merged results, and a query matching text that clipping had already removed would
silently drop the exact tab the agent asked for. So every filter sees whole strings and
only the bytes handed to the model are trimmed. This is the same trade as `groupBy`: the
socket is loopback, and loopback bytes are not the budget anyone is spending.

▸ **`matched` is the browser's, not Gullet's, and recomputing it was a silent lie.**
Gullet read only `tabs` from each browser's reply and let its second `selectTabs` pass
derive `matched` from what arrived. But a current extension truncates to `limit` _before_
sending, so the tabs that arrive are not the tabs that matched: 200 of 874 came back and
were reported as `matched: 200` with no `truncated` — the agent's one signal that it had
not seen everything, destroyed exactly when there was more to see. It now keeps each
browser's reported `matched`, falling back to its own count only when a browser sends none
(which is how an older extension identifies itself), resolved per connection and summed —
two attached browsers can be different versions.

This one was **invisible in live testing**, because the browser it was tested against was
0.2.0 and sends everything unfiltered, so page size and match count were the same number.
It would have appeared on first contact with the very build that fixes the loopback cost.
Found by reading the path rather than running it, which is the argument for tracing a
change end to end before signing a build, not after. (The question that prompted the trace
— whether the `Number.POSITIVE_INFINITY` limit used for `groupBy` survives the wire — was
a non-issue: it is spent on a `slice` inside the extension and never reaches
`TabsListResult`, so `JSON.stringify` never gets the chance to turn it into `null`.)

▸ **The second pass hid a bug from itself, and only a stale extension exposed it.**
`groupBy` grouped the _unfiltered_ merge: `tabs_list { query: "x.com", groupBy: "domain" }`
answered `matched: 874, domains: 298` — the whole backlog, identical to the unfiltered
call. The filter lived inside `selectTabs`, and the grouping branch skipped `selectTabs`
entirely. Against a **current** extension this was invisible, because the extension had
already applied `query` before sending; it only surfaced against a real browser running
0.2.0, which ignores `query` and hands over everything. So the version-skew tolerance that
the second pass exists to provide is exactly what stopped the bug being noticed, and the
skew itself is what revealed it. The filter is now `filterTabs`, called by both paths.
The lesson generalises: a redundant safety pass has to be tested with the primary pass
_disabled_, or it is only ever exercised as a no-op.

`renderTabs` also tolerates a tab missing `title` or `url` rather than throwing. The
extension guarantees both, but a version-skewed one does not, and one malformed entry must
not destroy a listing of eight hundred — the same reason `tabs_list` keeps a failing
browser's partner.

▸ **A Zen listing is the active workspace, and `hidden` does not tell you otherwise.**
Measured live on the 874-tab browser: `groupBy: "domain"` answered `matched: 874,
domains: 298`; after a workspace switch the same call answered `matched: 160, domains: 66`
with a disjoint set of domains, and `includeHidden: false` changed neither number. So tabs
in a non-active workspace are **absent from `tabs.query`, not flagged `hidden`** — the
condition `probeHeuristic` in `background.ts` was written to detect (`allInWindow.length
=== visibleInWindow.length`) is simply true here. Both readings hoisted the same
`windowId`, so this is one window enumerating differently, not a second window appearing.

This is accepted behaviour, not a bug to fix: Zen exposes no workspace API (see AGENTS.md),
and active-workspace scope is the reasonable contract. What was wrong was the _claim_ —
`tabs_list` told agents `hidden: true` meant "another workspace", so an agent seeing 160
tabs would report them as the user's whole backlog with no hedge, and `matched` reads as
authoritative either way. The tool description and `GULLET_INSTRUCTIONS` now state the
scoping outright.

The honest remaining gap is that **nothing in the result says which workspace it is**, so
two listings taken minutes apart are not comparable and nothing in the payload reveals it.
Naming the workspace is impossible without an API Zen does not have; the available half-
measure is for the extension to surface `probeHeuristic`'s verdict on the listing itself,
which is a wire change and is not made here. It only became visible at all because the
payload work made two listings small enough to compare at a glance.

▸ **This may also settle the first-`tabs_list` timeout** in the open questions below.
_Response size_ is one of the two live hypotheses for it, and a first call that used to
serialise ~300 KB into one WebSocket frame now serialises ~36 KB. That is not a fix, and
it is not evidence — but it does mean the symptom recurring at the new size would rule
response size out and leave startup contention, which is the discriminating test that was
otherwise awkward to run.

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
  projects; `bun test` picks up `gullet/tests/`). Its agent-only tab renderer now lives in
  `gullet/src/tabs-view.ts`, so it no longer compiles into either extension target. The
  package has no dependencies of its own — Bun's built-in WebSocket server and a hand-rolled
  tools-only MCP server are enough — and bundles those shared sources into the published
  `tabglutton-gullet` executable for `bunx` / `npx` use without a checkout.
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

- **Why the first `tabs_list` of a session timed out on a large backlog.** Recurring, not a
  one-off, at the time it was raised ([#27](https://github.com/mlsimon734/tabglutton/issues/27)):
  the first call after an extension reload failed with `timeout` at the full 45s
  `BRIDGE_REQUEST_TIMEOUT_MS`, and an immediate retry of the same call succeeded. Observed on
  Zen 1.21.9b at 730 tabs in one window (~1000 total) with extension 0.1.3.7. **Both stated
  hypotheses are now measured out, the failure did not reproduce, and no code changed** — the
  numbers and the reason for leaving it alone are below.
  - **Ruled out at the time.** Not the connection: a `tab_read` on the same `connectionId`
    answered correctly and instantly inside the same window of time. Not a stale hub entry:
    `selectOne` would have reported `ambiguous-target` and did not, so exactly one browser was
    registered. Not `tabsList` itself: unchanged across the whole fix series, and it succeeds
    seconds later against the same tab set.
  - **Both hypotheses were claims about milliseconds, and both are wrong by three orders of
    magnitude.** Measured in the extension's own context at **1000 tabs in one window**
    (`scratch-chrome/repro-first-list-timeout.ts`, Firefox 134.0.2 on a dedicated profile;
    `time-list-at-scale.ts`, Chrome 151). _Startup contention_: `queryAllTabs()` **10ms**,
    `probeHeuristic()`'s two queries **14ms**, `refreshBadge()`'s query **6ms**, mapping every
    tab to a `BridgeTab` **1ms** — the entire pass `init()` runs ahead of serving is ~30ms on
    Gecko and ~115ms on Chrome. _Response size_: the reported ~253 KB listing is **248.7 KB**
    here, and `JSON.stringify` of it costs **0.2ms** on both engines. Nothing in either
    hypothesis is within 1000× of 45,000ms.
  - **The discriminating test the issue asked for came back negative.** Two `tabs_list` calls
    back to back immediately after `browser.runtime.reload()` at 1000 tabs: **16ms** and
    **44ms**, both correct, and a third sequential call **13ms**. A full-detail listing of all
    1000 was **16ms**. The only slow call in the whole run was the _cold_ first one — **2989ms**,
    which is the extension's probe loop finding the freshly-bound sidecar, not the query.
  - **What does produce exactly this shape is a browser that stops reading its socket**, and
    that is indistinguishable from the outside: the connection is genuinely healthy, the retry
    is instant, and a call landing either side of the stall answers normally.
    `scratch-chrome/probe-unresponsive-browser.ts` induces it with `SIGSTOP` on the browser's
    parent process, and the result is also the reason not to chase this further: **on current
    code the symptom no longer occurs.** The hub's 20s heartbeat noticed the missed pong and
    dropped the connection at **38s** with `no-connection` — "Firefox disconnected
    mid-request" — rather than letting the call ride to a 45s `timeout`; `SIGCONT` reattached
    (`conn-2`) and the next call answered in **412ms**. That heartbeat, the stale sweep on
    session attach (see `syncHeartbeat`), and the detached hub all landed after 0.1.3.7.
  - **Not reproduced, so this is a mechanism rather than a verdict**, and three caveats keep it
    honest: Firefox 134.0.2 is not Zen 1.21.9b (Firefox ~153, plus workspace machinery of its
    own), 1000 `about:blank` tabs are not 1000 real pages with content processes behind them,
    and no run here ever failed. What can be said is that the two hypotheses on record are
    excluded by measurement, and that the browser-side stall which is left would today be
    reported as a dropped connection within 40s instead of a 45s timeout. **Reopen with a fresh
    observation on current code rather than pre-emptively hardening against a symptom that
    already has a different answer** — a retry wrapped around `tabs_list` would hide precisely
    the signal a new report would need.
- ~~**Session-start connect latency.**~~ **Resolved: mitigated by faster discovery, then
  ended by the detached hub** (the ▸ note at the end of this entry is the resolution; the
  history below is kept because every constant it names is still load-bearing).
  The recurring "first connection window misses, the retry succeeds" was a race
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
  - ▸ **Resolved: the detached hub shipped** ([#29](https://github.com/mlsimon734/tabglutton/issues/29)).
    Polling existed only because the hub's lifetime was bound to the agent session that
    spawned it. The first Gullet that finds no listener now spawns a _detached_ hub and
    attaches to it as a peer, exactly as later sessions already did, so the browser's
    connection predates the session and session start is a local peer attach — measured
    at **41ms** against a hub left behind by a killed session, with no election at all.
    Everything in the sketch survived contact: the hub self-exits after six idle hours,
    version skew rides the hello (a newer peer's `gullet` version makes an older detached
    hub retire and release the port), and nothing about the trust boundary moved — same
    port, same token, same origin check. Full account in `docs/ENGINEERING.md`
    §Detached hub.
  - The **keepalive entitlement** was the honest open problem, and it was designed before
    the rest was built. A live socket used to be proof that an agent session existed,
    which is what justified holding the event page awake (`KEEPALIVE_PING_MS`); a hub that
    outlives sessions breaks that proof. The hub now counts sessions and publishes the
    number (on the `hello-ack` and on every change), and the extension holds the page
    awake only above zero — with an **absent** count meaning entitled, since a hub old
    enough not to send one dies with its session anyway. Two things the sketch did not
    anticipate: the extension's own heartbeat has to stop as well, because a WebSocket
    message is itself MV3 activity on Chrome and a 20s beat would pin the service worker
    forever; and the hub therefore drops to `BRIDGE_IDLE_HEARTBEAT_MS` while idle,
    re-checking its connections the instant a session arrives. Verified live on Firefox
    134.0.2 by watching connection identities: unentitled, the connection turned over at
    t+1s/t+33s/t+93s; entitled, one id held for 120s unbroken; on the session leaving, the
    socket dropped at once and the churn resumed.
  - What it settled for free: the event-page-lifetime question below is now answered by
    construction rather than by measurement — the page suspends exactly when no session
    needs it, which is what the question was really asking. Native messaging remains the
    fallback only if Firefox turns out to suspend the page out from under a socket a
    session _does_ need, that being the one property native messaging uniquely buys (see
    the ▸ note under "Why not native messaging").
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
- ~~Whether the idle reconnect loop keeps the Firefox event page from ever suspending.~~
  **Measured: it does not, and the page suspends on schedule even while connected.**
  Firefox 134.0.2, extension 0.3.1, connected to a detached hub with no session attached:
  the browser's connection identity turned over at t+1s, t+33s and t+93s — the page
  suspending after its ~30s idle timeout, the socket dying with it, and the 30s alarm
  redialling. With a session attached the same id was held for 120s unbroken, so the
  keepalive is what holds the page up and nothing else does. The loop's own fetches reset
  no idle timer on either engine (not a WebExtension API call, which is what Gecko counts;
  not an event, which is what Chrome counts), so "while awake" is bounded in practice
  rather than continuous, and an enabled bridge with no sidecar probes far less than the
  ~29k/day the never-suspending case would have implied. What remains open is only whether
  the 30s alarm is worth its wakeups when no sidecar will ever answer.
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
