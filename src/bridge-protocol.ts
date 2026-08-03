// Wire contract for the agent bridge (see docs/BRIDGE.md). Imported by BOTH the
// extension background and the Gullet sidecar, so it must stay pure: no
// `browser.*`, no Bun, no DOM. WebCrypto is the one ambient dependency and is
// present in every runtime that speaks this protocol.
//
// One JSON object per WebSocket frame — the frame is the delimiter, so no
// newline framing is needed on top of it.

// The one import, and it stays pure by the rule above: shared so an agent's
// vault override is rejected for exactly the reasons the options page warns
// about, rather than by a second, drifting copy of the same rules.
import { vaultWarningFor } from "./vault-warning.js";

// Protocol 2 makes tabs_list's default limit and tab_clip's vault override
// mandatory on both ends. Protocol 1 peers cannot safely ignore either field.
export const BRIDGE_PROTO = 2;

/**
 * Chosen by elimination rather than by liking the number (2026-07-29). Three
 * axes have to be clear at once, and most of this neighbourhood fails one:
 *
 * 1. **IANA.** 4589/tcp is unassigned. From 4590 up is a dense block of 3GPP2
 *    registrations (`rid`, `l3t-at-an`, the `ias-*` family), so this is the top
 *    of a real gap, not a hole waiting to be filled. `nmap-services` has no
 *    4589/tcp entry, and GRC's database documents no application or malware.
 * 2. **Browser blocklists.** Neither Chromium's `kRestrictedPorts`
 *    (`net/base/port_util.cc`) nor Gecko's `gBadPortList`
 *    (`netwerk/base/nsIOService.cpp`) contains it. A blocked port would fail
 *    the probe outright with no useful error, so this one is worth rechecking
 *    if the port ever moves.
 * 3. **Developer convention**, which is what actually bites on loopback and
 *    which no registry covers. Measured as GitHub code-search frequency for
 *    `localhost:<port>`: the floor across 4574-4589 is 250-600 hits, while a
 *    real convention is orders of magnitude above it (3000 is 1.6M, 8080 590k,
 *    5173 574k, 4200 149k, 4321 28k, 4444 10k, 4567 7k). No 458x port is a
 *    convention.
 *
 * Frequency alone hides single tools, though, and that is what moved this off
 * its original 4588: those hits were dominated by **floci-gcp**, a local GCP
 * emulator (166 stars, May 2026, active) whose sole service port is 4588.
 * 4589's comparable count is an incoherent long tail with nothing defaulting
 * to it.
 *
 * Do not "fix" a future collision by shifting a few ports down. Legacy
 * LocalStack allocated **4567-4587 contiguously**, one port per AWS service
 * (4584 is Step Functions, hence the LocalStack demos that surface when you
 * search it), plus 4592/4593/4597. 4588 and 4589 are the two ports above that
 * block, which is why they were free — everything below is busier, not quieter.
 */
export const DEFAULT_BRIDGE_PORT = 4589;

/**
 * Ordered, append-only ports used by automatic discovery. The first entry is
 * the historical default, so a normal one-sidecar install stays where it was.
 *
 * Verified 2026-08-01: every entry is unassigned by IANA, absent from both
 * Chromium's and Gecko's restricted-port lists, and below the default Linux
 * and macOS ephemeral ranges. No unassigned port is guaranteed free; the list
 * is deliberately small because this is deterministic discovery, not a scan.
 * Add future candidates at the end so independent upgrades keep agreeing on
 * which compatible hub wins.
 */
export const BRIDGE_PORT_CANDIDATES = [4589, 20317, 17483, 27613, 24193] as const;

/**
 * Where Gullet keeps its global settings, under `$XDG_CONFIG_HOME` (or
 * `~/.config`). Shared because the options page renders the setup command that
 * *creates* this file while `gullet/src/config.ts` is what reads it — the two
 * must agree exactly, and renaming either one otherwise typechecks cleanly
 * while silently breaking the only documented way to install a token.
 */
