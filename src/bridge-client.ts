// Extension side of the agent bridge: dials the Gullet sidecar on loopback and
// serves method calls with real `browser.*` APIs. See BRIDGE.md.
//
// Nobody launches an app. While the page is awake, an idle loop re-probes the
// port every few seconds (IDLE_PROBE_MS) so a sidecar started mid-session is
// picked up within seconds; a 30s alarm is the backstop that survives page
// suspension. A socket is only opened once something answers — see
// PROBE_TIMEOUT_MS for why that indirection is worth having. The bridge is
// opt-in (options page), so a user who never enables it never touches the
// network at all.

import {
  BRIDGE_DIAL_TIMEOUT_MS,
  BRIDGE_HANDSHAKE_TIMEOUT_MS,
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_PROTO,
  deriveProof,
  isBridgeMethod,
  parseMessage,
  proofsMatch,
  randomNonce,
  toBridgeError,
  BridgeRequestError,
  type BridgeMethod,
  type ClientMessage,
  type HelloMessage,
  type ResponseMessage,
} from "./bridge-protocol.js";
import type { Settings } from "./storage.js";
import { IS_CHROME, TARGET } from "./target.js";

const BRIDGE_ALARM = "tabglutton-bridge-reconnect";

/**
 * The alarm cadence — the guaranteed wake, and the only reconnect path that
 * survives page suspension (pending timers, including the idle probe loop
 * below, do not). 30s is Chrome's alarm floor for MV3 — but only from Chrome
 * 120; 116-119 clamp every extension alarm to a minute, which is longer than
 * the BRIDGE_CONNECT_WAIT_MS an agent's first call will wait, so
 * `minimum_chrome_version` is 120 (see build.ts). Firefox honours 30s exactly
 * (measured on 153 — it fires on the half minute), so even a suspended page
 * picks a sidecar up within one period.
 */
const RECONNECT_PERIOD_MINUTES = 0.5;

/**
 * Extra dials between alarm ticks, to close the gap after a socket drops without
 * waiting out a whole alarm period.
 *
 * Only ever armed after losing a connection we actually had, never after a dial
 * that failed to land. That distinction is the whole point. Gecko penalises
 * repeated failed WebSocket connections to one endpoint by delaying the next
 * attempt (see BRIDGE_DIAL_TIMEOUT_MS), so retrying hard into a port with
 * nothing behind it manufactures precisely the delay that then stops us
 * connecting when a sidecar finally does appear: eight retries per wake is ~9
 * failures per 30s, which reaches the 60s ceiling inside a minute, where the
 * alarm alone would take ~7. Retrying is only justified when we have proof the
 * other end exists — and having just been connected to it is that proof.
 *
 * Best-effort even then: a pending timer does not keep a suspended background
 * page alive, so these only fire while something else is holding it up — in
 * practice the keepalive below, which is exactly the case that matters, since
 * that is when an agent is mid-session and waiting on us.
 */
const FAST_RETRY_MS = 3_000;
const FAST_RETRIES_PER_WAKE = 8;

/**
 * Both engines suspend an idle background context — Gecko after
 * `extensions.background.idle.timeout` (30s by default), Chrome MV3 on the same
 * order — and suspension destroys the page's WebSocket. What differs is what
 * counts as activity, and this exists for Gecko: **there, WebSocket traffic is
 * not activity** — only WebExtension API calls reset the idle timer — so a
 * connected bridge whose only traffic is its own heartbeat gets suspended out
 * from under its socket and stays dark until the reconnect alarm fires. Chrome
 * counts socket traffic as activity from 116, below our
 * `minimum_chrome_version`, so the heartbeat alone holds the worker up there and
 * this timer is harmless redundancy rather than the load-bearing part.
 *
 * Measured on Zen 1.21.9b before this existed: the socket dropped every 20-60s
 * (the variation is incidental API activity from tab events resetting the
 * timer) and took a further ~30s to return, so a third of the time there was no
 * bridge and tool calls answered "no browser is connected".
 *
 * The fix is to touch a real API on a timer, for as long as a sidecar is
 * connected. The connection is the entitlement: Gullet is spawned by an agent
 * harness and exits with it, so a live socket already means a session is open
 * and no browser is held awake for nobody. Tying this to *requests* instead —
 * the first shape of it — kept the page awake only for a few minutes after each
 * tool call, which left the connect-then-idle gap uncovered: the socket came up,
 * nothing was asked of it, the page suspended, and the agent's first real call
 * found no browser. The linger below now governs only how long we stay awake
 * *after* a socket drops, which is the window a redial has to land in.
 */
