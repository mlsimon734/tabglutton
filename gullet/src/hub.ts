// The browser-facing half of Gullet: a loopback WebSocket server that browsers
// dial in to, plus request routing on top of the connections they establish.
//
// Security posture (BRIDGE.md): bound to 127.0.0.1 only, upgrade requests must
// carry an extension origin, and both ends prove knowledge of the shared token
// against a nonce the other side chose before any method is served.

import {
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_PROTO,
  BRIDGE_REQUEST_TIMEOUT_MS,
  BridgeRequestError,
  deriveProof,
  parseMessage,
  proofsMatch,
  randomNonce,
  type BridgeMethod,
  type HelloMessage,
  type ServerMessage,
} from "../../src/bridge-protocol.js";
import type { ConnectionSummary } from "./select.js";

const EXTENSION_ORIGIN_PREFIXES = ["moz-extension://", "chrome-extension://"];

export function isExtensionOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return EXTENSION_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix));
}

interface SocketData {
  connectionId: string;
  serverNonce: string;
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
}

export class Hub {
  private readonly options: HubOptions;
  private readonly connections = new Map<string, Connection>();
  private server: Bun.Server<SocketData> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
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
    for (const conn of this.connections.values()) {
      this.rejectPending(conn, "Gullet is shutting down.");
      conn.socket.close();
    }
    this.connections.clear();
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
    // once the handshake passes, and Bun owns the socket until then.
    this.send(ws, {
      type: "challenge",
      proto: BRIDGE_PROTO,
      server: "gullet",
      nonce: ws.data.serverNonce,
    });
  }

  private async onMessage(
    ws: Bun.ServerWebSocket<SocketData>,
    raw: string | Buffer,
  ): Promise<void> {
    const msg = parseMessage(typeof raw === "string" ? raw : raw.toString("utf8"));
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
        "Gullet has no token configured. Set GULLET_TOKEN to the value from Tabglutton's settings.",
      );
      return;
    }
    const expected = await deriveProof(this.options.token, ws.data.serverNonce);
    if (typeof msg.proof !== "string" || !proofsMatch(msg.proof, expected)) {
      this.rejectHandshake(ws, "unauthorized", "Token mismatch.");
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

  private send(ws: Bun.ServerWebSocket<SocketData>, msg: ServerMessage): void {
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