export const CONFIG_DIR_NAME = "tabglutton";
export const DEFAULT_TOKEN_FILE_NAME = "token";

/**
 * Marker Gullet returns on any non-upgrade request, so a probe can tell "the
 * sidecar is here" from "something else owns this port". Both are HTTP
 * responses and used to be indistinguishable, which is the whole problem: see
 * `probePort` in bridge-client for what dialling a stranger costs.
 *
 * Sent as both a header and a body prefix. The header is what the probe reads;
 * the body is the fallback for any context where response headers come back
 * filtered, and doubles as the human answer for someone who loads the port in
 * a tab. Neither is a disclosure: Gullet sets no CORS headers, so a web page
 * cannot read either one, and a local process could already tell a listener is
 * here by connecting to it.
 */
export const BRIDGE_PROBE_HEADER = "x-tabglutton-bridge";
export const BRIDGE_PROBE_MARKER = "tabglutton-bridge";
export const BRIDGE_PROBE_BODY_PREFIX = `${BRIDGE_PROBE_MARKER}/${BRIDGE_PROTO}`;

export type BridgeProbeIdentity = "compatible" | "incompatible" | "foreign";

/** Classify an HTTP probe without ever WebSocket-dialling an unidentified port. */
export function classifyBridgeProbe(
  protocolHeader: string | null,
  body: string,
): BridgeProbeIdentity {
  if (protocolHeader !== null) {
    return protocolHeader.trim() === String(BRIDGE_PROTO) ? "compatible" : "incompatible";
  }
  if (body.startsWith(BRIDGE_PROBE_BODY_PREFIX)) return "compatible";
  if (body.startsWith(BRIDGE_PROBE_MARKER)) return "incompatible";
  return "foreign";
}

/** Put a proven recent automatic port first without changing canonical order. */
export function orderedBridgePortCandidates(lastPort?: number): number[] {
  const canonical = [...BRIDGE_PORT_CANDIDATES];
  if (lastPort === undefined || !BRIDGE_PORT_CANDIDATES.some((port) => port === lastPort)) {
    return canonical;
  }
  return [lastPort, ...canonical.filter((port) => port !== lastPort)];
}

/**
 * A port the sidecar could actually listen on: below 1024 needs root to bind
 * and 65535 is the ceiling. Both ends validate the user's port — the options
 * page falls back to the default, Gullet refuses to start — so the rule itself
 * lives here rather than being spelled out twice.
 */
export function isBridgePort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}
export const BRIDGE_HEARTBEAT_MS = 20_000;
export const BRIDGE_REQUEST_TIMEOUT_MS = 45_000;
/**
 * Deadline for the token exchange, measured from the socket *opening*. By then
 * both ends are connected and the remaining work is two SHA-256 digests over
 * loopback, so this is generous.
 */
export const BRIDGE_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Deadline for the dial itself — getting a socket open at all. Deliberately
 * enormous next to the handshake, because a connect is not ours to schedule.
 *
 * Gecko delays reconnects to an endpoint that has been refusing
 * (`network.websocket.delay-failed-reconnects`), and applies that delay *before*
 * issuing the TCP connect — so the socket sits in CONNECTING with nothing for
 * `lsof` to see, and any deadline shorter than the delay aborts every attempt
 * before it can land. Both earlier values were shorter and both wedged the
 * bridge completely: verified on Zen against a sidecar answering `curl` in
 * 0.47ms with a 101, while the extension dialled and timed out at a flat 25s
 * forever. The tell that it is this and not a dead server: the browser reaches
 * the same port fine over plain HTTP (`http://127.0.0.1:4588/` renders Gullet's
 * 403), and the timeout is suspiciously *constant* — a real connect failure
 * varies, a deadline does not.
 *
 * 120s is twice the worst case the browser can impose, which is worth stating
 * exactly because the number looks arbitrary otherwise. The backoff is
 * `FailDelayManager` in `netwerk/protocol/websocket/WebSocketChannel.cpp`:
 * `kWSReconnectMaxDelay` caps it at 60s, reached by growing x1.5 per failed
 * connect from 200-400ms, so ~14 consecutive failures hit the ceiling. It is
 * measured from the *last* failure, and a successful connect drops the record
 * outright — so it only ever bites a bridge that has been dialling an empty port
 * for minutes, which is what BridgeClient's probe now avoids.
 *
 * What this bounds, then, is the pathological socket that neither opens nor
 * errors at all, which would otherwise pin the client in "connecting" for the
 * life of the page. Every other path resolves long before it.
 */
