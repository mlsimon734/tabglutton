// The browser-facing half of Gullet: a loopback WebSocket server that browsers
// dial in to, plus request routing on top of the connections they establish.
//
// Security posture (BRIDGE.md): bound to 127.0.0.1 only, upgrade requests must
// carry an extension origin, and both ends prove knowledge of the shared token
// against a nonce the other side chose before any method is served.

import {
  BRIDGE_HANDSHAKE_TIMEOUT_MS,
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_PROTO,
  BRIDGE_REQUEST_TIMEOUT_MS,
  BridgeRequestError,
  deriveProof,
  parseMessage,
  proofsMatch,
  randomNonce,
  toBridgeError,
  type BridgeMethod,
  type HelloMessage,
  type ServerMessage,
} from "../../src/bridge-protocol.js";
import {
  parsePeerMessage,
  type PeerRequestMessage,
  type PeerResponseMessage,
} from "./peer-protocol.js";
import type { ConnectionSummary } from "./select.js";

const EXTENSION_ORIGIN_PREFIXES = ["moz-extension://", "chrome-extension://"];

export function isExtensionOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return EXTENSION_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix));
}

interface SocketData {
  connectionId: string;
  serverNonce: string;
  /** Reaper for a socket that opens and then never proves the token. */
  handshakeTimer?: ReturnType<typeof setTimeout>;
}

/** Sidecar attached to this hub, proxying its MCP session through us. */
interface Peer {
  socket: Bun.ServerWebSocket<SocketData>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection extends ConnectionSummary {
  socket: Bun.ServerWebSocket<SocketData>;
  pending: Map<string, PendingRequest>;
  awaitingPong: boolean;
}

export interface HubOptions {
  port: number;
  token: string;
  onConnectionsChanged?: (summaries: ConnectionSummary[]) => void;
  /** Overridable so tests need not wait out the real deadline. */
  handshakeTimeoutMs?: number;
}

/**
 * How long a peer's `connections` request may wait for a browser. The peer
 * inherits the hub's wait rather than running its own, so it must not be so long
 * that the peer's request timeout fires first and reports a timeout for what is
 * really "still waiting". Kept under BRIDGE_REQUEST_TIMEOUT_MS.
 */
const PEER_CONNECT_WAIT_MS = 35_000;

export class Hub {
  private readonly options: HubOptions;
  private readonly connections = new Map<string, Connection>();
  /** Attached sidecars, keyed like connections but deliberately kept apart: a
   * peer is never a target for a bridge method, only a source of them. */
  private readonly peers = new Map<string, Peer>();
  private server: Bun.Server<SocketData> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly connectWaiters = new Set<() => void>();
  private nextId = 1;

  constructor(options: HubOptions) {
    this.options = options;
  }

