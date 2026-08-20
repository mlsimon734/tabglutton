// The browser-facing half of Gullet: a loopback WebSocket server that browsers
// dial in to, plus request routing on top of the connections they establish.
//
// Security posture (docs/BRIDGE.md): bound to 127.0.0.1 only, upgrade requests must
// carry an extension origin, and both ends prove knowledge of the shared token
// against a nonce the other side chose before any method is served.

import {
  BRIDGE_CONNECT_WAIT_MS,
  BRIDGE_HANDSHAKE_TIMEOUT_MS,
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_IDLE_HEARTBEAT_MS,
  BRIDGE_PROBE_HEADER,
  BRIDGE_PROBE_BODY_PREFIX,
  BRIDGE_PROTO,
  BRIDGE_REQUEST_TIMEOUT_MS,
  BridgeRequestError,
  compareGulletVersions,
  deriveProof,
  errorMessage,
  parseMessage,
  proofsMatch,
  randomNonce,
  RETIRING_FOR_NEWER_PEER,
  toBridgeError,
  type BridgeMethod,
  type HelloMessage,
  type ProofRole,
  type ServerMessage,
} from "../../src/bridge-protocol.js";
import {
  parsePeerMessage,
  type PeerRequestMessage,
  type PeerResponseMessage,
} from "./peer-protocol.js";
import type { ConnectionSummary } from "./select.js";

const EXTENSION_ORIGIN_PREFIXES = ["moz-extension://", "chrome-extension://"];

/**
 * How long a connection has to answer the ping fired when a session attaches,
 * before it is treated as the half-open socket it probably is. A loopback pong
 * returns in microseconds; this is slack for a busy event loop on either end,
 * not a budget anything legitimately spends.
 */
const IDLE_CONNECTION_GRACE_MS = 2_000;

/**
 * How long a line that an *unproved* caller can cause stays quiet after one is
 * written, and how much of an offending header such a line may carry.
 *
 * A detached hub's stderr is a file (`hub.log`) that the README calls "small by
 * construction". That is only true if every line reachable before the token is
 * proved is bounded in both size and rate. Measured on Bun 1.3.14: a 15 KB
 * `Origin` reached the refused-upgrade line verbatim and one loopback client
 * sustained ~480 MB/s of it.
 *
 * There are two such lines, not one, and missing the second is how this nearly
 * shipped half-fixed: the refused-upgrade line, and every `hello-error` before
 * authentication — which a local process reaches simply by presenting any
 * extension Origin, and whose protocol-mismatch text interpolates a field off
 * the wire. Both go through `logUnauthenticated`, in separate buckets so a flood
 * of one cannot hide the other. Post-proof rejections (retirement) are not
 * throttled: reaching one means holding the token.
 */
const UNAUTHENTICATED_LOG_INTERVAL_MS = 60_000;
const REFUSED_ORIGIN_MAX_CHARS = 120;

export function isExtensionOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return EXTENSION_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix));
}

/**
 * The proof role a hello is claiming. An absent `role` is the extension, which
 * has never sent one; anything unrecognised is normalised to `"browser"` rather
 * than rejected, and then simply fails the proof check — an unknown role is not
 * a caller we can serve either way, and one refusal path is easier to reason
 * about than two.
 */
function helloProofRole(role: HelloMessage["role"]): ProofRole {
  return role === "peer" || role === "probe" ? role : "browser";
}

/**
 * A hello's claimed protocol, safe to put in a message that reaches `hub.log`.
 *
 * `parseMessage` narrows `type` and nothing else, so this is whatever JSON
 * arrived. A number is the only shape worth repeating back; anything else is
 * named by its type rather than its value, because the value is unbounded
 * attacker input and this line is logged before anyone has proved anything.
 */
function describeProto(proto: unknown): string {
  return typeof proto === "number" && Number.isFinite(proto)
    ? String(proto)
    : `a non-numeric value`;
}

/**
 * Every non-upgrade reply says who answered. Without it the extension's probe
 * could tell "a server responded" but not "*Gullet* responded", and a stranger
 * on this port was indistinguishable from the sidecar.
 *
 * Deliberately no `Access-Control-Allow-Origin`: the marker is for the
 * extension, which reads it under `host_permissions`, and a web page must stay
 * unable to read either the header or the body.
 */