export const BRIDGE_DIAL_TIMEOUT_MS = 120_000;

/**
 * How long a tool call waits for a browser to dial in before giving up on one.
 * Must exceed the extension's reconnect period *with real margin*: its
 * background page can be suspended when a session starts, and a suspended page
 * only redials when the alarm wakes it, so a call can legitimately arrive a
 * full period before there is any socket. Answering "no browser is connected"
 * inside that window reports a scheduling artefact as a missing browser.
 *
 * 45s = one 30s alarm period plus the slop that sits on top of it, none of
 * which is small at this project's scale: alarm delivery jitter, waking and
 * re-running `init()` over ~1000 tabs on the page's single thread, then
 * probe + dial + handshake. The previous 35s left 5s for all of that and lost
 * the race often enough that "first call fails, immediate retry succeeds" was
 * the observed session-start signature. The awake path does not need the
 * margin at all — `IDLE_PROBE_MS` in bridge-client typically lands the
 * connect within a few seconds — so the full wait is only ever served when
 * the page really was suspended, or no browser is running.
 */
export const BRIDGE_CONNECT_WAIT_MS = 45_000;

export type BridgeBrowser = "firefox" | "chrome";

export type BridgeErrorCode =
  | "unauthorized"
  | "bad-request"
  | "not-found"
  | "tab-discarded"
  | "extract-failed"
  | "vault-missing"
  | "unsupported"
  /** The capability exists but the user has not switched it on. Distinct from
   * "unsupported" on purpose: this one has a fix the agent can tell them. */
  | "not-enabled"
  | "no-connection"
  | "ambiguous-target"
  | "timeout"
  | "internal";

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

// --- Handshake -------------------------------------------------------------
//
// The shared token is never put on the wire. Each side proves it knows the
// token by hashing it with a nonce the *other* side chose:
//
//   server → challenge { serverNonce }
//   client → hello     { proof: H(token, serverNonce), clientNonce, identity }
//   server → hello-ack { proof: H(token, clientNonce), connectionId }
//
// A hostile page that manages to open the socket cannot answer the challenge,
// and the extension refuses to talk to a server that cannot answer in return.

export interface ChallengeMessage {
  type: "challenge";
  proto: number;
  server: string;
  nonce: string;
}

export interface HelloMessage {
  type: "hello";
  proto: number;
  browser: BridgeBrowser;
  extVersion: string;
  label: string;
  nonce: string;
  proof: string;
  /**
   * Who is dialling. Absent means "browser", which is what the extension always
   * is and always omits. The other value is used only between Gullet processes:
   * the one that binds the port serves the browser, and later ones attach as
   * peers rather than dying, so several agent sessions share one connection.
   * Everything after the handshake differs by role, so it has to be settled
   * inside it.
   */
  role?: "browser" | "peer";
}

export interface HelloAckMessage {
  type: "hello-ack";
  proto: number;
  connectionId: string;
  proof: string;
}

export interface HelloErrorMessage {
  type: "hello-error";
  error: BridgeError;
}

export interface RequestMessage {
  type: "request";
  id: string;
  method: BridgeMethod;
  params: unknown;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  result?: unknown;
  error?: BridgeError;
}

export interface PingMessage {
  type: "ping";
  t: number;
}

export interface PongMessage {
  type: "pong";
  t: number;
}

export type ServerMessage =
  | ChallengeMessage
  | HelloAckMessage
  | HelloErrorMessage
  | RequestMessage
  | PingMessage
  | PongMessage;

