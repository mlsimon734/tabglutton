// Hub/peer election, against real loopback sockets. Like hub.test.ts this is the
// deliberate exception to the pure-logic rule: the thing under test is which
// process ends up owning a port, and a fake cannot own one.

import { describe, test, expect, afterEach } from "bun:test";
import { BRIDGE_PROTO, deriveProof, randomNonce } from "../../src/bridge-protocol.js";
import { Supervisor, type BackendRole } from "../src/backend.js";
import { Hub } from "../src/hub.js";

const TOKEN = "peer-test-token";

const started: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (started.length) started.pop()?.stop();
});

function track<T extends { stop: () => void }>(thing: T): T {
  started.push(thing);
  return thing;
}

/** An ephemeral port that is free right now, by binding and releasing one. */
function freePort(): number {
  const probe = new Hub({ port: 0, token: TOKEN });
  probe.listen();
  const port = probe.port;
  probe.stop();
  return port;
}

async function supervisor(port: number): Promise<Supervisor> {
  // Zero connect wait: every expectation below either has a browser already
  // attached (instant regardless) or asserts the empty list.
  const s = track(new Supervisor({ port, token: TOKEN, connectWaitMs: 0 }));
  await s.start();
  return s;
}

async function autoSupervisor(
  candidates: readonly number[],
  token: string = TOKEN,
): Promise<Supervisor> {
  const s = track(new Supervisor({ candidates, token, connectWaitMs: 0 }));
  await s.start();
  return s;
}

/** A supervisor plus a way to await its next role, for the promotion test. */
async function watchedSupervisor(
  port: number,
): Promise<{ sup: Supervisor; awaitRole: (role: BackendRole) => Promise<void> }> {
  let current: BackendRole = "electing";
  const waiters: Array<{ role: BackendRole; resolve: () => void }> = [];
  const sup = track(
    new Supervisor({
      port,
      token: TOKEN,
      connectWaitMs: 0,
      onRoleChange: (role) => {
        current = role;
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]?.role === role) waiters.splice(i, 1)[0]?.resolve();
        }
      },
    }),
  );
  await sup.start();
  const awaitRole = (role: BackendRole): Promise<void> =>
    current === role
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`never became ${role}`)), 5_000);
          waiters.push({
            role,
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
          });
        });
  return { sup, awaitRole };
}

/** A browser that completes the handshake and answers one method with a fixed result. */
function fakeBrowser(port: number, answer: unknown, token: string = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Origin: "moz-extension://test" },
    });
    const nonce = randomNonce();
    ws.addEventListener("message", async (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "challenge") {
        ws.send(
          JSON.stringify({
            type: "hello",
            proto: BRIDGE_PROTO,
            browser: "firefox",
            extVersion: "test",
            label: "Zen",
            nonce,
            proof: await deriveProof(token, msg.nonce),
          }),
        );
      } else if (msg.type === "hello-ack") {
        resolve(ws);
      } else if (msg.type === "request") {
        ws.send(JSON.stringify({ type: "response", id: msg.id, result: answer }));
      }
    });
    ws.addEventListener("error", reject);
  });
}

