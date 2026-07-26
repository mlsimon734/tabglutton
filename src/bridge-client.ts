// Extension side of the agent bridge: dials the Gullet sidecar on loopback and
// serves method calls with real `browser.*` APIs. See BRIDGE.md.
//
// Nobody launches an app. When no sidecar is running the socket just fails
// cheaply and we idle; an alarm re-dials so a session that starts later is
// picked up without user action. The bridge is opt-in (options page), so a user
// who never enables it never opens a socket at all.

import {
  BRIDGE_HANDSHAKE_TIMEOUT_MS,
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_PROTO,
  deriveProof,
  isBridgeMethod,
  parseMessage,
  proofsMatch,
  randomNonce,
  BridgeRequestError,
  type BridgeMethod,
  type ClientMessage,
  type HelloMessage,
  type ResponseMessage,
} from "./bridge-protocol.js";
import type { Settings } from "./storage.js";
import { IS_CHROME, TARGET } from "./target.js";

export const BRIDGE_ALARM = "tabglutton-bridge-reconnect";

/**
 * How often we re-dial while idle. 30s is Chrome's documented alarm floor;
 * Firefox honours it exactly (measured on 153 — it fires on the half minute),
 * so a sidecar started mid-session is picked up within one period.
 */
const RECONNECT_PERIOD_MINUTES = 0.5;

export type BridgeStatus = "disabled" | "idle" | "connecting" | "connected";

export interface BridgeClientDeps {
  getSettings: () => Settings;
  /** Only ever called with a method that passed `isBridgeMethod`. */
  run: (method: BridgeMethod, params: unknown) => Promise<unknown>;
  onStatusChange: (status: BridgeStatus) => void;
}

type Phase = "closed" | "connecting" | "handshaking" | "open";

export class BridgeClient {
  private readonly deps: BridgeClientDeps;
  private socket: WebSocket | null = null;
  private phase: Phase = "closed";
  private clientNonce = "";
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  private label = IS_CHROME ? "Chrome" : "Firefox";

  constructor(deps: BridgeClientDeps) {
    this.deps = deps;
    // Registered in the constructor, which background.ts runs at module top
    // level: an MV3 service worker that restarts on an alarm must already have
    // the listener attached, so it cannot be deferred behind an await.
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === BRIDGE_ALARM) this.tick();
    });
  }

  /** Arm the reconnect alarm and make the first dial. Call once at startup. */
  async start(): Promise<void> {
    this.label = await resolveLabel();
    await this.syncAlarm();
    this.tick();
  }

  /**
   * The reconnect alarm exists only while the bridge is switched on. It is a
   * periodic wake, and on Chrome MV3 every wake cold-starts the service worker
   * and re-runs init — a default-off install must not pay that twice a minute
   * to rediscover that it has nothing to dial.
   */
  private async syncAlarm(): Promise<void> {
    if (this.isConfigured(this.deps.getSettings())) {
      browser.alarms.create(BRIDGE_ALARM, {
        delayInMinutes: RECONNECT_PERIOD_MINUTES,
        periodInMinutes: RECONNECT_PERIOD_MINUTES,
      });
    } else {
      await browser.alarms.clear(BRIDGE_ALARM);
    }
  }

  /** Re-evaluate after a settings change: connect, disconnect, or re-dial. */
  sync(): void {
    void this.syncAlarm();
    const settings = this.deps.getSettings();
    if (!this.isConfigured(settings)) {
      this.teardown();
      return;
    }
    // Port or token changed under an open socket — drop it and redial clean.
    if (this.phase !== "closed" && this.socket?.url !== this.socketUrl(settings)) {
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
      this.teardown();
      return;
    }
    if (this.phase !== "closed") return;
    this.connect(settings);
  }

  private connect(settings: Settings): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.socketUrl(settings));
    } catch (err) {
      console.warn("[tabglutton] bridge dial failed", err);
      return;
    }
    this.socket = socket;
    this.setPhase("connecting");

    socket.addEventListener("open", () => {
      // The server speaks first (challenge); we just arm a deadline.
      this.setPhase("handshaking");
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
        const token = this.deps.getSettings().bridgeToken;
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
        const token = this.deps.getSettings().bridgeToken;
        const expected = await deriveProof(token, this.clientNonce);
        if (!proofsMatch(msg.proof, expected)) {
          // Something is on our port that does not know the token. Do not talk to it.
          console.warn("[tabglutton] bridge server failed the token challenge");
          this.teardown();
          return;
        }
        this.clearHandshakeTimer();
        this.setPhase("open");
        this.startHeartbeat(socket);
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
      if (err instanceof BridgeRequestError) {
        return { type: "response", id, error: err.toBridgeError() };
      }
      console.warn("[tabglutton] bridge method threw", method, err);
      return {
        type: "response",
        id,
        error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private send(socket: WebSocket, msg: ClientMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  // Application-level ping (not a WebSocket control frame): on Chrome MV3 this
  // doubles as the service-worker keepalive, and control frames answered by the
  // browser itself would not extend the worker's lifetime.
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

  /** Drop the socket and report whatever the settings now imply — idle if the
   * bridge is still on and we should keep dialling, disabled if it is not. */
  private teardown(): void {
    this.stopHeartbeat();
    this.clearHandshakeTimer();
    const socket = this.socket;
    this.socket = null;
    this.phase = "closed";
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        // Already closing; nothing to do.
      }
    }
    this.deps.onStatusChange(this.status);
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