export type ClientMessage = HelloMessage | ResponseMessage | PingMessage | PongMessage;

export type BridgeMessage = ServerMessage | ClientMessage;

/**
 * Hex SHA-256 over the token and nonce. Both sides derive it identically.
 * The token is length-prefixed so the two fields cannot be shifted across the
 * separator: without it, ("a:b", "c") and ("a", "b:c") hash the same bytes.
 */
export async function deriveProof(token: string, nonce: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${token.length}:${token}:${nonce}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Constant-time-ish string compare, so proof checks don't leak by timing. */
export function proofsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function randomNonce(): string {
  return randomHex(16);
}

/** Tokens are shown to the user and pasted into a config file — keep them typable. */
export function generateToken(): string {
  return randomHex(24);
}

// --- Methods ---------------------------------------------------------------

export const BRIDGE_METHODS = [
  "tabs_list",
  "tabs_load",
  "tab_read",
  "tab_clip",
  "tabs_close",
  "undo_close",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === "string" && (BRIDGE_METHODS as readonly string[]).includes(value);
}

/**
 * One tab as an agent sees it. Every field that is false or unknown is
 * **omitted**, not sent — this object is repeated once per tab into a model's
 * context, and on a real backlog the boilerplate outweighed the signal:
 * measured over 874 tabs, `discarded`/`hidden`/`active`/`pinned` cost 17.6% of
 * a 306 KB listing while carrying eleven true values between them. Absent means
 * false; absent `lastAccessed` means the browser did not report one.
 */
export interface BridgeTab {
  id: number;
  title: string;
  url: string;
  /** Epoch ms of last activation. Omitted when the browser does not report it. */
  lastAccessed?: number;
  /** Unloaded tab — `tab_read`/`tab_clip` cannot run a content script in it. */
  discarded?: boolean;
  pinned?: boolean;
  active?: boolean;
  windowId: number;
  index: number;
  /** Firefox only. On Zen this approximates "belongs to another workspace". */
  hidden?: boolean;
}

/**
 * - `recent` (default): most recently accessed first. The triage order, and the
 *   one that makes `limit` mean something — the truncated tail is the tabs the
 *   user touched longest ago, not an arbitrary slice.
 * - `oldest`: the reverse, for finding stale tabs directly.
 * - `window`: browser order (window, then position), which is what the user sees.
 */
export type TabsListSort = "recent" | "oldest" | "window";

/**
 * Default ceiling on tabs returned. A listing is the one bridge result whose
 * size scales with the user's backlog, and it lands whole in a model's context:
 * 874 tabs came back as 306 KB and blew past the client's tool-result limit, so
 * the agent got nothing at all. Truncating is strictly better than that — and
 * always reported, via `matched` and `truncated`, so an agent can see it did not
 * get everything and narrow with `query` instead of guessing.
 */
export const TABS_LIST_DEFAULT_LIMIT = 200;

/** Ceiling on an explicit `limit`. Above this a listing is not triage material. */
export const TABS_LIST_MAX_LIMIT = 2000;

/**
 * Default ceiling on `groupBy: "domain"` rows, which is much tighter than the
 * tab default because a domain histogram has a long, uninformative tail. A real
 * 874-tab backlog held 298 distinct domains, and everything past roughly the
 * fiftieth was a single tab — 250 rows of noise around the ~20 that describe the
 * backlog. `domains` still reports the true count, so the tail is visible
 * without being spelled out.
 */
export const TABS_LIST_DEFAULT_GROUP_LIMIT = 50;

export interface TabsListParams {
  /** Default "all": every window. "current-window" narrows to the focused one. */
  scope?: "all" | "current-window";
  /** Firefox: include tabs hidden by another Zen workspace. Default true. */
  includeHidden?: boolean;
  /**
   * Case-insensitive filter over title and URL. Whitespace splits it into terms
   * that must **all** match, in either field — "github pull" finds a PR tab
   * whose title says "Pull request" and whose URL says github.com.
   */
  query?: string;
  /** Max tabs (or domain groups) returned. Default {@link TABS_LIST_DEFAULT_LIMIT}. */
  limit?: number;
  /** Default "recent". */
  sort?: TabsListSort;
  /** Return per-domain counts instead of tabs. `sort` and per-tab fields do not apply. */
  groupBy?: "domain";
}

/** `TabsListParams` with every default filled in, as both ends act on it. */
export interface ResolvedTabsListParams extends TabsListParams {
  scope: "all" | "current-window";
  includeHidden: boolean;
  sort: TabsListSort;
  limit: number;
}

export interface TabsListResult {
  tabs: BridgeTab[];
  /** Tabs matching `query` before `limit` was applied. */
  matched: number;
  /** True exactly when `matched > tabs.length`. Omitted otherwise. */
  truncated?: boolean;
}

/** One domain's share of the backlog, from `tabs_list` with `groupBy: "domain"`. */
export interface TabDomainGroup {
  /** Hostname with a leading `www.` dropped; the scheme for schemeless URLs. */
  domain: string;
  tabs: number;
  /** How many of them are unloaded, so `tabs_load` is needed before reading. */
  discarded: number;
  /** Most recent `lastAccessed` in the group. Omitted when none reported one. */
  newest?: number;
}

export interface TabsListGroupResult {
  groups: TabDomainGroup[];
  /** Distinct domains matched, before `limit`. */
  domains: number;
  /** Tabs matched across every domain, including groups `limit` cut. */
  matched: number;
  truncated?: boolean;
}

/**
 * The domain a tab is filed under for `groupBy`. Deliberately the hostname
 * rather than the registrable domain: eTLD+1 needs the Public Suffix List,
 * which is a dependency this protocol module cannot take and a table that goes
 * stale, and for triage `docs.google.com` vs `mail.google.com` is the
 * distinction that matters anyway.
 */
export function tabDomain(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  const host = parsed.hostname;
  if (!host) return parsed.protocol.replace(/:$/, "");
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** All whitespace-separated terms present in the title or the URL, ignoring case. */
export function matchesTabQuery(tab: BridgeTab, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${tab.title}\n${tab.url}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function compareTabs(sort: TabsListSort): (a: BridgeTab, b: BridgeTab) => number {
  if (sort === "window") return (a, b) => a.windowId - b.windowId || a.index - b.index;
  return (a, b) => {
    const x = a.lastAccessed;
    const y = b.lastAccessed;
    // A tab with no reported lastAccessed sorts last under *both* time orders:
    // it is unknown, not ancient, and floating unknowns to the head of "oldest"
    // would hand an agent hunting stale tabs a page it knows nothing about. Two
    // unknowns tie, and `sort` is stable, so they keep browser order.
    if (x === undefined || y === undefined) {
      return x === y ? 0 : x === undefined ? 1 : -1;
    }
    return sort === "recent" ? y - x : x - y;
  };
}

/**
 * The `query` and `includeHidden` cut, on its own.
 *
 * Split out of `selectTabs` because `groupBy` needs the same filter but none of
 * the sorting or truncation, and folding it into `selectTabs` meant the grouping
 * path silently skipped it: `tabs_list { query: "x.com", groupBy: "domain" }`
 * counted the whole backlog. Caught against a real 874-tab browser, where the
 * extension was older than Gullet and so did not pre-filter — which is exactly
 * the version skew the second pass exists to cover, so a newer extension would
 * have hidden the bug rather than prevented it. Returns a new array; callers
 * sort it in place.
 */
export function filterTabs(tabs: readonly BridgeTab[], params: TabsListParams): BridgeTab[] {
  const includeHidden = params.includeHidden ?? true;
  const query = params.query?.trim() ?? "";
  return tabs.filter(
    (tab) =>
      (includeHidden || tab.hidden !== true) && (query === "" || matchesTabQuery(tab, query)),
  );
}

/**
 * Filter, sort, and truncate a listing. Pure and shared, because it runs
 * **twice**: in the extension, so a backlog never crosses the socket in full,
 * and again in Gullet over the merged results of every connected browser, where
 * a per-browser limit would not be the limit the agent asked for. Running it
 * again also means an older extension that ignores `query` still yields a
 * filtered answer rather than a flood.
 */
export function selectTabs(tabs: BridgeTab[], params: TabsListParams): TabsListResult {
  const matches = filterTabs(tabs, params);
  matches.sort(compareTabs(params.sort ?? "recent"));
  const limit = params.limit ?? TABS_LIST_DEFAULT_LIMIT;
  const result: TabsListResult = { tabs: matches.slice(0, limit), matched: matches.length };
  if (matches.length > result.tabs.length) result.truncated = true;
  return result;
}

/**
 * Collapse a listing to per-domain counts — the cheap first call of a triage
 * run, which tells an agent what the backlog is made of for a few hundred bytes
 * instead of a few hundred kilobytes, and what to then pass as `query`.
 */
export function groupTabsByDomain(tabs: BridgeTab[], limit: number): TabsListGroupResult {
  const byDomain = new Map<string, TabDomainGroup>();
  for (const tab of tabs) {
    const domain = tabDomain(tab.url);
    let group = byDomain.get(domain);
    if (!group) {
      group = { domain, tabs: 0, discarded: 0 };
      byDomain.set(domain, group);
    }
    group.tabs += 1;
    if (tab.discarded) group.discarded += 1;
    if (tab.lastAccessed !== undefined && tab.lastAccessed > (group.newest ?? -1)) {
      group.newest = tab.lastAccessed;
    }
  }
  const groups = [...byDomain.values()].sort(
    (a, b) => b.tabs - a.tabs || a.domain.localeCompare(b.domain),
  );
  const result: TabsListGroupResult = {
    groups: groups.slice(0, limit),
    domains: groups.length,
    matched: tabs.length,
  };
  if (groups.length > result.groups.length) result.truncated = true;
  return result;
}

/**
 * Ceiling on one `tabs_load` batch. Loading is the one bridge method whose cost
 * is network- and memory-bound rather than IPC-bound: every tab in the batch
 * fetches a page and holds a live document afterwards. A backlog large enough to
 * need this is also large enough that the user runs an auto-discarder, so an
 * agent that asks for 200 at once is asked to chunk instead.
 */
export const TABS_LOAD_MAX_BATCH = 20;

/**
 * Wall-clock budget for one `tabs_load` call, deliberately under
 * BRIDGE_REQUEST_TIMEOUT_MS. A batch that overran the request timeout would be
 * reported to the agent as a plain timeout even though most of its tabs had in
 * fact loaded — the worst outcome available, since the agent would then repeat
 * work the browser already did. Stopping first lets the call answer for every
 * tab, marking the ones it did not reach as pending.
 */
export const TABS_LOAD_DEADLINE_MS = 30_000;

export interface TabsLoadParams {
  tabIds: number[];
}

/**
 * - `ready`: loaded and readable now.
 * - `pending`: still loading, or not reached inside the call's budget. Nothing
 *   went wrong; call again or just try `tab_read`.
 * - `failed`: will not become readable by retrying (gone, or not http(s)).
 */
export type TabLoadStatus = "ready" | "pending" | "failed";

export interface TabLoadOutcome {
  tabId: number;
  status: TabLoadStatus;
  /** The tab's URL as known before the load; absent when the tab is gone. */
  url?: string;
  /** Why it is not ready. Absent exactly when the status is "ready". */
  reason?: string;
}

export interface TabsLoadResult {
  tabs: TabLoadOutcome[];
  ready: number;
  pending: number;
  failed: number;
}

export interface TabReadParams {
  tabId: number;
}

export interface TabReadResult {
  tabId: number;
  title: string;
  url: string;
  author: string;
  published: string;
  description: string;
  site: string;
  wordCount: number;
  markdown: string;
}

export interface TabClipParams {
  tabId: number;
  /** Close the tab once Obsidian has been handed the note. Default false. */
  close?: boolean;
  /**
   * File into this vault instead of the configured one, for this call only.
   * Nothing is persisted — the next clip goes back to settings.
   */
  vault?: string;
}

export interface TabClipResult {
  tabId: number;
  title: string;
  url: string;
  /** Vault-relative note path the clip was filed under. */
  file: string;
  /**
   * Vault the note was handed to. Always reported, so a clip that used an
   * override says so rather than leaving the agent to assume it worked.
   */
  vault: string;
  closed: boolean;
  /** Present when `close` was honoured — pass to `undo_close` to reopen. */
  batchId?: string;
}

export interface TabsCloseParams {
  tabIds: number[];
}

export interface ClosedTabEntry {
  url: string;
  title: string;
  pinned: boolean;
  windowId: number;
  index: number;
  /**
   * Private/incognito tab. Absent on entries written before this was recorded,
   * which are treated as normal — a restore must never move a private URL into
   * a normal window, where it would enter history and sync.
   */
  incognito?: boolean;
}

export interface TabsCloseResult {
  /** Tabs actually closed. Always equals `entries.length` — a close nothing
   * recorded would be a close `undo_close` could not reverse, so it is not made. */
  closed: number;
  /** Hand back to `undo_close` to reopen exactly this batch. */
  batchId: string;
  entries: ClosedTabEntry[];
  /**
   * Requested ids that no longer resolve, so nothing was done about them.
   * Omitted when every id resolved. Usually stale rather than already closed —
   * Chrome renumbers a tab when it discards it.
   */
  missing?: number[];
  /**
   * Requested ids whose tabs are still open: either they had not committed a URL
   * yet, so closing them could not have been undone, or the browser refused the
   * removal. Omitted when empty.
   */
  skipped?: number[];
}

export interface UndoCloseParams {
  /** Omit to undo the most recent batch. */
  batchId?: string;
}

export interface UndoCloseResult {
  batchId: string;
  restored: number;
  failed: number;
}

// --- Parsing ---------------------------------------------------------------

/** Plain-object guard. Shared: both ends narrow untrusted JSON this way. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Every `type` this protocol carries — kept beside the unions it mirrors. */
const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "challenge",
  "hello",
  "hello-ack",
  "hello-error",
  "request",
  "response",
  "ping",
  "pong",
]);

/** Parse a frame into a typed message, or null if it is not one we understand. */
export function parseMessage(raw: string): BridgeMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (!obj || typeof obj.type !== "string") return null;
  return MESSAGE_TYPES.has(obj.type) ? (obj as unknown as BridgeMessage) : null;
}