  listen(): void {
    this.server = Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: this.options.port,
      fetch: (req, server) => {
        // The realistic attacker is a hostile page inside the user's browser
        // opening ws://127.0.0.1:4588. Pages cannot forge an extension Origin.
        const origin = req.headers.get("origin");
        if (!isExtensionOrigin(origin)) {
          // Logged, not silent: an extension that cannot connect looks exactly
          // like one that never tried, and that is miserable to debug.
          console.error(`[gullet] refused upgrade from origin ${origin ?? "(none)"}`);
          return new Response("Forbidden", { status: 403 });
        }
        const data: SocketData = {
          connectionId: `conn-${this.nextId++}`,
          serverNonce: randomNonce(),
        };
        if (server.upgrade(req, { data })) return undefined;
        return new Response("Gullet expects a WebSocket upgrade.", { status: 426 });
      },
      websocket: {
        open: (ws) => this.onOpen(ws),
        message: (ws, message) => void this.onMessage(ws, message),
        close: (ws) => this.onClose(ws),
      },
    });
    this.heartbeat = setInterval(() => this.pingAll(), BRIDGE_HEARTBEAT_MS);
  }

  stop(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    // Release anyone mid-wait; nothing will ever connect now, and a pending
    // timer would keep the process alive past the shutdown that triggered this.
    this.releaseConnectWaiters();
    for (const conn of this.connections.values()) {
      this.rejectPending(conn, "Gullet is shutting down.");
      conn.socket.close();
    }
    this.connections.clear();
    // Dropping these is how attached sidecars learn the hub is gone and start
    // re-electing one of themselves; nothing else tells them.
    for (const peer of this.peers.values()) peer.socket.close();
    this.peers.clear();
    this.server?.stop(true);
    this.server = null;
  }

  get port(): number {
    return this.server?.port ?? this.options.port;
  }

  summaries(): ConnectionSummary[] {
    return [...this.connections.values()].map(({ connectionId, browser, label, extVersion }) => ({
      connectionId,
      browser,
      label,
      extVersion,
    }));
  }

  /**
   * Connected browsers, waiting up to `timeoutMs` for a first one to arrive.
   *
   * The extension is not continuously connected and cannot be: its background
   * page is an event page that the browser suspends when idle, which destroys
   * the socket, and it only redials when its alarm fires. So "nothing connected
   * right now" is the normal resting state between agent sessions, not a fault,
   * and a tool call that reports it as one is wrong more often than it is right.
   * Waiting one reconnect period turns that into a slow first call instead of a
   * spurious failure. Returns whatever is connected when the wait ends, which
   * may still be nothing — the caller decides what an empty list means.
   */
  async connectionsWithin(timeoutMs: number): Promise<ConnectionSummary[]> {
    if (this.connections.size === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.connectWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        this.connectWaiters.add(done);
      });
    }
    return this.summaries();
  }

  /** Each callback removes itself, which Set iteration handles — no copy needed. */
  private releaseConnectWaiters(): void {
    for (const done of this.connectWaiters) done();
  }

  /** Send one bridge method to one browser and await its answer. */
  request(connectionId: string, method: BridgeMethod, params: unknown): Promise<unknown> {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      return Promise.reject(
        new BridgeRequestError("no-connection", `Connection ${connectionId} is gone.`),
      );
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(
          new BridgeRequestError(
            "timeout",
            `${method} timed out after ${BRIDGE_REQUEST_TIMEOUT_MS}ms.`,
          ),
        );
      }, BRIDGE_REQUEST_TIMEOUT_MS);
      conn.pending.set(id, { resolve, reject, timer });
      this.send(conn.socket, { type: "request", id, method, params });
    });
  }

  private onOpen(ws: Bun.ServerWebSocket<SocketData>): void {
    // Unauthenticated sockets are not tracked: `connections` only gains an entry
    // once the handshake passes, and Bun owns the socket until then. Untracked
    // is not the same as bounded, though — a local process that opens sockets
    // and never answers the challenge would otherwise accumulate them for the
    // life of the sidecar, so each gets a deadline to prove the token in.
    ws.data.handshakeTimer = setTimeout(() => {
      console.error(`[gullet] closing ${ws.data.connectionId}: no handshake`);
      ws.close();
    }, this.options.handshakeTimeoutMs ?? BRIDGE_HANDSHAKE_TIMEOUT_MS);
    this.send(ws, {
      type: "challenge",
      proto: BRIDGE_PROTO,
      server: "gullet",
      nonce: ws.data.serverNonce,
    });
  }

  /** Disarm the reaper — the socket has either proved the token or gone away. */
  private clearHandshakeTimer(ws: Bun.ServerWebSocket<SocketData>): void {
    if (ws.data.handshakeTimer === undefined) return;
    clearTimeout(ws.data.handshakeTimer);
    ws.data.handshakeTimer = undefined;
  }

  private async onMessage(
    ws: Bun.ServerWebSocket<SocketData>,
    raw: string | Buffer,
  ): Promise<void> {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");

    // Role is settled at handshake and never mixes afterwards, so a peer's
    // frames go to the peer parser and a browser's to the shared one.
    if (this.peers.has(ws.data.connectionId)) {
      const peerMsg = parsePeerMessage(text);
      if (peerMsg?.type === "peer-request") await this.servePeer(ws, peerMsg);
      return;
    }

    const msg = parseMessage(text);
    if (!msg) return;
    const conn = this.connections.get(ws.data.connectionId);

    if (!conn) {
      if (msg.type !== "hello") return;
      await this.completeHandshake(ws, msg);
      return;
    }

    switch (msg.type) {
      case "response": {
        const pending = conn.pending.get(msg.id);
        if (!pending) return;
        conn.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new BridgeRequestError(msg.error.code, msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
        return;
      }
      case "ping":
        this.send(ws, { type: "pong", t: msg.t });
        return;
      case "pong":
        conn.awaitingPong = false;
        return;
      default:
        return;
    }
  }

  private async completeHandshake(
    ws: Bun.ServerWebSocket<SocketData>,
    msg: HelloMessage,
  ): Promise<void> {
    if (msg.proto !== BRIDGE_PROTO) {
      this.rejectHandshake(
        ws,
        "unsupported",
        `Extension speaks protocol ${msg.proto}; this Gullet speaks ${BRIDGE_PROTO}. Update whichever is older.`,
      );
      return;
    }
    if (!this.options.token) {
      this.rejectHandshake(
        ws,
        "unauthorized",
        "Tabglutton's bridge has no token configured. Set TABGLUTTON_TOKEN to the value from Tabglutton's settings.",
      );
      return;
    }
    const expected = await deriveProof(this.options.token, ws.data.serverNonce);
    if (typeof msg.proof !== "string" || !proofsMatch(msg.proof, expected)) {
      this.rejectHandshake(ws, "unauthorized", "Token mismatch.");
      return;
    }

    this.clearHandshakeTimer(ws);

    if (msg.role === "peer") {
      // A peer has proved the token, which is the whole check: it is another
      // Gullet on this machine, and it gets exactly what our own MCP half gets.
      this.peers.set(ws.data.connectionId, { socket: ws });
      this.send(ws, {
        type: "hello-ack",
        proto: BRIDGE_PROTO,
        connectionId: ws.data.connectionId,
        proof: await deriveProof(this.options.token, msg.nonce),
      });
      console.error(`[gullet] peer sidecar attached (${ws.data.connectionId})`);
      return;
    }

    const conn: Connection = {
      connectionId: ws.data.connectionId,
      browser: msg.browser === "chrome" ? "chrome" : "firefox",
      label: typeof msg.label === "string" && msg.label ? msg.label : msg.browser,
      extVersion: typeof msg.extVersion === "string" ? msg.extVersion : "unknown",
      socket: ws,
      pending: new Map(),
      awaitingPong: false,
    };
    this.connections.set(conn.connectionId, conn);
    this.send(ws, {
      type: "hello-ack",
      proto: BRIDGE_PROTO,
      connectionId: conn.connectionId,
      // Prove we know the token too, against the nonce the extension chose.
      proof: await deriveProof(this.options.token, msg.nonce),
    });
    console.error(`[gullet] ${conn.label} connected (${conn.connectionId}, v${conn.extVersion})`);
    // Only once the handshake passes: a socket that cannot prove the token is
    // not a browser we can serve, so releasing waiters on `open` would hand
    // them an empty list and waste the wait.
    this.releaseConnectWaiters();
    this.options.onConnectionsChanged?.(this.summaries());
  }

  private rejectHandshake(
    ws: Bun.ServerWebSocket<SocketData>,
    code: "unauthorized" | "unsupported",
    message: string,
  ): void {
    console.error(`[gullet] handshake rejected: ${message}`);
    this.send(ws, { type: "hello-error", error: { code, message } });
    ws.close();
  }

  private onClose(ws: Bun.ServerWebSocket<SocketData>): void {
    this.clearHandshakeTimer(ws);
    if (this.peers.delete(ws.data.connectionId)) {
      console.error(`[gullet] peer sidecar detached (${ws.data.connectionId})`);
      return;
    }
    const conn = this.connections.get(ws.data.connectionId);
    if (!conn) return;
    this.connections.delete(conn.connectionId);
    this.rejectPending(conn, `${conn.label} disconnected mid-request.`);
    console.error(`[gullet] ${conn.label} disconnected (${conn.connectionId})`);
    this.options.onConnectionsChanged?.(this.summaries());
  }

  // Guards against half-open sockets the OS has not torn down yet: a browser
  // that misses two beats is dropped so the agent gets "no connection" rather
  // than a request that hangs until the 45s timeout.
  private pingAll(): void {
    for (const conn of this.connections.values()) {
      if (conn.awaitingPong) {
        console.error(`[gullet] ${conn.label} missed heartbeat; dropping`);
        conn.socket.close();
        continue;
      }
      conn.awaitingPong = true;
      this.send(conn.socket, { type: "ping", t: Date.now() });
    }
  }

  /**
   * Answer one attached sidecar. Its two operations are exactly what this hub's
   * own MCP half calls, so a peer is served through the same paths rather than a
   * parallel set — there is no behaviour a peer can reach that the hub's own
   * session cannot, and none it misses.
   */
  private async servePeer(
    ws: Bun.ServerWebSocket<SocketData>,
    msg: PeerRequestMessage,
  ): Promise<void> {
    try {
      const result =
        msg.op === "connections"
          ? await this.connectionsWithin(PEER_CONNECT_WAIT_MS)
          : await this.requestFromPeer(msg);
      this.sendPeer(ws, { type: "peer-response", id: msg.id, result });
    } catch (err) {
      this.sendPeer(ws, { type: "peer-response", id: msg.id, error: toBridgeError(err) });
    }
  }

  private requestFromPeer(msg: PeerRequestMessage): Promise<unknown> {
    if (!msg.connectionId || !msg.method) {
      return Promise.reject(
        new BridgeRequestError("bad-request", "peer call needs a connectionId and a method."),
      );
    }
    return this.request(msg.connectionId, msg.method, msg.params);
  }

  private send(ws: Bun.ServerWebSocket<SocketData>, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private sendPeer(ws: Bun.ServerWebSocket<SocketData>, msg: PeerResponseMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  /** Nothing in flight may outlive its connection — every exit path funnels here. */
  private rejectPending(conn: Connection, message: string): void {
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeRequestError("no-connection", message));
    }
    conn.pending.clear();
  }
}
