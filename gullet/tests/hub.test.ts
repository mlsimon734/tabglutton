// End-to-end over a real loopback socket: handshake, auth, and request routing.
// The "extension" here is a bare WebSocket client speaking bridge-protocol.

import { describe, test, expect, afterEach } from "bun:test";
import {
  BRIDGE_PROBE_HEADER,
  BRIDGE_PROBE_MARKER,
  BRIDGE_PROTO,
  BridgeRequestError,
  deriveProof,
  parseMessage,
  proofsMatch,
  randomNonce,
  RETIRING_FOR_NEWER_PEER,
  type BridgeMessage,
  type ProofRole,
} from "../../src/bridge-protocol.js";
import { Hub, isExtensionOrigin } from "../src/hub.js";
import { EXT_VERSION } from "./fixtures.js";

const TOKEN = "test-token";
const EXTENSION_ORIGIN = "moz-extension://11111111-2222-3333-4444-555555555555";

let hub: Hub | null = null;
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  hub?.stop();
  hub = null;
});

function startHub(token = TOKEN, handshakeTimeoutMs?: number): Hub {
  const created = new Hub({
    port: 0,
    token,
    ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
  });
  created.listen();
  hub = created;
  return created;
}

/** A minimal stand-in for the extension's bridge client. */
class FakeExtension {
  readonly socket: WebSocket;
  /** Kept because protocol 3 binds every proof to the port it is presented at. */
  readonly port: number;
  private readonly queue: BridgeMessage[] = [];
  private waiter: ((msg: BridgeMessage) => void) | null = null;