/** Narrow untrusted `params` for a method, throwing a BridgeError-shaped reason. */
export class BridgeRequestError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeRequestError";
    this.code = code;
  }

  toBridgeError(): BridgeError {
    return { code: this.code, message: this.message };
  }
}

/** Message of an arbitrary throw. Both ends surface these to a model verbatim. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Any throw as a wire error. What an *unexpected* error becomes is part of the
 * shared contract, so it is decided here rather than once per runtime.
 */
export function toBridgeError(err: unknown): BridgeError {
  return err instanceof BridgeRequestError
    ? err.toBridgeError()
    : { code: "internal", message: errorMessage(err) };
}

function badRequest(message: string): never {
  throw new BridgeRequestError("bad-request", message);
}

export function parseTabsListParams(raw: unknown): ResolvedTabsListParams {
  const obj = asRecord(raw) ?? {};
  const scope = obj.scope;
  if (scope !== undefined && scope !== "all" && scope !== "current-window") {
    badRequest(`scope must be "all" or "current-window"`);
  }
  const includeHidden = obj.includeHidden;
  if (includeHidden !== undefined && typeof includeHidden !== "boolean") {
    badRequest("includeHidden must be a boolean");
  }
  const query = obj.query;
  if (query !== undefined && typeof query !== "string") badRequest("query must be a string");
  const sort = obj.sort;
  if (sort !== undefined && sort !== "recent" && sort !== "oldest" && sort !== "window") {
    badRequest(`sort must be "recent", "oldest", or "window"`);
  }
  const groupBy = obj.groupBy;
  if (groupBy !== undefined && groupBy !== "domain") badRequest(`groupBy must be "domain"`);
  const limit = obj.limit;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
      badRequest("limit must be a positive integer");
    }
    if (limit > TABS_LIST_MAX_LIMIT) {
      badRequest(`limit must be at most ${TABS_LIST_MAX_LIMIT}; narrow with query instead`);
    }
  }
  return {
    scope: scope ?? "all",
    includeHidden: includeHidden ?? true,
    sort: sort ?? "recent",
    // The default depends on what is being counted; an explicit limit governs both.
    limit:
      limit ?? (groupBy === "domain" ? TABS_LIST_DEFAULT_GROUP_LIMIT : TABS_LIST_DEFAULT_LIMIT),
    ...(query !== undefined && query.trim() !== "" ? { query: query.trim() } : {}),
    ...(groupBy !== undefined ? { groupBy } : {}),
  };
}