const KEEPALIVE_PING_MS = 20_000;
const KEEPALIVE_LINGER_MS = 5 * 60_000;

/**
 * Before opening a WebSocket, ask the same port a plain HTTP question. Gullet
 * answers a non-upgrade request with 403, so *any* response proves someone is
 * listening — the status is irrelevant, we are asking "is a server there", not
 * "is it well" — and a port with nothing behind it refuses in microseconds.
 *
 * This exists to keep Gecko's reconnect penalty at zero rather than merely
 * survivable. That penalty is fed by failed *WebSocket* connects
 * (`FailDelayManager`, see BRIDGE_DIAL_TIMEOUT_MS); an HTTP request is not one,
 * so an extension left switched on with no sidecar running now accumulates
 * nothing, and the socket it eventually opens connects at full speed. Without
 * it, the steady state after ~7 idle minutes is the 60s ceiling, and since the
 * ceiling is measured from the last failure while we re-dial every 30s, the
 * first connection of a session lands somewhere in 0-60s. That is the "stuck on
 * Connecting…" that this whole area kept producing while every part of the
 * bridge was in fact healthy.
 *
 * The probe is an optimisation and must never become a gate. If `fetch` were
 * blocked for a reason we have not anticipated — a future local-network
 * restriction is the plausible one — a bridge that consequently refused to dial
 * at all would be a far worse failure than the seconds this saves. So a run of
 * misses dials anyway: the degraded case is the old behaviour, not a dead
 * bridge.
 */
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_MISSES_BEFORE_DIALLING_BLIND = 4;

/**
 * How often to re-probe while the page is awake and the bridge is idle. This is
 * what closes the session-start race: discovery used to be strictly
 * alarm-cadenced, and one 30s period against BRIDGE_CONNECT_WAIT_MS left an
 * agent's first call a few seconds of margin — which alarm jitter and the wake
 * cost of `init()` at ~1000 tabs regularly ate, producing "first call fails,
 * retry succeeds". A probe is a plain HTTP fetch: it does not feed Gecko's
 * `FailDelayManager` (only failed *WebSocket* connects do — see
 * PROBE_TIMEOUT_MS), and a refused loopback connect resolves in microseconds,
 * so asking every few seconds costs nothing that matters and dials nothing
 * until a server actually answers.
 *
 * Two deliberate limits. The loop is best-effort: its timer dies with page
 * suspension (on either engine), so the alarm remains the guaranteed wake and
 * the degraded case is exactly the old cadence. And a miss here never counts
 * toward PROBE_MISSES_BEFORE_DIALLING_BLIND — only ticks from outside the
 * loop do (the alarm, a page wake, `sync()`, a fast retry), with a counting
 * tick that lands mid-probe carried over rather than dropped. Blind dials are
 * failed WebSocket connects, the one thing that *does* feed the reconnect
 * penalty; inheriting this loop's cadence would fire one every ~12s and
 * rebuild the very ceiling the probe exists to avoid, so the escape valve
 * keeps its tick-paced schedule — ~2 minutes when only the alarm is ticking.
 *
 * The miss counter is deliberately instance-only, and it must stay that way.
 * It was made durable once (`storage.session`, so the valve would fire
 * "reliably" across suspensions) and reverted the same session: with every
 * wake's probe miss accumulating, the valve fired often enough that its
 * failed connects rebuilt a near-ceiling penalty inside ~15 minutes —
 * observed live as `bridge socket open after 48129ms` against a sidecar
 * answering HTTP in microseconds. (The same browser was later caught failing
 * socket creation browser-wide — its own Push service logging
 * `NS_ERROR_SOCKET_CREATE_FAILED` — so the counter may not own that 48s
 * alone; see BRIDGE.md. Either way the mechanism stands: blind dials are the
 * only thing we control that feeds the penalty.) Suspension resetting the
 * count is not a reliability bug in the valve; it is what keeps blind dials
 * rare. The valve
 * still fires where it can help: a page held awake by real use counts to
 * four inside ~2 minutes, and active use is the only world where escaping a
 * blocked `fetch` matters anyway.
 */
const IDLE_PROBE_MS = 3_000;

export type BridgeStatus = "disabled" | "idle" | "connecting" | "connected";