  constructor(port: number, origin: string = EXTENSION_ORIGIN) {
    this.port = port;
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
    sockets.push(this.socket);
    this.socket.addEventListener("message", (event) => {
      const msg = parseMessage(String(event.data));
      if (!msg) return;
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  next(): Promise<BridgeMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** A proof bound to this client's channel — see deriveProof's `role`/`port`. */
  proofFor(nonce: string, role: ProofRole, token = TOKEN): Promise<string> {
    return deriveProof(token, nonce, role, this.port);
  }

  /** Answer the challenge and verify the server's counter-proof. */
  async handshake(token = TOKEN, proto = BRIDGE_PROTO): Promise<string> {
    const challenge = await this.next();
    if (challenge.type !== "challenge")
      throw new Error(`expected challenge, got ${challenge.type}`);
    const nonce = randomNonce();
    this.send({
      type: "hello",
      proto,
      browser: "firefox",
      extVersion: EXT_VERSION,
      label: "Zen",
      nonce,
      proof: await this.proofFor(challenge.nonce, "browser", token),
    });
    const ack = await this.next();
    if (ack.type !== "hello-ack") throw new Error(`expected hello-ack, got ${ack.type}`);
    if (!proofsMatch(ack.proof, await this.proofFor(nonce, "server"))) {
      throw new Error("server failed the counter-challenge");
    }
    return ack.connectionId;
  }
}

describe("isExtensionOrigin()", () => {
  test("accepts Firefox and Chrome extension origins", () => {
    expect(isExtensionOrigin("moz-extension://abc")).toBe(true);
    expect(isExtensionOrigin("chrome-extension://abc")).toBe(true);
  });

  test("rejects web pages, which is the realistic attacker", () => {
    expect(isExtensionOrigin("https://evil.example")).toBe(false);
    expect(isExtensionOrigin("http://localhost:3000")).toBe(false);
    expect(isExtensionOrigin("null")).toBe(false);
  });

  test("rejects a missing origin", () => {
    expect(isExtensionOrigin(null)).toBe(false);
    expect(isExtensionOrigin("")).toBe(false);
  });
});

describe("upgrade gate", () => {
  test("a request without an extension origin gets 403", async () => {
    const started = startHub();
    const res = await fetch(`http://127.0.0.1:${started.port}/`);
    expect(res.status).toBe(403);
  });

  test("an extension-origin request that is not an upgrade gets 426", async () => {
    const started = startHub();
    const res = await fetch(`http://127.0.0.1:${started.port}/`, {
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(res.status).toBe(426);
  });
});

// The probe's whole job is telling "Gullet is here" from "a stranger owns this
// port". Both are refusals with an HTTP status, so the status cannot carry it —
// only the marker can, and it has to survive on both refusal paths.
describe("probe identification", () => {
  test("the 403 a probe actually receives identifies Gullet", async () => {
    const started = startHub();
    // No Origin: exactly what the extension's background fetch sends.
    const res = await fetch(`http://127.0.0.1:${started.port}/`);
    expect(res.status).toBe(403);
    expect(res.headers.get(BRIDGE_PROBE_HEADER)).toBe(String(BRIDGE_PROTO));
    expect((await res.text()).startsWith(BRIDGE_PROBE_MARKER)).toBe(true);
  });

  test("the 426 path identifies Gullet too", async () => {
    const started = startHub();
    const res = await fetch(`http://127.0.0.1:${started.port}/`, {
      headers: { Origin: EXTENSION_ORIGIN },
    });
    expect(res.headers.get(BRIDGE_PROBE_HEADER)).toBe(String(BRIDGE_PROTO));
    expect((await res.text()).startsWith(BRIDGE_PROBE_MARKER)).toBe(true);
  });

  test("the marker is the body's prefix, so a bounded read finds it", async () => {
    // bridge-client reads only the first chunk — a stranger may answer with
    // megabytes — so a marker buried later in the body would never be seen.
    const started = startHub();
    const res = await fetch(`http://127.0.0.1:${started.port}/`);
    const head = (await res.text()).slice(0, 128);
    expect(head.startsWith(BRIDGE_PROBE_MARKER)).toBe(true);
  });

  test("no CORS header is offered, so a web page still cannot read the marker", async () => {
    const started = startHub();
    const res = await fetch(`http://127.0.0.1:${started.port}/`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-expose-headers")).toBeNull();
  });
});

describe("handshake", () => {
  test("a correct token registers the connection with its self-reported label", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const connectionId = await ext.handshake();
    expect(started.summaries()).toEqual([
      { connectionId, browser: "firefox", label: "Zen", extVersion: EXT_VERSION },
    ]);
  });

  test("the token itself never crosses the wire", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const challenge = await ext.next();
    expect(JSON.stringify(challenge)).not.toContain(TOKEN);
    const nonce = randomNonce();
    ext.send({
      type: "hello",
      proto: BRIDGE_PROTO,
      browser: "firefox",
      extVersion: EXT_VERSION,
      label: "Zen",
      nonce,
      proof: await ext.proofFor((challenge as { nonce: string }).nonce, "browser"),
    });
    expect(JSON.stringify(await ext.next())).not.toContain(TOKEN);
  });

  test("a wrong token is refused and never registers", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const challenge = await ext.next();
    ext.send({
      type: "hello",
      proto: BRIDGE_PROTO,
      browser: "firefox",
      extVersion: EXT_VERSION,
      label: "Zen",
      nonce: randomNonce(),
      proof: await ext.proofFor((challenge as { nonce: string }).nonce, "browser", "wrong-token"),
    });
    const reply = await ext.next();
    expect(reply).toMatchObject({ type: "hello-error", error: { code: "unauthorized" } });
    expect(started.summaries()).toEqual([]);
  });

  test("a hub with no token configured refuses every browser", async () => {
    const started = startHub("");
    const ext = new FakeExtension(started.port);
    const challenge = await ext.next();
    ext.send({
      type: "hello",
      proto: BRIDGE_PROTO,
      browser: "firefox",
      extVersion: EXT_VERSION,
      label: "Zen",
      nonce: randomNonce(),
      proof: await ext.proofFor((challenge as { nonce: string }).nonce, "browser", ""),
    });
    expect(await ext.next()).toMatchObject({
      type: "hello-error",
      error: { code: "unauthorized" },
    });
  });

  test("a protocol mismatch is reported instead of half-working", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const challenge = await ext.next();
    ext.send({
      type: "hello",
      proto: BRIDGE_PROTO + 1,
      browser: "firefox",
      extVersion: "9.9.9",
      label: "Zen",
      nonce: randomNonce(),
      proof: await ext.proofFor((challenge as { nonce: string }).nonce, "browser"),
    });
    expect(await ext.next()).toMatchObject({ type: "hello-error", error: { code: "unsupported" } });
  });

  test("methods are not served before the handshake completes", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    await ext.next(); // challenge
    expect(started.summaries()).toEqual([]);
    await expect(started.request("conn-1", "tabs_list", {})).rejects.toMatchObject({
      code: "no-connection",
    });
  });
});

describe("request routing", () => {
  test("a method call reaches the browser and its result comes back", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const connectionId = await ext.handshake();

    const pending = started.request(connectionId, "tabs_list", { scope: "all" });
    const req = await ext.next();
    expect(req).toMatchObject({ type: "request", method: "tabs_list", params: { scope: "all" } });
    ext.send({ type: "response", id: (req as { id: string }).id, result: { tabs: [{ id: 1 }] } });

    expect(await pending).toEqual({ tabs: [{ id: 1 }] });
  });

  test("an error response rejects with the browser's own code", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const connectionId = await ext.handshake();

    const pending = started.request(connectionId, "tab_read", { tabId: 5 });
    const req = await ext.next();
    ext.send({
      type: "response",
      id: (req as { id: string }).id,
      error: { code: "tab-discarded", message: "unloaded" },
    });

    await expect(pending).rejects.toBeInstanceOf(BridgeRequestError);
    await expect(pending).rejects.toMatchObject({ code: "tab-discarded", message: "unloaded" });
  });