function requireTabId(raw: unknown): number {
  const obj = asRecord(raw);
  const tabId = obj?.tabId;
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    badRequest("tabId must be an integer");
  }
  return tabId;
}

export function parseTabReadParams(raw: unknown): TabReadParams {
  return { tabId: requireTabId(raw) };
}

export function parseTabClipParams(raw: unknown): TabClipParams {
  const obj = asRecord(raw) ?? {};
  if (obj.close !== undefined && typeof obj.close !== "boolean") {
    badRequest("close must be a boolean");
  }
  return { tabId: requireTabId(raw), close: obj.close ?? false, ...parseVaultOverride(obj.vault) };
}

/**
 * A vault override is absent or a usable name — never an empty string.
 *
 * `""` would otherwise reach `obsidianClipRequest`, which appends `&vault=` only
 * for a truthy value, so a blank override would silently mean "whichever vault
 * Obsidian has open" instead of the configured one. Falling back to settings on
 * a blank is the wrong repair too: the agent asked for a specific destination
 * and would be told it got one. Refusing is the only answer that cannot mislead.
 */
function parseVaultOverride(raw: unknown): { vault?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "string") badRequest("vault must be a string");
  const vault = raw.trim();
  if (!vault) badRequest("vault must not be empty — omit it to use the configured vault");
  const warning = vaultWarningFor(vault);
  if (warning) badRequest(warning);
  return { vault };
}

