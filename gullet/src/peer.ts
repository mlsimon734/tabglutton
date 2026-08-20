// A Gullet that lost the race for the port, attached to the one that won.
//
// It has no socket to the browser and never will; every tool call it serves is
// forwarded to the hub and the answer relayed back. From the MCP client's side
// this is indistinguishable from being the hub, which is the point — an agent
// session should not care whether it happened to start first.

import {
  BRIDGE_CONNECT_WAIT_MS,
  BRIDGE_HANDSHAKE_TIMEOUT_MS,
  BRIDGE_PROTO,
  BRIDGE_REQUEST_TIMEOUT_MS,
  BridgeRequestError,
  deriveProof,
  errorMessage,
  parseMessage,
  proofsMatch,
  randomNonce,
  type BridgeMethod,
} from "../../src/bridge-protocol.js";
import { parsePeerMessage, type PeerRequestMessage } from "./peer-protocol.js";
import type { ConnectionSummary } from "./select.js";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A peer RPC's deadline sits *outside* the hub's own budget for that operation,
 * plus slack for a busy hub's event loop. The hub legitimately holds
 * `connections` for up to BRIDGE_CONNECT_WAIT_MS waiting for a browser to dial
 * in, and a `call` for up to BRIDGE_REQUEST_TIMEOUT_MS waiting for the browser
 * to answer — an outer timer at exactly the inner number fires while the hub is
 * still within its rights, converting "still waiting" into a spurious "Hub did
 * not answer". This timer exists only to catch a hub that has genuinely gone
 * silent; the inner deadlines are the real budget, and the hub's own timeout
 * error is the more useful answer, so ours must always lose that race.
 */
const PEER_RPC_SLACK_MS = 5_000;

function peerDeadlineMs(op: PeerRequestMessage["op"]): number {
  return (
    (op === "connections" ? BRIDGE_CONNECT_WAIT_MS : BRIDGE_REQUEST_TIMEOUT_MS) + PEER_RPC_SLACK_MS
  );
}

export interface PeerOptions {
  port: number;
  token: string;
  /**
   * Our own version, offered so a hub older than us can stand aside rather than
   * serve stale code — see `gullet` on the hello and `shouldRetireFor` in hub.ts.
   */
  version: string;
  /**
   * `"probe"` completes the same mutual proof and is then done: it answers "is
   * this hub in my token realm?" without being counted as a session. Used by the
   * detached hub's own election, which must be able to ask that question without
   * flapping the browser's keepalive entitlement or resetting a hub's idle clock.
   */
  role?: "peer" | "probe";
  /** The hub went away. The supervisor uses this to start a re-election. */
  onLost: () => void;
}

export class PeerClient {
  private readonly options: PeerOptions;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private clientNonce = "";
  private lost = false;

  constructor(options: PeerOptions) {
    this.options = options;
  }

  /**
   * Dial the hub and complete the handshake. Rejects if the hub does not answer
   * — the caller treats that as "no hub after all" and re-races for the port,
   * which is exactly the state right after a hub exits.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("hub did not complete the handshake")),
        BRIDGE_HANDSHAKE_TIMEOUT_MS,
      );

      let socket: WebSocket;
      try {
        socket = new WebSocket(`ws://127.0.0.1:${this.options.port}/`, {
          // The hub only upgrades extension origins — the check that keeps a web
          // page from opening this socket. A peer is not a page and cannot be
          // one, so it presents an extension origin to pass the same gate.
          headers: { Origin: "moz-extension://gullet-peer" },
        });
      } catch (err) {
        finish(err);
        return;
      }
      this.socket = socket;

      socket.addEventListener("message", (event) => {
        void this.onMessage(String(event.data), finish);
      });
      socket.addEventListener("error", () => finish(new Error("hub connection failed")));
      socket.addEventListener("close", () => {
        finish(new Error("hub closed the connection"));
        this.onClose();
      });
    });
  }

  private async onMessage(text: string, finish: (err?: unknown) => void): Promise<void> {
    // Handshake frames use the shared parser; everything after is peer traffic.
    const peerMsg = parsePeerMessage(text);
    if (peerMsg?.type === "peer-response") {
      const waiting = this.pending.get(peerMsg.id);
      if (!waiting) return;
      this.pending.delete(peerMsg.id);
      clearTimeout(waiting.timer);
      if (peerMsg.error) {
        waiting.reject(new BridgeRequestError(peerMsg.error.code, peerMsg.error.message));
      } else {
        waiting.resolve(peerMsg.result);
      }
      return;
    }

    const msg = parseMessage(text);
    if (!msg) return;
    switch (msg.type) {
      case "challenge": {
        // Off the wire, and about to be hashed: a non-string nonce would hash
        // material the hub never produced, so the failure belongs here where it
        // can be named rather than three frames later as "token mismatch".
        if (typeof msg.nonce !== "string") {
          finish(new Error("hub sent a malformed challenge"));
          this.socket?.close();
          return;
        }
        const role = this.options.role ?? "peer";
        this.clientNonce = randomNonce();
        this.send({
          type: "hello",
          proto: BRIDGE_PROTO,
          // Unused by the hub for a peer, but the field is not optional.
          browser: "firefox",
          extVersion: "peer",
          label: "peer",
          role,
          gullet: this.options.version,
          nonce: this.clientNonce,
          // Bound to the role above and to the port we dialled. A squatter that
          // forwards this to the real hub is presenting a proof that names *its*
          // port, which is not the port the hub checks against.
          proof: await deriveProof(this.options.token, msg.nonce, role, this.options.port),
        });
        return;
      }
      case "hello-ack": {
        const expected = await deriveProof(
          this.options.token,
          this.clientNonce,
          "server",
          this.options.port,
        );
        // The hub proves the token back, same as it does to a browser: a process
        // squatting the port must not be able to collect our tool traffic.
        if (typeof msg.proof !== "string" || !proofsMatch(msg.proof, expected)) {
          finish(new Error("hub failed the token challenge"));
          this.socket?.close();
          return;
        }
        finish();
        return;
      }
      case "hello-error":
        finish(new Error(msg.error.message));
        return;
      default:
        return;
    }
  }

  connections(): Promise<ConnectionSummary[]> {
    return this.call({ op: "connections" }) as Promise<ConnectionSummary[]>;
  }

  request(connectionId: string, method: BridgeMethod, params: unknown): Promise<unknown> {
    return this.call({ op: "call", connectionId, method, params });
  }

  private call(body: Omit<PeerRequestMessage, "type" | "id">): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeRequestError("no-connection", "The hub sidecar is gone."));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeRequestError("timeout", `Hub did not answer ${body.op}.`));
      }, peerDeadlineMs(body.op));
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type: "peer-request", id, ...body }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BridgeRequestError("no-connection", errorMessage(err)));
      }
    });
  }

  private send(msg: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  /** Nothing in flight may outlive the connection — both exit paths funnel here. */
  private rejectPending(message: string): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new BridgeRequestError("no-connection", message));
    }
    this.pending.clear();
  }

  private onClose(): void {
    if (this.lost) return;
    this.lost = true;
    this.rejectPending("The hub sidecar went away.");
    this.options.onLost();
  }

  // Sets `lost` before closing so the socket's close event cannot reach
  // onClose's onLost() and start a re-election during a deliberate shutdown.
  stop(): void {
    this.lost = true;
    this.rejectPending("This sidecar is shutting down.");
    this.socket?.close();
    this.socket = null;
  }
}
