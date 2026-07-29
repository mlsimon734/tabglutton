// Wire contract for the agent bridge (see BRIDGE.md). Imported by BOTH the
// extension background and the Gullet sidecar, so it must stay pure: no
// `browser.*`, no Bun, no DOM. WebCrypto is the one ambient dependency and is
// present in every runtime that speaks this protocol.
//
// One JSON object per WebSocket frame — the frame is the delimiter, so no
// newline framing is needed on top of it.

export const BRIDGE_PROTO = 1;
export const DEFAULT_BRIDGE_PORT = 4588; // GLUT on a phone keypad

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

export interface BridgeTab {
  id: number;
  title: string;
  url: string;
  /** Epoch ms of last activation; 0 when the browser does not report it. */
  lastAccessed: number;
  /** Unloaded tab — `tab_read`/`tab_clip` cannot run a content script in it. */
  discarded: boolean;
  pinned: boolean;
  active: boolean;
  windowId: number;
  index: number;
  /** Firefox only. On Zen this approximates "belongs to another workspace". */
  hidden?: boolean;
}

export interface TabsListParams {
  /** Default "all": every window. "current-window" narrows to the focused one. */
  scope?: "all" | "current-window";
  /** Firefox: include tabs hidden by another Zen workspace. Default true. */
  includeHidden?: boolean;
}

export interface TabsListResult {
  tabs: BridgeTab[];
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
}

export interface TabClipResult {
  tabId: number;
  title: string;
  url: string;
  /** Vault-relative note path the clip was filed under. */
  file: string;
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

export function parseTabsListParams(raw: unknown): TabsListParams {
  const obj = asRecord(raw) ?? {};
  const scope = obj.scope;
  if (scope !== undefined && scope !== "all" && scope !== "current-window") {
    badRequest(`scope must be "all" or "current-window"`);
  }
  const includeHidden = obj.includeHidden;
  if (includeHidden !== undefined && typeof includeHidden !== "boolean") {
    badRequest("includeHidden must be a boolean");
  }
  return { scope: scope ?? "all", includeHidden: includeHidden ?? true };
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
  return { tabId: requireTabId(raw), close: obj.close ?? false };
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
