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
  const s = track(new Supervisor({ port, token: TOKEN }));
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
function fakeBrowser(port: number, answer: unknown): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Origin: "moz-extension://test" },
    } as unknown as string[]);
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
            proof: await deriveProof(TOKEN, msg.nonce),
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
  test("the first sidecar binds the port and serves as the hub", async () => {
    const port = freePort();
    const first = await supervisor(port);
    expect(await first.connections(0)).toEqual([]);
  });

  test("a second sidecar attaches instead of dying, and sees the hub's browser", async () => {
    const port = freePort();
    await supervisor(port);
    const peer = await supervisor(port);
    const browser = await fakeBrowser(port, null);

    // The peer has no socket to the browser at all — this can only have come
    // through the hub.
    const seen = await peer.connections(1_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.label).toBe("Zen");
    browser.close();
  });

  test("a peer's tool call is proxied to the browser and the answer relayed back", async () => {
    const port = freePort();
    await supervisor(port);
    const peer = await supervisor(port);
    const browser = await fakeBrowser(port, { tabs: [{ id: 7 }] });

    const [conn] = await peer.connections(1_000);
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
    for (const s of all) expect(await s.connections(1_000)).toHaveLength(1);
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
    expect(await peer.connections(2_000)).toHaveLength(1);
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
    await expect(sup.start()).rejects.toThrow(/127\.0\.0\.1:/);
    // Published, not just thrown: tool calls read this per call, so they answer
    // with the reason rather than waiting on an election with nothing to win.
    expect(sup.fault()?.code).toBe("unsupported");
  });

  test("a fault clears once the port frees up, without a restart", async () => {
    const port = freePort();
    const stranger = track(new Hub({ port, token: "some-other-token" }));
    stranger.listen();

    const sup = track(new Supervisor({ port, token: TOKEN, startTimeoutMs: 300 }));
    await expect(sup.start()).rejects.toThrow();
    stranger.stop();

    // The election kept running underneath; agent sessions outlive the conflict
    // that stranded them, so giving up on waiting must not mean giving up.
    for (let i = 0; i < 50 && sup.fault() !== null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sup.fault()).toBeNull();
    expect(await sup.connections(0)).toEqual([]);
  }, 10_000);

  test("an attached peer is not offered to tools as a browser", async () => {
    const port = freePort();
    const hub = await supervisor(port);
    await supervisor(port);
    // Two sidecars, no browser: a peer must never be mistaken for a target,
    // or tab calls would be routed at another sidecar.
    expect(await hub.connections(0)).toEqual([]);
  });
});