  test("concurrent calls are matched by id, not by arrival order", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const connectionId = await ext.handshake();

    const first = started.request(connectionId, "tab_read", { tabId: 1 });
    const second = started.request(connectionId, "tab_read", { tabId: 2 });
    const reqA = (await ext.next()) as { id: string; params: { tabId: number } };
    const reqB = (await ext.next()) as { id: string; params: { tabId: number } };

    // Answer out of order.
    ext.send({ type: "response", id: reqB.id, result: { tabId: reqB.params.tabId } });
    ext.send({ type: "response", id: reqA.id, result: { tabId: reqA.params.tabId } });

    expect(await first).toEqual({ tabId: 1 });
    expect(await second).toEqual({ tabId: 2 });
  });

  test("a heartbeat ping from the browser is answered", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    await ext.handshake();
    ext.send({ type: "ping", t: 42 });
    expect(await ext.next()).toEqual({ type: "pong", t: 42 });
  });

  test("a disconnect rejects in-flight requests instead of hanging", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const connectionId = await ext.handshake();

    const pending = started.request(connectionId, "tabs_list", {});
    await ext.next();
    ext.socket.close();

    await expect(pending).rejects.toMatchObject({ code: "no-connection" });
  });

  test("closing a connection removes it from the registry", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    await ext.handshake();
    expect(started.summaries()).toHaveLength(1);

    ext.socket.close();
    await Bun.sleep(50);
    expect(started.summaries()).toEqual([]);
  });

  test("two browsers get distinct connection ids", async () => {
    const started = startHub();
    const a = new FakeExtension(started.port);
    const idA = await a.handshake();
    const b = new FakeExtension(started.port);
    const idB = await b.handshake();

    expect(idA).not.toBe(idB);
    expect(
      started
        .summaries()
        .map((s) => s.connectionId)
        .sort(),
    ).toEqual([idA, idB].sort());
  });
});

// The extension is not continuously connected: its background page is suspended
// whenever no agent is using the bridge, which destroys the socket, and it only
// redials when its alarm fires. Waiting out one reconnect period is what turns
// that from a spurious "no browser is connected" into a slow first call.
describe("connectionsWithin", () => {
  test("returns at once when a browser is already connected", async () => {
    const started = startHub();
    const ext = new FakeExtension(started.port);
    const connectionId = await ext.handshake();

    const begin = performance.now();
    const summaries = await started.connectionsWithin(5_000);
    expect(performance.now() - begin).toBeLessThan(250);
    expect(summaries.map((s) => s.connectionId)).toEqual([connectionId]);
  });

  test("resolves as soon as a browser dials in mid-wait", async () => {
    const started = startHub();
    const waiting = started.connectionsWithin(5_000);
    await Bun.sleep(50);

    const ext = new FakeExtension(started.port);
    const connectionId = await ext.handshake();
    expect((await waiting).map((s) => s.connectionId)).toEqual([connectionId]);
  });

  // A socket that cannot prove the token is not a browser we can serve, so
  // releasing the wait on `open` would hand back an empty list for no reason.
  test("an unauthenticated socket does not end the wait", async () => {
    const started = startHub();
    const waiting = started.connectionsWithin(400);
    const ext = new FakeExtension(started.port);
    await ext.next(); // challenge, never answered
    expect(await waiting).toEqual([]);
  });

  test("gives up after the timeout rather than hanging the tool call", async () => {
    const started = startHub();
    const begin = performance.now();
    expect(await started.connectionsWithin(300)).toEqual([]);
    expect(performance.now() - begin).toBeGreaterThanOrEqual(250);
  });

  test("shutdown releases a pending wait", async () => {
    const started = startHub();
    const waiting = started.connectionsWithin(30_000);
    started.stop();
    expect(await waiting).toEqual([]);
  });
});