export interface BridgeClientDeps {
  getSettings: () => Settings;
  /** Only ever called with a method that passed `isBridgeMethod`. */
  run: (method: BridgeMethod, params: unknown) => Promise<unknown>;
  onStatusChange: (status: BridgeStatus) => void;
}

// "connecting" covers the handshake too — no caller distinguishes the two, and
// the handshake deadline is tracked by `handshakeTimer` rather than by a phase.
type Phase = "closed" | "connecting" | "open";

export class BridgeClient {
  private readonly deps: BridgeClientDeps;
  private socket: WebSocket | null = null;
  private phase: Phase = "closed";
  /** Token this socket authenticated with. Regenerating it must revoke the socket. */
  private socketToken = "";
  private clientNonce = "";
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private fastRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Dials spent since the last wake; reset per alarm tick, not per attempt. */
  private fastRetries = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Epoch ms until which the page stays awake. Renewed on every keepalive tick
   * while the socket is open, so once it closes this reads as a linger measured
   * from the drop rather than from whenever we last connected or served.
   */
  private keepaliveUntil = 0;
  private awaitingPong = false;
  /** A probe is in flight; `phase` is still "closed", so ticks need their own guard. */
  private probing = false;
  /** Counted probe misses. Deliberately dies with the page — an ephemeral
   * count is what keeps blind dials rare; see the valve notes at IDLE_PROBE_MS. */
  private probeMisses = 0;
  /** The idle probe loop's pending timer — see IDLE_PROBE_MS. */
  private idleProbeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A counting tick landed while a probe was in flight; the probe consumes it. */
  private countedTickPending = false;
  private label = IS_CHROME ? "Chrome" : "Firefox";
  /** Whether `start()` has run, i.e. whether the settings we read are real ones. */
  private started = false;
  /** The bridge settings this client last acted on; see `sync`. */
  private lastBridgeConfig = "";