describe("hub/peer election", () => {
  test("automatic sidecars racing at once converge on one hub", async () => {
    const candidates = [freePort(), freePort()];
    const [first, second] = await Promise.all([
      autoSupervisor(candidates),
      autoSupervisor(candidates),
    ]);
    const browser = await fakeBrowser(candidates[0] ?? 0, null);
    expect(await first.connections()).toHaveLength(1);
    expect(await second.connections()).toHaveLength(1);
    browser.close();
  });

  test("automatic discovery joins a later compatible hub before binding an earlier free port", async () => {
    const candidates = [freePort(), freePort()];
    const existing = track(new Hub({ port: candidates[1] ?? 0, token: TOKEN }));
    existing.listen();
    const discovered = await autoSupervisor(candidates);
    const browser = await fakeBrowser(candidates[1] ?? 0, null);
    expect(await discovered.connections()).toHaveLength(1);
    browser.close();
  });

  test("automatic discovery skips a markerless service and binds the next candidate", async () => {
    const candidates = [freePort(), freePort()];
    let websocketUpgrades = 0;
    const foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: candidates[0] ?? 0,
      fetch: (request) => {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") websocketUpgrades += 1;
        return new Response("not gullet");
      },
    });
    started.push({ stop: () => foreign.stop(true) });
    const sup = await autoSupervisor(candidates);
    const browser = await fakeBrowser(candidates[1] ?? 0, null);
    expect(await sup.connections()).toHaveLength(1);
    expect(websocketUpgrades).toBe(0);
    browser.close();
  });

  test("different tokens settle into separate automatic realms", async () => {
    const candidates = [freePort(), freePort()];
    const first = await autoSupervisor(candidates, "realm-a");
    const second = await autoSupervisor(candidates, "realm-b");
    const browserA = await fakeBrowser(candidates[0] ?? 0, null, "realm-a");
    const browserB = await fakeBrowser(candidates[1] ?? 0, null, "realm-b");
    expect(await first.connections()).toHaveLength(1);
    expect(await second.connections()).toHaveLength(1);
    browserA.close();
    browserB.close();
  });

  test("the first sidecar binds the port and serves as the hub", async () => {
    const port = freePort();
    const first = await supervisor(port);
    expect(await first.connections()).toEqual([]);
  });

  test("a second sidecar attaches instead of dying, and sees the hub's browser", async () => {
    const port = freePort();
    await supervisor(port);
    const peer = await supervisor(port);
    const browser = await fakeBrowser(port, null);

    // The peer has no socket to the browser at all — this can only have come
    // through the hub.
    const seen = await peer.connections();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.label).toBe("Zen");
    browser.close();
  });

  test("a peer's tool call is proxied to the browser and the answer relayed back", async () => {
    const port = freePort();
    await supervisor(port);
    const peer = await supervisor(port);
    const browser = await fakeBrowser(port, { tabs: [{ id: 7 }] });

    const [conn] = await peer.connections();
    const result = await peer.request(conn?.connectionId ?? "", "tabs_list", {});
    expect(result).toEqual({ tabs: [{ id: 7 }] });
    browser.close();
  });

  test("many sidecars coexist — exactly one hub, the rest attached", async () => {
    const port = freePort();
    const all = [await supervisor(port), await supervisor(port), await supervisor(port)];
    const browser = await fakeBrowser(port, null);
    // Every one of them can see the browser, which is the whole requirement:
    // opening a second agent session must not break the first.
    for (const s of all) expect(await s.connections()).toHaveLength(1);
    browser.close();
  });

  test("a peer promotes itself when the hub exits, so the port is never orphaned", async () => {
    const port = freePort();
    const hub = await supervisor(port);
    const { sup: peer, awaitRole } = await watchedSupervisor(port);

    hub.stop();
    // The peer sees its socket close, re-races, and wins uncontested. Waiting on
    // the role rather than a sleep: promotion is only complete once it has bound.
    await awaitRole("hub");

    // A browser can now dial the port again, which is only possible if the
    // promoted peer really did bind it — the session that outlived the original
    // hub keeps working instead of being stranded.
    const browser = await fakeBrowser(port, null);
    expect(await peer.connections()).toHaveLength(1);
    browser.close();
  });

  // The election used to loop until it won, and `main` awaits it before
  // `serveStdio` — so a port held by something that will never authenticate meant
  // the MCP server never answered `initialize` at all, and the startup-fault path
  // written for exactly this case could not be reached.
  test("a port held under another token settles instead of hanging", async () => {
    const port = freePort();
    const stranger = track(new Hub({ port, token: "some-other-token" }));
    stranger.listen();

    const sup = track(new Supervisor({ port, token: TOKEN, startTimeoutMs: 300 }));
    await expect(sup.start()).rejects.toThrow(String(port));
    // Published, not just thrown: tool calls read this per call, so they answer
    // with the reason rather than waiting on an election with nothing to win.
    expect(sup.fault()?.code).toBe("unsupported");
  });

  test("a fault clears once the port frees up, without a restart", async () => {
    const port = freePort();
    const stranger = track(new Hub({ port, token: "some-other-token" }));
    stranger.listen();

    const sup = track(
      new Supervisor({ port, token: TOKEN, startTimeoutMs: 300, connectWaitMs: 0 }),
    );
    await expect(sup.start()).rejects.toThrow();
    stranger.stop();

    // The election kept running underneath; agent sessions outlive the conflict
    // that stranded them, so giving up on waiting must not mean giving up.
    for (let i = 0; i < 50 && sup.fault() !== null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sup.fault()).toBeNull();
    expect(await sup.connections()).toEqual([]);
  }, 10_000);

  test("automatic exhaustion heals when any candidate becomes free", async () => {
    const candidates = [freePort(), freePort()];
    const strangers = candidates.map((port, index) =>
      track(new Hub({ port, token: `other-realm-${index}` })),
    );
    for (const stranger of strangers) stranger.listen();

    const sup = track(
      new Supervisor({ candidates, token: TOKEN, startTimeoutMs: 300, connectWaitMs: 0 }),
    );
    await expect(sup.start()).rejects.toThrow();
    strangers[1]?.stop();

    for (let i = 0; i < 50 && sup.fault() !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(sup.fault()).toBeNull();
    const browser = await fakeBrowser(candidates[1] ?? 0, null);
    expect(await sup.connections()).toHaveLength(1);
    browser.close();
  }, 10_000);

  test("an attached peer is not offered to tools as a browser", async () => {
    const port = freePort();
    const hub = await supervisor(port);
    await supervisor(port);
    // Two sidecars, no browser: a peer must never be mistaken for a target,
    // or tab calls would be routed at another sidecar.
    expect(await hub.connections()).toEqual([]);
  });
});
