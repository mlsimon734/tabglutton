// Extension side of the agent bridge: dials the Gullet sidecar on loopback and
// serves method calls with real `browser.*` APIs. See BRIDGE.md.
//
// Nobody launches an app. When no sidecar is running the socket just fails
// cheaply and we idle; an alarm re-dials so a session that starts later is
// picked up without user action. The bridge is opt-in (options page), so a user
// who never enables it never opens a socket at all.

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
 * How often we re-dial while idle. 30s is Chrome's documented alarm floor;
 * Firefox honours it exactly (measured on 153 — it fires on the half minute),
 * so a sidecar started mid-session is picked up within one period.
 */
const RECONNECT_PERIOD_MINUTES = 0.5;

/**
 * Extra dials between alarm ticks, to close the gap after a socket drops
 * without waiting out a whole alarm period.
 *
 * Best-effort by design: a pending timer does not keep a suspended background
 * page alive, so these only fire while something else is holding it up — in
 * practice the keepalive below, which is exactly the case that matters, since
 * that is when an agent is mid-session and waiting on us. The alarm remains the
 * guaranteed path.
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
 * counts socket traffic as activity from 116, already our
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
  private label = IS_CHROME ? "Chrome" : "Firefox";
  /** Whether `start()` has run, i.e. whether the settings we read are real ones. */
  private started = false;

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
    void this.syncAlarm();
    const settings = this.deps.getSettings();
    if (!this.isConfigured(settings)) {
      this.disable();
      return;
    }
    // A settings change is a deliberate user action — most often enabling the
    // bridge or generating a token — so it earns a fresh burst rather than
    // inheriting whatever the last wake had left.
    this.fastRetries = 0;
    // Port or token changed under an open socket — drop it and redial clean.
    // The token half matters most: regenerating it is how a user revokes a
    // sidecar, and a live socket that keeps serving requests would let the
    // revoked token retain read/clip/close access for the rest of the session.
    const stale =
      this.socket?.url !== this.socketUrl(settings) || this.socketToken !== settings.bridgeToken;
    if (this.phase !== "closed" && stale) {
      this.teardown();
    }
    this.tick();
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

  private tick(): void {
    const settings = this.deps.getSettings();
    if (!this.isConfigured(settings)) {
      this.disable();
      return;
    }
    if (this.phase !== "closed") return;
    this.connect(settings);
  }

  /**
   * The bridge has been switched off, as opposed to a socket merely dropping.
   * That distinction is the keepalive's: a dropped socket should keep the page
   * awake so the redial lands promptly, but a bridge nobody enabled must not
   * hold the page up at all.
   */
  private disable(): void {
    this.stopKeepalive();
    this.teardown();
  }

  private connect(settings: Settings): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.socketUrl(settings));
    } catch (err) {
      // Constructor threw, so no close/error event will arrive to route us
      // through teardown() — ask for the next attempt here instead.
      console.warn("[tabglutton] bridge dial failed", err);
      this.scheduleFastRetry();
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
        // call with "no browser is connected" after a 35s wait for a redial.
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

  /** Drop the socket and report whatever the settings now imply — idle if the
   * bridge is still on and we should keep dialling, disabled if it is not. */
  private teardown(): void {
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
    // Every failed dial and every dropped connection lands here, so this is the
    // one place that needs to ask for another attempt. No-ops once the bridge is
    // switched off, or once this wake's budget is spent.
    this.scheduleFastRetry();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.deps.onStatusChange(this.status);
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