export function identifyingResponse(message: string, status: number): Response {
  return new Response(`${BRIDGE_PROBE_BODY_PREFIX}\n${message}\n`, {
    status,
    headers: { [BRIDGE_PROBE_HEADER]: String(BRIDGE_PROTO) },
  });
}

interface SocketData {
  connectionId: string;
  serverNonce: string;
  /** Reaper for a socket that opens and then never proves the token. */
  handshakeTimer?: ReturnType<typeof setTimeout>;
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
  /** Overridable so tests need not wait out the real deadline. */
  handshakeTimeoutMs?: number;
  /**
   * This hub has no MCP session of its own — it was spawned to outlive them.
   *
   * The only thing it changes is arithmetic: a session-scoped hub serves its own
   * agent and therefore always counts one session, while a detached one counts
   * nothing until a peer attaches. That number is what the extension spends its
   * keepalive against, so getting it wrong either pins a browser awake forever
   * or lets it suspend mid-session.
   */
  detached?: boolean;
  /** This hub's own version, offered to peers deciding whether it should retire. */
  version?: string;
  /** Sessions crossed into or out of zero. The detached runner's idle clock. */
  onSessionsChange?: (count: number) => void;
  /** A newer peer asked us to stand aside; the runner exits on this. */
  onRetire?: () => void;
}

export class Hub {
  private readonly options: HubOptions;
  private readonly connections = new Map<string, Connection>();
  /** Attached sidecar sockets, keyed like connections but deliberately kept
   * apart: a peer is never a target for a bridge method, only a source of them. */
  private readonly peers = new Map<string, Bun.ServerWebSocket<SocketData>>();
  private server: Bun.Server<SocketData> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Cadence the running heartbeat was armed at, so it is only ever re-armed on a change. */
  private heartbeatMs = 0;
  /** One-shot verdict on connections held through an idle spell; see syncHeartbeat. */
  private staleSweep: ReturnType<typeof setTimeout> | null = null;
  private readonly connectWaiters = new Set<() => void>();
  private nextId = 1;
  private retiring = false;
  /** Rate state per bucket for the lines an unproved caller can drive. */
  private readonly unauthLog = new Map<string, { at: number; suppressed: number }>();

  constructor(options: HubOptions) {
    this.options = options;
  }

