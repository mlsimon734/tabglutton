// The sidecar-to-sidecar half of the bridge. Only Gullet processes speak this.
//
// Why it exists: nothing guarantees one Gullet per agent session. Every MCP
// client spawns its own, and at least one (Codex, observed) spawns two for a
// single session — so "whoever binds the port owns the browser" strands every
// other sidecar, including a client's own second instance. Instead the process
// that binds becomes the *hub*, and later ones attach to it as peers and proxy
// their MCP calls through. The browser still sees exactly one connection.
//
// Deliberately not in `src/bridge-protocol.ts`: that file is the contract the
// extension is typechecked against, and the extension neither sends nor receives
// any of this. The single shared change is the optional `role` on the hello.

import { asRecord, type BridgeError, type BridgeMethod } from "../../src/bridge-protocol.js";

/**
 * Peer → hub. `connections` asks what browsers the hub can see (and inherits the
 * hub's wait for one to arrive); `call` forwards one bridge method to one of
 * them. Peers never address the browser directly — they have no socket to it.
 */
export interface PeerRequestMessage {
  type: "peer-request";
  id: string;
  op: "connections" | "call";
  connectionId?: string;
  method?: BridgeMethod;
  params?: unknown;
}

export interface PeerResponseMessage {
  type: "peer-response";
  id: string;
  result?: unknown;
  error?: BridgeError;
}

export type PeerMessage = PeerRequestMessage | PeerResponseMessage;

const PEER_TYPES: ReadonlySet<string> = new Set(["peer-request", "peer-response"]);

/**
 * Parse a frame from a socket already known to be a peer. Separate from the
 * shared `parseMessage` so the browser-facing parser cannot be handed a peer
 * frame, or the reverse — the two roles are decided at handshake and never mix.
 */
export function parsePeerMessage(raw: string): PeerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (!obj || typeof obj.type !== "string" || !PEER_TYPES.has(obj.type)) return null;
  if (typeof obj.id !== "string") return null;
  return obj as unknown as PeerMessage;
}