describe("unauthenticated sockets", () => {
  test("a socket that never proves the token is reaped", async () => {
    // Untracked is not the same as bounded: without a reaper, a local process
    // opening sockets and ignoring the challenge accumulates them for the life
    // of the sidecar.
    const h = startHub(TOKEN, 60);
    const ext = new FakeExtension(h.port);
    expect((await ext.next()).type).toBe("challenge");

    const closed = new Promise<number>((resolve) => {
      ext.socket.addEventListener("close", (event) => resolve(event.code));
    });
    await closed;
    expect(h.summaries()).toEqual([]);
  });

  test("proving the token disarms the reaper", async () => {
    const h = startHub(TOKEN, 60);
    const ext = new FakeExtension(h.port);
    await ext.handshake(TOKEN);
    // Well past the deadline: a connection that authenticated must survive it.
    await Bun.sleep(150);
    expect(h.summaries()).toHaveLength(1);
    expect(ext.socket.readyState).toBe(WebSocket.OPEN);
  });
});

/**
 * The count that replaced "a live socket means somebody is waiting".
 *
 * That inference held only while every hub died with the agent session that
 * spawned it. A detached one does not, so the extension needs to be told — and
 * being told wrong is expensive in both directions: too high pins a browser's
 * background page awake around the clock for nobody, too low lets it suspend out
 * from under a session's first call.
 */