  listen(): void {
    this.server = Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: this.options.port,
      fetch: (req, server) => {
        // The realistic attacker is a hostile page inside the user's browser
        // opening ws://127.0.0.1:4589. Pages cannot forge an extension Origin.
        const origin = req.headers.get("origin");
        if (!isExtensionOrigin(origin)) {
          // A GET with no Origin at all is the extension's own probe (or a
          // curl), not an attempt at anything — logging it at error every
          // IDLE_PROBE_MS would bury the case worth seeing, which is a real
          // foreign origin. Both still get refused; only the volume differs.
          if (origin !== null) this.logRefusedOrigin(origin);
          return identifyingResponse("Forbidden", 403);
        }
        const data: SocketData = {
          connectionId: `conn-${this.nextId++}`,
          serverNonce: randomNonce(),
        };
        if (server.upgrade(req, { data })) return undefined;
        return identifyingResponse("Gullet expects a WebSocket upgrade.", 426);
      },
      websocket: {
        open: (ws) => this.onOpen(ws),
        // A throw out of the handler used to be an unhandled rejection *and* a
        // leaked socket: `completeHandshake` disarms the reaper before it is
        // finished, so a frame that failed after that point left a connection
        // nothing would ever close. The frame is untrusted JSON and the parser
        // narrows only `type`, so the guarantee has to be structural — every
        // path out of a socket ends with the socket closed.
        message: (ws, message) =>
          void this.onMessage(ws, message).catch((err) => {
            console.error(`[gullet] dropping ${ws.data.connectionId}: ${errorMessage(err)}`);
            ws.close();
          }),
        close: (ws) => this.onClose(ws),
      },
    });
    this.syncHeartbeat();
  }

  stop(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.heartbeatMs = 0;
    if (this.staleSweep !== null) clearTimeout(this.staleSweep);
    this.staleSweep = null;
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
    for (const peer of this.peers.values()) peer.close();
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
   * Agent sessions this hub serves: its attached peers, plus its own MCP half
   * unless it was spawned without one. This is the number the extension spends
   * its keepalive against — see SessionsMessage in bridge-protocol.
   */
  get sessions(): number {
    return this.peers.size + (this.options.detached ? 0 : 1);
  }

  /**
   * Announce the session count and re-pace the heartbeat to match it.
   *
   * Called on every peer arrival and departure rather than only on the crossing
   * of zero: the message is a handful of bytes on an already-open loopback
   * socket, and a browser that reconnects mid-session must be able to learn the
   * count from its hello-ack alone, which means the count has to be right at all
   * times rather than merely at the edges.
   */
  private publishSessions(): void {
    const count = this.sessions;
    for (const conn of this.connections.values()) {
      this.send(conn.socket, { type: "sessions", count });
    }
    // The roster, at the one moment someone is there to read it. Idle churn is
    // deliberately silent (see completeHandshake), which would otherwise leave a
    // log that says nothing at all about whether a browser is reachable — the
    // first thing anyone diagnosing this hub wants to know.
    if (count === 1) {
      const roster = this.summaries().map((c) => `${c.label} (${c.connectionId})`);
      console.error(`[gullet] browsers connected: ${roster.join(", ") || "none"}`);
    }
    this.syncHeartbeat();
    this.options.onSessionsChange?.(count);
  }

  /**
   * Fast beat while a session is attached, slow beat while none is — see
   * BRIDGE_IDLE_HEARTBEAT_MS. Re-arming an interval restarts its countdown, so
   * this returns early unless the cadence actually changed; without that guard
   * a hub with several peers coming and going would keep pushing the next beat
   * away and never send one.
   */
  private syncHeartbeat(): void {
    if (this.server === null) return;
    const wanted = this.sessions > 0 ? BRIDGE_HEARTBEAT_MS : BRIDGE_IDLE_HEARTBEAT_MS;
    if (this.heartbeat !== null && this.heartbeatMs === wanted) return;
    const speedingUp = this.heartbeat !== null && wanted < this.heartbeatMs;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeatMs = wanted;
    this.heartbeat = setInterval(() => this.pingAll(), wanted);
    // Speeding up means a session just attached, and the connections we are
    // holding were last checked up to BRIDGE_IDLE_HEARTBEAT_MS ago. Waiting a
    // further beat to find out one of them is dead would spend that session's
    // first call on a request that can only time out, so ask now.
    //
    // A fresh ask, not a verdict: `awaitingPong` is cleared first because a slow
    // beat may have gone out microseconds ago with its pong still in flight, and
    // dropping a healthy browser over that would be this fix causing the outage
    // it exists to prevent. The next beat is what judges the answer.
    if (speedingUp) {
      for (const conn of this.connections.values()) conn.awaitingPong = false;
      this.pingAll();
      // And judge the answer well before the next beat. A connection last
      // checked up to five minutes ago may be half-open — a slept laptop is the
      // realistic case, where no FIN ever arrives — and `connectionsWithin`
      // returns it immediately, so the session's first call would be routed into
      // a dead socket and burn the full BRIDGE_REQUEST_TIMEOUT_MS. Worse, that
      // symptom is indistinguishable from the open "first tabs_list times out"
      // question in docs/BRIDGE.md, so it would be misread as that. A loopback
      // pong returns in microseconds; anything still unanswered after this is
      // not coming.
      if (this.staleSweep !== null) clearTimeout(this.staleSweep);
      this.staleSweep = setTimeout(() => {
        this.staleSweep = null;
        this.pingAll();
      }, IDLE_CONNECTION_GRACE_MS);
    }
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

  /**
   * One line per bucket per UNAUTHENTICATED_LOG_INTERVAL_MS, carrying the count
   * it stood in for. Everything an unproved caller can make this hub write goes
   * through here; see the constant for why that set is larger than it looks.
   */
  private logUnauthenticated(bucket: string, message: string): void {
    const now = Date.now();
    const state = this.unauthLog.get(bucket);
    if (state && now - state.at < UNAUTHENTICATED_LOG_INTERVAL_MS) {
      state.suppressed += 1;
      return;
    }
    const suppressed = state?.suppressed ?? 0;
    this.unauthLog.set(bucket, { at: now, suppressed: 0 });
    console.error(
      message + (suppressed > 0 ? ` (and ${suppressed} more since the last such line)` : ""),
    );
  }

  private logRefusedOrigin(origin: string): void {
    const shown =
      origin.length > REFUSED_ORIGIN_MAX_CHARS
        ? `${origin.slice(0, REFUSED_ORIGIN_MAX_CHARS)}…`
        : origin;
    this.logUnauthenticated("origin", `[gullet] refused upgrade from origin ${shown}`);
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
        // `proto` is untrusted JSON, and this message reaches a log file. It is
        // rendered rather than interpolated for the same reason the refused-
        // origin line is truncated — see REFUSED_ORIGIN_LOG_INTERVAL_MS; a raw
        // 100 KB `proto` here would walk straight around that limit.
        `Extension speaks protocol ${describeProto(msg.proto)}; this Gullet speaks ${BRIDGE_PROTO}. Update whichever is older.`,
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
    // Both are read off an untrusted frame — `parseMessage` narrows `type` and
    // nothing else — and both are about to become hashed material, where a
    // non-string would either throw or stringify into something that is not
    // what the other side hashed. Refuse rather than either.
    if (typeof msg.nonce !== "string" || typeof msg.proof !== "string") {
      this.rejectHandshake(ws, "unauthorized", "Malformed hello: nonce and proof must be strings.");
      return;
    }

    // The role the caller *claims*, which is the role its proof has to have been
    // minted for. Deriving against anything else would let a proof made as one
    // kind of caller be spent as another — the second half of what protocol 3
    // closes, after the port.
    const role = helloProofRole(msg.role);
    const expected = await deriveProof(this.options.token, ws.data.serverNonce, role, this.port);
    if (!proofsMatch(msg.proof, expected)) {
      this.rejectHandshake(ws, "unauthorized", "Token mismatch.");
      return;
    }

    this.clearHandshakeTimer(ws);

    // Only another sidecar can retire this hub, and either kind of attachment
    // does it: an upgrade replaces a stale hub whether the newer Gullet arrives
    // to serve a session or merely to look. A browser never can — it has no
    // Gullet version to offer, and `shouldRetireFor` would refuse it anyway.
    if ((msg.role === "peer" || msg.role === "probe") && this.shouldRetireFor(msg.gullet)) {
      this.rejectHandshake(ws, "unsupported", this.retirementMessage(msg.gullet), true);
      this.retire();
      return;
    }

    // A caller asking "are you mine?" gets the same proof and nothing else. It
    // is answered before the peer branch because it must never reach the session
    // bookkeeping there — that is the entire difference between the two roles.
    if (msg.role === "probe") {
      await this.sendHelloAck(ws, msg.nonce);
      // The asker closes; this is only the backstop for one that does not.
      //
      // Closing here directly is the obvious move and it loses the answer: the
      // client verifies the counter-proof, which is an await, and a close event
      // arriving inside it settles the connect as a failure before the ack it is
      // still checking can settle it as a success. The symptom is a realm check
      // that reports "not mine" about a hub that is — so the caller binds a
      // second hub in the same realm, or declines to.
      ws.data.handshakeTimer = setTimeout(
        () => ws.close(),
        this.options.handshakeTimeoutMs ?? BRIDGE_HANDSHAKE_TIMEOUT_MS,
      );
      return;
    }

    if (msg.role === "peer") {
      // A peer has proved the token, which is the whole check: it is another
      // Gullet on this machine, and it gets exactly what our own MCP half gets.
      // Registered before the ack, so the count it carries already includes it.
      this.peers.set(ws.data.connectionId, ws);
      await this.sendHelloAck(ws, msg.nonce);
      console.error(`[gullet] peer sidecar attached (${ws.data.connectionId})`);
      this.publishSessions();
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
    await this.sendHelloAck(ws, msg.nonce);
    // Quiet while nobody is attached. A detached hub is dialled and dropped once
    // per background-page suspension for as long as the browser runs — that is
    // the design, not an incident — and logging the pair would bury the
    // connections that happened during a session under thousands that did not.
    if (this.sessions > 0) {
      console.error(`[gullet] ${conn.label} connected (${conn.connectionId}, v${conn.extVersion})`);
    }
    // Only once the handshake passes: a socket that cannot prove the token is
    // not a browser we can serve, so releasing waiters on `open` would hand
    // them an empty list and waste the wait.
    this.releaseConnectWaiters();
  }

  /**
   * Accept a proved handshake, whoever made it. All three kinds of caller get
   * the identical frame — the counter-proof against the nonce *they* chose, so a
   * process squatting the port cannot collect their traffic, and the session
   * count, which every one of them is entitled to read.
   *
   * Callers that change the count register themselves before calling: the number
   * on the ack is the one that includes the connection it answers.
   */
  private async sendHelloAck(ws: Bun.ServerWebSocket<SocketData>, nonce: string): Promise<void> {
    this.send(ws, {
      type: "hello-ack",
      proto: BRIDGE_PROTO,
      connectionId: ws.data.connectionId,
      // `"server"` and our own port: the counter-proof is bound to this end of
      // this channel, so a client's proof can never be reflected back at it as
      // an ack, and an ack minted here is worthless anywhere else.
      proof: await deriveProof(this.options.token, nonce, "server", this.port),
      sessions: this.sessions,
    });
  }

  /**
   * `proven` says whether the caller had already proved the token when this was
   * decided. Only a retirement has; every other rejection here is reachable by
   * anything that can open a socket with an extension Origin, so its log line is
   * rate-limited while the message it sends back is not.
   */
  private rejectHandshake(
    ws: Bun.ServerWebSocket<SocketData>,
    code: "unauthorized" | "unsupported",
    message: string,
    proven = false,
  ): void {
    const line = `[gullet] handshake rejected: ${message}`;
    if (proven) console.error(line);
    else this.logUnauthenticated("handshake", line);
    this.send(ws, { type: "hello-error", error: { code, message } });
    ws.close();
  }

  private onClose(ws: Bun.ServerWebSocket<SocketData>): void {
    this.clearHandshakeTimer(ws);
    if (this.peers.delete(ws.data.connectionId)) {
      console.error(`[gullet] peer sidecar detached (${ws.data.connectionId})`);
      this.publishSessions();
      return;
    }
    const conn = this.connections.get(ws.data.connectionId);
    if (!conn) return;
    this.connections.delete(conn.connectionId);
    this.rejectPending(conn, `${conn.label} disconnected mid-request.`);
    // Silent while idle, for the reason the connect line is — see completeHandshake.
    if (this.sessions > 0) {
      console.error(`[gullet] ${conn.label} disconnected (${conn.connectionId})`);
    }
  }

  /**
   * Whether an attaching peer is new enough that we should get out of its way.
   *
   * Only a detached hub ever answers yes. A session-scoped hub shares its
   * lifetime with the agent that spawned it, so it cannot be the stale one; and
   * retiring it would take its own MCP session down with it, which is a far
   * worse outcome than serving a version-old peer for a few minutes.
   */
  private shouldRetireFor(peerVersion: string | undefined): boolean {
    if (!this.options.detached || this.retiring) return false;
    const ours = this.options.version;
    if (!ours || !peerVersion) return false;
    return compareGulletVersions(peerVersion, ours) > 0;
  }

  private retirementMessage(peerVersion: string | undefined): string {
    return (
      `${RETIRING_FOR_NEWER_PEER}: this hub runs Gullet ${this.options.version} and the ` +
      `attaching sidecar runs ${peerVersion}. Shutting down so the newer one can take the port.`
    );
  }

  /**
   * Stand aside for a newer sidecar. Drops everything so the port is free by the
   * time that sidecar re-races for it — a retire that left the socket bound
   * would send it straight back into the loop it just escaped.
   *
   * Deferred by a tick, because the caller has just queued the `hello-error`
   * explaining why, and `stop()` force-closes every socket including that one.
   * The frame has been observed arriving anyway, which is precisely why this is
   * worth pinning down: a teardown that races its own explanation would fail
   * only under load, and the symptom would be a hub that vanishes for no
   * recorded reason.
   */
  private retire(): void {
    if (this.retiring) return;
    this.retiring = true;
    console.error("[gullet] retiring: a newer Gullet asked for the port");
    setTimeout(() => {
      this.stop();
      this.options.onRetire?.();
    }, 0);
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
      // A peer's `connections` inherits the hub's own first-call wait — the
      // same number for both kinds of session, so losing the port election
      // cannot shorten how long a first call will wait for a browser. The
      // peer's outer RPC deadline sits strictly above this (see PEER_RPC_SLACK_MS
      // in peer.ts), so waiting the full budget here cannot read as a dead hub.
      const result =
        msg.op === "connections"
          ? await this.connectionsWithin(BRIDGE_CONNECT_WAIT_MS)
          : await this.requestFromPeer(msg);
      this.send(ws, { type: "peer-response", id: msg.id, result });
    } catch (err) {
      this.send(ws, { type: "peer-response", id: msg.id, error: toBridgeError(err) });
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

  private send(
    ws: Bun.ServerWebSocket<SocketData>,
    msg: ServerMessage | PeerResponseMessage,
  ): void {
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