/**
 * Deduplicated tab ids. Deduplicating rather than rejecting matters most for
 * `tabs_close`, where a repeated id would be looked up twice — recording the
 * same tab twice, inflating the `closed` count, and reopening two copies of it
 * on undo — and Chrome rejects the whole `tabs.remove` call on the second one.
 */
function requireTabIds(raw: unknown): number[] {
  const obj = asRecord(raw) ?? {};
  const ids = obj.tabIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "number" || !Number.isInteger(id))) {
    badRequest("tabIds must be an array of integers");
  }
  if (ids.length === 0) badRequest("tabIds must not be empty");
  return [...new Set(ids as number[])];
}

export function parseTabsCloseParams(raw: unknown): TabsCloseParams {
  return { tabIds: requireTabIds(raw) };
}

export function parseTabsLoadParams(raw: unknown): TabsLoadParams {
  const tabIds = requireTabIds(raw);
  // After dedup, so a caller is never told to split a batch that was only
  // oversized because it repeated itself.
  if (tabIds.length > TABS_LOAD_MAX_BATCH) {
    badRequest(
      `tabIds has ${tabIds.length} tabs; load at most ${TABS_LOAD_MAX_BATCH} at a time and call again for the rest`,
    );
  }
  return { tabIds };
}

export function parseUndoCloseParams(raw: unknown): UndoCloseParams {
  const obj = asRecord(raw) ?? {};
  const batchId = obj.batchId;
  if (batchId !== undefined && typeof batchId !== "string") {
    badRequest("batchId must be a string");
  }
  return batchId === undefined ? {} : { batchId };
}
