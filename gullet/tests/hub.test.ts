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
  type BridgeMessage,
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
  private readonly queue: BridgeMessage[] = [];
  private waiter: ((msg: BridgeMessage) => void) | null = null;

  constructor(port: number, origin: string = EXTENSION_ORIGIN) {
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
      proof: await deriveProof(token, challenge.nonce),
    });
    const ack = await this.next();
    if (ack.type !== "hello-ack") throw new Error(`expected hello-ack, got ${ack.type}`);
    if (!proofsMatch(ack.proof, await deriveProof(TOKEN, nonce))) {
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
      proof: await deriveProof(TOKEN, (challenge as { nonce: string }).nonce),
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
      proof: await deriveProof("wrong-token", (challenge as { nonce: string }).nonce),
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
      proof: await deriveProof("", (challenge as { nonce: string }).nonce),
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
      proof: await deriveProof(TOKEN, (challenge as { nonce: string }).nonce),
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
