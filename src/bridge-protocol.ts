// Wire contract for the agent bridge (see BRIDGE.md). Imported by BOTH the
// extension background and the Gullet sidecar, so it must stay pure: no
// `browser.*`, no Bun, no DOM. WebCrypto is the one ambient dependency and is
// present in every runtime that speaks this protocol.
//
// One JSON object per WebSocket frame — the frame is the delimiter, so no
// newline framing is needed on top of it.

export const BRIDGE_PROTO = 1;
export const DEFAULT_BRIDGE_PORT = 4588; // GLUT on a phone keypad
export const BRIDGE_HEARTBEAT_MS = 20_000;
export const BRIDGE_REQUEST_TIMEOUT_MS = 45_000;
export const BRIDGE_HANDSHAKE_TIMEOUT_MS = 5_000;

export type BridgeBrowser = "firefox" | "chrome";

export type BridgeErrorCode =
  | "unauthorized"
  | "bad-request"
  | "not-found"
  | "tab-discarded"
  | "extract-failed"
  | "vault-missing"
  | "unsupported"
  | "no-connection"
  | "ambiguous-target"
  | "timeout"
  | "internal";

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

export function bridgeError(code: BridgeErrorCode, message: string): BridgeError {
  return { code, message };
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
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Tokens are shown to the user and pasted into a config file — keep them typable. */
export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Methods ---------------------------------------------------------------

export const BRIDGE_METHODS = [
  "tabs_list",
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
}

export interface TabsCloseResult {
  closed: number;
  /** Hand back to `undo_close` to reopen exactly this batch. */
  batchId: string;
  entries: ClosedTabEntry[];
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

export interface BridgeMethodMap {
  tabs_list: { params: TabsListParams; result: TabsListResult };
  tab_read: { params: TabReadParams; result: TabReadResult };
  tab_clip: { params: TabClipParams; result: TabClipResult };
  tabs_close: { params: TabsCloseParams; result: TabsCloseResult };
  undo_close: { params: UndoCloseParams; result: UndoCloseResult };
}

// --- Parsing ---------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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
  switch (obj.type) {
    case "challenge":
    case "hello":
    case "hello-ack":
    case "hello-error":
    case "request":
    case "response":
    case "ping":
    case "pong":
      return obj as unknown as BridgeMessage;
    default:
      return null;
  }
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
  return {
    scope: (scope as TabsListParams["scope"]) ?? "all",
    includeHidden: (includeHidden as boolean | undefined) ?? true,
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
  return { tabId: requireTabId(raw), close: (obj.close as boolean | undefined) ?? false };
}

export function parseTabsCloseParams(raw: unknown): TabsCloseParams {
  const obj = asRecord(raw) ?? {};
  const ids = obj.tabIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "number" || !Number.isInteger(id))) {
    badRequest("tabIds must be an array of integers");
  }
  if (ids.length === 0) badRequest("tabIds must not be empty");
  return { tabIds: ids as number[] };
}

export function parseUndoCloseParams(raw: unknown): UndoCloseParams {
  const obj = asRecord(raw) ?? {};
  const batchId = obj.batchId;
  if (batchId !== undefined && typeof batchId !== "string") {
    badRequest("batchId must be a string");
  }
  return batchId === undefined ? {} : { batchId: batchId as string };
}