  constructor(deps: BridgeClientDeps) {
    this.deps = deps;
    // Registered in the constructor, which background.ts runs at module top
    // level: an MV3 service worker that restarts on an alarm must already have
    // the listener attached, so it cannot be deferred behind an await.
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== BRIDGE_ALARM) return;
      // The alarm is also what *woke* this page, so it can be delivered while
      // init is still awaiting `loadSettings()` — at which point the settings we
      // would read are the defaults, the bridge reads as switched off, and this
      // tick would tear down and report "disabled" instead of dialling. Dropping
      // it costs nothing: init always ends in `start()`, which dials anyway.
      if (!this.started) return;
      // Each wake gets a fresh budget, so a browser left idle for hours still
      // gets a burst of attempts the next time it is woken.
      this.fastRetries = 0;
      this.tick();
    });
  }

  /**
   * Arm the reconnect alarm and make the first dial. Called once per page
   * lifetime — which on an event page means once per wake, not once per session.
   */
  async start(): Promise<void> {
    this.started = true;
    this.label = await resolveLabel();
    // Seeded here so the first `sync()` of this page's life compares against
    // what we actually dialled, rather than reading every key as new.
    this.lastBridgeConfig = bridgeConfigKey(this.deps.getSettings());
    await this.syncAlarm();
    this.fastRetries = 0;
    this.tick();
  }

  /**
   * The reconnect alarm exists only while the bridge is switched on. It is a
   * periodic wake, and on Chrome MV3 every wake cold-starts the service worker
   * and re-runs init — a default-off install must not pay that twice a minute
   * to rediscover that it has nothing to dial.
   */
  private async syncAlarm(): Promise<void> {
    if (!this.isConfigured(this.deps.getSettings())) {
      await browser.alarms.clear(BRIDGE_ALARM);
      return;
    }
    // Never re-arm an alarm that is already running. `create()` clears and
    // replaces a same-named alarm, restarting its countdown — and this runs on
    // every event-page restart, which a busy browser triggers constantly. Left
    // unguarded, a page woken more often than the period pushes the next fire
    // back indefinitely and the alarm never fires at all, starving the one
    // reconnect path that is supposed to be guaranteed.
    if (await browser.alarms.get(BRIDGE_ALARM)) return;
    browser.alarms.create(BRIDGE_ALARM, {
      delayInMinutes: RECONNECT_PERIOD_MINUTES,
      periodInMinutes: RECONNECT_PERIOD_MINUTES,
    });
  }

  /** Re-evaluate after a settings change: connect, disconnect, or re-dial. */
  sync(): void {
    // Same race as the alarm listener in the constructor: a storage change can
    // wake a cold page and land here before `start()` has seeded
    // `lastBridgeConfig`, at which point *any* change — a dedup scope, a clip
    // folder — compares against "" and reads as a deliberate bridge change,
    // earning the unprobed dial reserved for one. Dropping the call costs
    // nothing: init always ends in `start()`, which seeds and dials.
    if (!this.started) return;
    void this.syncAlarm();
    const settings = this.deps.getSettings();
    // `background.ts` calls this whenever *any* setting changes, so most of the
    // time nothing here has moved and this is a dedup scope or a clip folder
    // passing through. Only a change to the three keys the bridge actually reads
    // counts as the deliberate act that earns an unprobed dial below; treating
    // every keystroke in the options page as one opens a failed WebSocket
    // against an empty port and rebuilds precisely the Gecko reconnect penalty
    // the probe exists to keep at zero (see PROBE_TIMEOUT_MS).
    const config = bridgeConfigKey(settings);
    const changed = config !== this.lastBridgeConfig;
    this.lastBridgeConfig = config;
    if (!this.isConfigured(settings)) {
      this.disable();
      return;
    }
    // A deliberate bridge change — most often enabling it or generating a token
    // — earns a fresh burst rather than inheriting whatever the last wake left.
    if (changed) this.fastRetries = 0;
    // Port or token changed under an open socket — drop it and redial clean.
    // The token half matters most: regenerating it is how a user revokes a
    // sidecar, and a live socket that keeps serving requests would let the
    // revoked token retain read/clip/close access for the rest of the session.
    const stale =
      this.socket?.url !== this.socketUrl(settings) || this.socketToken !== settings.bridgeToken;
    if (this.phase !== "closed" && stale) {
      this.teardown();
    }
    this.tick(changed);
  }

  get status(): BridgeStatus {
    if (!this.isConfigured(this.deps.getSettings())) return "disabled";
    if (this.phase === "open") return "connected";
    if (this.phase === "closed") return "idle";
    return "connecting";
  }

  private isConfigured(settings: Settings): boolean {
    return settings.bridgeEnabled && settings.bridgeToken.length > 0;
  }

  private socketUrl(settings: Settings): string {
    return `ws://127.0.0.1:${settings.bridgePort}/`;
  }

  /**
   * @param force skip the probe and dial regardless. For deliberate user actions
   * only: someone who has just switched the bridge on is watching for it to do
   * something, and one failed connect costs a few hundred milliseconds of
   * penalty rather than the ceiling — it is the *repetition* that is expensive.
   */
  private tick(force = false): void {
    const settings = this.deps.getSettings();
    if (!this.isConfigured(settings)) {
      this.disable();
      return;
    }
    if (this.phase !== "closed") return;
    if (this.probing) {
      // A counting tick that lands inside an in-flight idle probe must not
      // just vanish: its miss would have advanced the blind-dial counter. That
      // matters in exactly the world the escape valve exists for — a blocked
      // `fetch` that *hangs* to PROBE_TIMEOUT_MS rather than rejecting gives
      // the loop a duty cycle high enough to swallow ticks routinely, and
      // dropping them would stretch the valve's pacing non-deterministically.
      this.countedTickPending = true;
      return;
    }
    if (force) {
      this.probeMisses = 0;
      this.connect(settings);
      return;
    }
    void this.probeThenConnect(settings, true);
  }

  /**
   * Open a socket only once something has answered the port — see
   * PROBE_TIMEOUT_MS. `countsTowardBlindDial` is true for alarm/sync/retry
   * ticks and false for the idle probe loop, which must stay incapable of
   * triggering a blind dial — see IDLE_PROBE_MS for why that split is
   * load-bearing.
   */
  private async probeThenConnect(
    settings: Settings,
    countsTowardBlindDial: boolean,
  ): Promise<void> {
    this.probing = true;
    let answered = false;
    try {
      answered = await portAnswers(settings.bridgePort);
    } finally {
      this.probing = false;
    }
    if (!answered) {
      // Nothing there, which costs nothing to keep asking about: every miss
      // re-arms the loop, so the loop lives exactly as long as the port is
      // empty and the page is awake, and stops itself the moment either ends.
      this.scheduleIdleProbe();
      const counts = countsTowardBlindDial || this.countedTickPending;
      this.countedTickPending = false;
      if (!counts) return;
      this.probeMisses += 1;
      if (this.probeMisses < PROBE_MISSES_BEFORE_DIALLING_BLIND) return;
      console.debug(`[tabglutton] bridge probe found nothing ${this.probeMisses}x; dialling blind`);
    }
    this.countedTickPending = false;
    this.probeMisses = 0;
    // Re-read rather than trusting the captured settings: the probe is an await,
    // and a settings change or a socket opened by a fast retry can land inside
    // it. Dialling on what was true before it would then leak a second socket or
    // use a stale port.
    const current = this.deps.getSettings();
    if (this.phase !== "closed" || !this.isConfigured(current)) return;
    this.connect(current);
  }

  /**
   * The bridge has been switched off, as opposed to a socket merely dropping.
   * That distinction is the keepalive's: a dropped socket should keep the page
   * awake so the redial lands promptly, but a bridge nobody enabled must not
   * hold the page up at all.
   */
  private disable(): void {
    this.stopKeepalive();
    this.clearIdleProbe();
    this.teardown();
  }

  private connect(settings: Settings): void {
    // An idle-probe timer armed by an earlier miss must not survive into the
    // dial: if this dial fails fast, that stale timer would re-probe a port
    // that answers and re-dial it ~3s later — the exact hammer the
    // probe-miss-only arming rule exists to prevent. From here on, scheduling
    // belongs to the alarm (and, after a lost connection, the fast retries).
    this.clearIdleProbe();
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.socketUrl(settings));
    } catch (err) {
      // Constructor threw, so no close/error event will arrive to route us
      // through teardown(). Nothing to retry into either — this never reached a
      // connection — so the alarm picks it up on its own schedule.
      console.warn("[tabglutton] bridge dial failed", err);
      return;
    }
    this.socket = socket;
    // Pinned for the life of the socket: the handshake proves *this* token, and
    // `sync()` compares against it to decide whether the socket is still valid.
    this.socketToken = settings.bridgeToken;
    this.setPhase("connecting");
    const dialStarted = Date.now();
    console.debug("[tabglutton] bridge dialling", socket.url);

    // The dial gets a deadline of its own — a long one, see BRIDGE_DIAL_TIMEOUT_MS
    // — because without any, a socket that neither opens nor errors pins `phase`
    // at "connecting" for the rest of this page's life, and both `tick()` and the
    // alarm return early on every phase but "closed". That is a wedge no retry
    // can clear. Sized to bound that case without preempting a slow-but-live
    // connect, which is the mistake this replaces.
    this.handshakeTimer = setTimeout(() => {
      console.warn(`[tabglutton] bridge dial timed out after ${Date.now() - dialStarted}ms`);
      this.teardown();
    }, BRIDGE_DIAL_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      // Connected: swap the dial's deadline for the handshake's much shorter one.
      // The elapsed time is worth having — it is the only direct measure of how
      // long the browser made us wait, which is what distinguishes "no sidecar"
      // from "throttled reconnect".
      this.clearHandshakeTimer();
      console.debug(`[tabglutton] bridge socket open after ${Date.now() - dialStarted}ms`);
      this.handshakeTimer = setTimeout(() => {
        console.warn("[tabglutton] bridge handshake timed out");
        this.teardown();
      }, BRIDGE_HANDSHAKE_TIMEOUT_MS);
    });
    socket.addEventListener("message", (event) => {
      void this.onMessage(socket, event);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.teardown();
    });
    // Nothing listening on the port is the normal idle case, not an incident.
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.teardown();
    });
  }

  private async onMessage(socket: WebSocket, event: MessageEvent): Promise<void> {
    if (this.socket !== socket) return;
    if (typeof event.data !== "string") return;
    const msg = parseMessage(event.data);
    if (!msg) return;

    switch (msg.type) {
      case "challenge": {
        if (msg.proto !== BRIDGE_PROTO) {
          console.warn(
            `[tabglutton] bridge protocol mismatch: sidecar speaks ${msg.proto}, extension speaks ${BRIDGE_PROTO}`,
          );
          this.teardown();
          return;
        }
        const token = this.socketToken;
        this.clientNonce = randomNonce();
        const hello: HelloMessage = {
          type: "hello",
          proto: BRIDGE_PROTO,
          browser: TARGET,
          extVersion: browser.runtime.getManifest().version,
          label: this.label,
          nonce: this.clientNonce,
          proof: await deriveProof(token, msg.nonce),
        };
        this.send(socket, hello);
        return;
      }
      case "hello-ack": {
        const expected = await deriveProof(this.socketToken, this.clientNonce);
        if (!proofsMatch(msg.proof, expected)) {
          // Something is on our port that does not know the token. Do not talk to it.
          console.warn("[tabglutton] bridge server failed the token challenge");
          this.teardown();
          return;
        }
        this.clearHandshakeTimer();
        this.clearFastRetry();
        this.setPhase("open");
        this.startHeartbeat(socket);
        // On connect, not on first request. A connected sidecar is *itself* the
        // proof that someone is using this: Gullet is spawned by an agent
        // harness and lives exactly as long as the session does, so there is no
        // such thing as a connection nobody wants. Waiting for a request instead
        // left the gap that actually bit — connect, sit idle, get suspended out
        // from under the socket before the agent's first call, and answer that
        // call with "no browser is connected" after the full connect wait.
        this.armKeepalive();
        console.log("[tabglutton] bridge connected as", msg.connectionId);
        return;
      }
      case "hello-error":
        console.warn("[tabglutton] bridge rejected the handshake:", msg.error.message);
        this.teardown();
        return;
      case "ping":
        this.send(socket, { type: "pong", t: msg.t });
        return;
      case "pong":
        this.awaitingPong = false;
        return;
      case "request": {
        if (this.phase !== "open") return;
        // Before serving, not after: a slow method must not let the page suspend
        // out from under the very request it is answering.
        this.armKeepalive();
        const response = await this.serve(msg.id, msg.method, msg.params);
        this.send(socket, response);
        return;
      }
      default:
        return;
    }
  }

  private async serve(id: string, method: unknown, params: unknown): Promise<ResponseMessage> {
    if (!isBridgeMethod(method)) {
      return {
        type: "response",
        id,
        error: { code: "bad-request", message: `Unknown method ${String(method)}.` },
      };
    }
    try {
      return { type: "response", id, result: await this.deps.run(method, params) };
    } catch (err) {
      // A BridgeRequestError is an answer, not an incident; anything else is a
      // bug worth surfacing in the console as well as on the wire.
      if (!(err instanceof BridgeRequestError)) {
        console.warn("[tabglutton] bridge method threw", method, err);
      }
      return { type: "response", id, error: toBridgeError(err) };
    }
  }

  private send(socket: WebSocket, msg: ClientMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  // Application-level ping rather than a WebSocket control frame, so that a
  // half-open socket is detected here rather than being answered by the browser
  // itself. It does *not* keep the background page alive — see the keepalive
  // constants above; assuming it did is what hid the reconnect churn.
  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      if (this.awaitingPong) {
        console.warn("[tabglutton] bridge heartbeat lost, reconnecting");
        this.teardown();
        return;
      }
      this.awaitingPong = true;
      this.send(socket, { type: "ping", t: Date.now() });
    }, BRIDGE_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private clearFastRetry(): void {
    if (this.fastRetryTimer !== null) clearTimeout(this.fastRetryTimer);
    this.fastRetryTimer = null;
  }

  /**
   * Extend the no-suspend window, starting the timer if it is not already
   * running. Deliberately independent of the socket rather than folded into the
   * heartbeat: the heartbeat dies with the connection, and holding the page up
   * *across* a reconnect is precisely when it earns its keep — that is the gap
   * an agent would otherwise sit through.
   */
  private armKeepalive(): void {
    this.keepaliveUntil = Date.now() + KEEPALIVE_LINGER_MS;
    if (this.keepaliveTimer !== null) return;
    this.keepaliveTimer = setInterval(() => {
      // Renewed on every tick while the socket is open, so the deadline always
      // reads "linger from the drop". Deriving it once at connect (or at the
      // last served request) instead leaves it stale by however long the session
      // has been quiet: an hour-long idle connection would reach its drop with a
      // deadline 55 minutes past, and the very next tick would stop keeping the
      // page awake — at the exact moment the redial needs it up. The linger is
      // meant to cover the reconnect gap, so it has to be measured from the gap.
      if (this.phase === "open") {
        this.keepaliveUntil = Date.now() + KEEPALIVE_LINGER_MS;
      } else if (Date.now() >= this.keepaliveUntil) {
        this.stopKeepalive();
        return;
      }
      // Making the call is the entire point; the answer is discarded. This is
      // the cheapest API that needs no permission and cannot fail meaningfully.
      void browser.runtime.getPlatformInfo().catch(() => {});
    }, KEEPALIVE_PING_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.keepaliveUntil = 0;
  }

  /**
   * Queue another dial before the next alarm, while the budget for this wake
   * lasts. Deliberately flat rather than backing off: the window we are trying
   * to catch is a sidecar that lives for seconds, and a backoff would spend the
   * budget past the point where it could still land.
   */
  private scheduleFastRetry(): void {
    if (this.fastRetryTimer !== null) return;
    if (this.fastRetries >= FAST_RETRIES_PER_WAKE) return;
    if (!this.isConfigured(this.deps.getSettings())) return;
    this.fastRetryTimer = setTimeout(() => {
      this.fastRetryTimer = null;
      this.fastRetries += 1;
      this.tick();
    }, FAST_RETRY_MS);
  }

  /**
   * Re-arm the idle probe loop — see IDLE_PROBE_MS. Only ever armed from a
   * probe miss, and `connect()` clears any timer still pending from an
   * earlier miss, so a port that answers hands scheduling back to the alarm:
   * a server that is present but failing the handshake gets re-approached
   * every 30s, not every 3s.
   */
  private scheduleIdleProbe(): void {
    if (this.idleProbeTimer !== null) return;
    if (!this.isConfigured(this.deps.getSettings())) return;
    this.idleProbeTimer = setTimeout(() => {
      this.idleProbeTimer = null;
      if (this.phase !== "closed" || this.probing) return;
      // Re-read, as everywhere: 3s is plenty of time for the options page to
      // have switched the bridge off or regenerated the token.
      const settings = this.deps.getSettings();
      if (!this.isConfigured(settings)) return;
      void this.probeThenConnect(settings, false);
    }, IDLE_PROBE_MS);
  }

  private clearIdleProbe(): void {
    if (this.idleProbeTimer !== null) clearTimeout(this.idleProbeTimer);
    this.idleProbeTimer = null;
  }

  /** Drop the socket and report whatever the settings now imply — idle if the
   * bridge is still on and we should keep dialling, disabled if it is not. */
  private teardown(): void {
    // Captured before the phase is reset: whether we are recovering from a live
    // connection or from a dial that never landed decides if a fast retry is
    // earned, and only the pre-teardown phase knows which.
    const wasConnected = this.phase === "open";
    this.stopHeartbeat();
    this.clearHandshakeTimer();
    const socket = this.socket;
    this.socket = null;
    this.socketToken = "";
    this.phase = "closed";
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        // Already closing; nothing to do.
      }
    }
    this.deps.onStatusChange(this.status);
    // Every failed dial and every dropped connection lands here, but only the
    // second earns an immediate retry — see FAST_RETRY_MS. A dial that never
    // landed waits for the alarm instead, so we stop bidding up the browser's
    // own reconnect delay. No-ops once the bridge is switched off, or once this
    // wake's budget is spent.
    if (wasConnected) this.scheduleFastRetry();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.deps.onStatusChange(this.status);
  }
}

/**
 * The three settings this client reads, as one comparable value. Everything else
 * in `Settings` belongs to dedup or clipping and cannot change what we dial.
 */
function bridgeConfigKey(settings: Settings): string {
  return `${settings.bridgeEnabled ? 1 : 0}:${settings.bridgePort}:${settings.bridgeToken}`;
}

/**
 * Whether anything at all answers HTTP on the port — see PROBE_TIMEOUT_MS for
 * why we ask this before opening a socket. Every failure mode (refused, blocked,
 * timed out) reads the same as "nobody there", which is the honest answer: we
 * cannot tell them apart from here, and the caller treats a run of them as a
 * reason to dial anyway rather than as proof.
 */
async function portAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

// The label is how the connection shows up in the agent's tab listing, so we
// prefer whatever name the browser reports over our own build target. Note that
// Zen does *not* rebrand `getBrowserInfo()` — it answers "Firefox", so a Zen
// connection lists as Firefox until Zen exposes something better.
async function resolveLabel(): Promise<string> {
  if (IS_CHROME) return "Chrome";
  try {
    const info = await browser.runtime.getBrowserInfo?.();
    return info?.name ?? "Firefox";
  } catch {
    return "Firefox";
  }
}