describe("session accounting", () => {
  function startDetachedHub(version = "1.0.0"): Hub {
    const created = new Hub({ port: 0, token: TOKEN, detached: true, version });
    created.listen();
    hub = created;
    return created;
  }

  /** A sidecar attaching as a peer, which is what a session *is* to a hub. */
  async function attachPeer(port: number, version?: string): Promise<FakeExtension> {
    const peer = new FakeExtension(port, "moz-extension://gullet-peer");
    const challenge = await peer.next();
    if (challenge.type !== "challenge")
      throw new Error(`expected challenge, got ${challenge.type}`);
    peer.send({
      type: "hello",
      proto: BRIDGE_PROTO,
      browser: "firefox",
      extVersion: "peer",
      label: "peer",
      role: "peer",
      ...(version === undefined ? {} : { gullet: version }),
      nonce: randomNonce(),
      proof: await peer.proofFor(challenge.nonce, "peer"),
    });
    return peer;
  }

  test("a session-scoped hub counts itself, because its life is the session's", async () => {
    const h = startHub();
    const ext = new FakeExtension(h.port);
    await ext.handshake();
    expect(h.sessions).toBe(1);
  });

  test("a detached hub counts nothing until a session attaches", async () => {
    const h = startDetachedHub();
    expect(h.sessions).toBe(0);
    const peer = await attachPeer(h.port);
    await peer.next(); // hello-ack
    expect(h.sessions).toBe(1);
  });

  test("the count rides the hello-ack, so a browser reconnecting mid-session learns it", async () => {
    const h = startDetachedHub();
    const first = await attachPeer(h.port);
    await first.next();

    // The browser was not connected when the session started — the ordinary case
    // for a detached hub, whose browser suspends and redials all day.
    const ext = new FakeExtension(h.port);
    const challenge = await ext.next();
    if (challenge.type !== "challenge") throw new Error("expected challenge");
    const nonce = randomNonce();
    ext.send({
      type: "hello",
      proto: BRIDGE_PROTO,
      browser: "firefox",
      extVersion: EXT_VERSION,
      label: "Zen",
      nonce,
      proof: await ext.proofFor(challenge.nonce, "browser"),
    });
    const ack = await ext.next();
    expect(ack.type).toBe("hello-ack");
    expect(ack.type === "hello-ack" ? ack.sessions : undefined).toBe(1);
  });

  test("a connected browser is told when a session arrives and when the last one leaves", async () => {
    const h = startDetachedHub();
    const ext = new FakeExtension(h.port);
    await ext.handshake();

    // Skipping pings rather than asserting their absence: a session arriving is
    // exactly when the hub re-checks the connections it has been holding at the
    // slow idle cadence, so a beat between these two is correct behaviour.
    const nextSessions = async (): Promise<BridgeMessage> => {
      for (;;) {
        const msg = await ext.next();
        if (msg.type !== "ping") return msg;
      }
    };

    const peer = await attachPeer(h.port);
    await peer.next();
    expect(await nextSessions()).toEqual({ type: "sessions", count: 1 });

    peer.socket.close();
    expect(await nextSessions()).toEqual({ type: "sessions", count: 0 });
  });

  // Version skew only became reachable when hubs started outliving sessions: an
  // upgrade leaves the old one holding the port, and every arriving session
  // resets its idle clock, so nothing else would ever move it.
  test("a detached hub stands aside for a newer sidecar", async () => {
    const h = startDetachedHub("1.0.0");
    const peer = await attachPeer(h.port, "1.0.1");
    const answer = await peer.next();
    expect(answer.type).toBe("hello-error");
    expect(answer.type === "hello-error" ? answer.error.message : "").toContain(
      RETIRING_FOR_NEWER_PEER,
    );
    // Retiring means releasing the port, not merely refusing: the peer's next
    // move is to re-race for it, and a hub still bound would send it straight
    // back into the loop it just escaped.
    await Bun.sleep(50);
    expect(await fetch(`http://127.0.0.1:${h.port}/`).catch(() => null)).toBeNull();
  });

  test("an older or equal sidecar attaches normally", async () => {
    const h = startDetachedHub("1.0.0");
    const same = await attachPeer(h.port, "1.0.0");
    expect((await same.next()).type).toBe("hello-ack");
    const older = await attachPeer(h.port, "0.9.9");
    expect((await older.next()).type).toBe("hello-ack");
    expect(h.sessions).toBe(2);
  });

  // Asking "are you mine?" must not make the asker a session. A real attachment
  // would broadcast `sessions: 1` and then `0` to every connected browser, and a
  // browser whose socket dropped between those two frames would hold its page
  // awake for a hub serving nobody — while every check reset the hub's own idle
  // clock, so visitors alone could keep an abandoned hub alive.
  test("a probe proves the realm without being counted as a session", async () => {
    const h = startDetachedHub();
    const probe = new FakeExtension(h.port, "moz-extension://gullet-peer");
    const challenge = await probe.next();
    if (challenge.type !== "challenge") throw new Error("expected challenge");
    const nonce = randomNonce();
    probe.send({
      type: "hello",
      proto: BRIDGE_PROTO,
      browser: "firefox",
      extVersion: "peer",
      label: "peer",
      role: "probe",
      gullet: "1.0.0",
      nonce,
      proof: await probe.proofFor(challenge.nonce, "probe"),
    });

    // The proof still comes back both ways — this is a realm check, not a peek.
    const ack = await probe.next();
    expect(ack.type).toBe("hello-ack");
    if (ack.type !== "hello-ack") throw new Error("unreachable");
    expect(proofsMatch(ack.proof, await probe.proofFor(nonce, "server"))).toBe(true);
    expect(h.sessions).toBe(0);

    // The asker closes; the hub's own close is a backstop that must not race the
    // ack it just sent, or the realm check reports "not mine" about a hub that is.
    probe.socket.close();
    await Bun.sleep(50);
    expect(h.sessions).toBe(0);
  });

  test("a probe that never closes is reaped rather than held forever", async () => {
    const h = new Hub({ port: 0, token: TOKEN, detached: true, handshakeTimeoutMs: 60 });
    h.listen();
    hub = h;
    const probe = new FakeExtension(h.port, "moz-extension://gullet-peer");
    const challenge = await probe.next();
    if (challenge.type !== "challenge") throw new Error("expected challenge");
    probe.send({
      type: "hello",
      proto: BRIDGE_PROTO,
      browser: "firefox",
      extVersion: "peer",
      label: "peer",
      role: "probe",
      nonce: randomNonce(),
      proof: await probe.proofFor(challenge.nonce, "probe"),
    });
    expect((await probe.next()).type).toBe("hello-ack");
    const closed = new Promise<void>((resolve) => {
      probe.socket.addEventListener("close", () => resolve());
    });
    await closed;
    expect(h.sessions).toBe(0);
  });

  test("a probe from a newer sidecar still retires an outdated hub", async () => {
    // Otherwise an upgrade would replace a stale hub only when a session
    // attached, never when the newly spawned hub merely looked first — which is
    // the order that actually happens.
    const h = startDetachedHub("1.0.0");
    const probe = new FakeExtension(h.port, "moz-extension://gullet-peer");
    const challenge = await probe.next();
    if (challenge.type !== "challenge") throw new Error("expected challenge");
    probe.send({
      type: "hello",
      proto: BRIDGE_PROTO,
      browser: "firefox",
      extVersion: "peer",
      label: "peer",
      role: "probe",
      gullet: "2.0.0",
      nonce: randomNonce(),
      proof: await probe.proofFor(challenge.nonce, "probe"),
    });
    const answer = await probe.next();
    expect(answer.type).toBe("hello-error");
    expect(answer.type === "hello-error" ? answer.error.message : "").toContain(
      RETIRING_FOR_NEWER_PEER,
    );
  });

  test("a session-scoped hub never retires, however new the peer", async () => {
    // It would take its own agent session down with it, which is strictly worse
    // than serving one version-old peer for a few minutes.
    const h = new Hub({ port: 0, token: TOKEN, version: "1.0.0" });
    h.listen();
    hub = h;
    const peer = await attachPeer(h.port, "99.0.0");
    expect((await peer.next()).type).toBe("hello-ack");
  });
});
