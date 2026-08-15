// The hub that outlives its session.
//
// Most of this runs the hub in-process with an injected exit, which is enough
// for the lifecycle rules. The last test does not: it spawns the real thing and
// kills its parent, because "the child survives" is a claim about Bun and macOS
// or Linux, not about this code, and it is the single assumption the whole
// feature rests on.

import { describe, test, expect, afterEach } from "bun:test";
import {
  BRIDGE_PROTO,
  compareGulletVersions,
  deriveProof,
  randomNonce,
} from "../../src/bridge-protocol.js";
import { detachedHubArgv, detachedHubLogPath, runDetachedHub } from "../src/detached.js";
import { Hub } from "../src/hub.js";
import { probeCandidate } from "../src/probe.js";

const TOKEN = "detached-test-token";

const started: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (started.length) started.pop()?.stop();
});

/** An ephemeral port that is free right now, by binding and releasing one. */
function freePort(): number {
  const probe = new Hub({ port: 0, token: TOKEN });
  probe.listen();
  const port = probe.port;
  probe.stop();
  return port;
}

/** A sidecar attaching as a peer — which is what an agent session is to a hub. */
async function attachPeer(port: number, version?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Origin: "moz-extension://gullet-peer" },
    });
    ws.addEventListener("message", async (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "challenge") {
        ws.send(
          JSON.stringify({
            type: "hello",
            proto: BRIDGE_PROTO,
            browser: "firefox",
            extVersion: "peer",
            label: "peer",
            role: "peer",
            ...(version === undefined ? {} : { gullet: version }),
            nonce: randomNonce(),
            proof: await deriveProof(TOKEN, msg.nonce),
          }),
        );
      } else if (msg.type === "hello-ack") {
        resolve(ws);
      } else if (msg.type === "hello-error") {
        reject(new Error(msg.error.message));
      }
    });
    ws.addEventListener("error", reject);
  });
}

describe("compareGulletVersions()", () => {
  test("orders by numeric component, not string", () => {
    expect(compareGulletVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareGulletVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareGulletVersions("0.3.1", "0.3.1")).toBe(0);
  });

  test("a missing trailing component is zero, not absent", () => {
    expect(compareGulletVersions("1.2", "1.2.0")).toBe(0);
    expect(compareGulletVersions("1.2", "1.2.1")).toBe(-1);
  });

  test("a signed dev build's fourth component outranks the release it came from", () => {
    expect(compareGulletVersions("0.3.1.4", "0.3.1")).toBe(1);
  });

  // Unreadable never *wins*, so a hub is never retired by a peer whose version
  // we could not parse — the safe direction for a rule that shuts a hub down.
  // Coercing the unreadable part to zero is the trap: it makes a prerelease look
  // like a fourth component and outrank the release.
  test("an unreadable version compares as equal rather than being coerced", () => {
    expect(compareGulletVersions("1.0.0-beta.2", "1.0.0")).toBe(0);
    expect(compareGulletVersions("1.0.0", "1.0.0-beta.2")).toBe(0);
    expect(compareGulletVersions("nonsense", "0.0.1")).toBe(0);
  });
});

describe("detachedHubArgv()", () => {
  test("runs the same entry under the same runtime, and never carries the token", () => {
    const argv = detachedHubArgv("/opt/bun", "/pkg/dist/gullet.js");
    expect(argv).toEqual(["/opt/bun", "/pkg/dist/gullet.js", "--detached-hub"]);
    // argv is world-readable through `ps`, and this token is the entirety of the
    // bridge's authentication. It goes over stdin instead.
    expect(argv.join(" ")).not.toContain(TOKEN);
  });

  test("passes a fixed port through, and omits it in automatic mode", () => {
    expect(detachedHubArgv("bun", "g.js", 4589)).toContain("--port");
    expect(detachedHubArgv("bun", "g.js", 4589)).toContain("4589");
    expect(detachedHubArgv("bun", "g.js")).not.toContain("--port");
  });
});

describe("detachedHubLogPath()", () => {
  test("is a log under the XDG state directory, not the config one", () => {
    expect(detachedHubLogPath({ HOME: "/home/m" })).toBe("/home/m/.local/state/tabglutton/hub.log");
    expect(detachedHubLogPath({ HOME: "/home/m", XDG_STATE_HOME: "/var/state" })).toBe(
      "/var/state/tabglutton/hub.log",
    );
  });
});

describe("runDetachedHub()", () => {
  test("binds a candidate and keeps serving", async () => {
    const port = freePort();
    const exited = { code: null as number | null };
    void runDetachedHub({
      token: TOKEN,
      port,
      version: "1.0.0",
      exit: (code) => {
        exited.code = code;
      },
      onListening: (h) => started.push(h),
    });
    await Bun.sleep(50);
    expect(await probeCandidate(port)).toBe("compatible");
    // The one thing a hub must not do is return. Its entry point is
    // `process.exit(await main(...))`.
    expect(exited.code).toBeNull();
    await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
  });

  test("exits rather than competing when a compatible hub already holds the port", async () => {
    const port = freePort();
    const incumbent = new Hub({ port, token: TOKEN });
    incumbent.listen();
    started.push(incumbent);

    // This is what settles two sessions spawning a hub at the same moment: both
    // children start, one binds, the other finds it and goes away. A *session*
    // that meets a hub attaches to it; a detached hub has nothing to offer one.
    const code = await runDetachedHub({ token: TOKEN, port, version: "1.0.0", exit: () => {} });
    expect(code).toBe(0);
    // The incumbent is untouched: still holding the port, and back to its own
    // single session — the realm check attaches briefly and must not leave a
    // session behind it, or a hub could be held awake by its own visitors.
    await Bun.sleep(50);
    expect(await probeCandidate(port)).toBe("compatible");
    expect(incumbent.sessions).toBe(1);
  });

  // The probe identifies Gullet and its protocol, which is all it may do — a
  // markerless service must never be handed a token proof. But "a Gullet" is not
  // "our Gullet", and standing aside for a rival realm would leave the second
  // token realm on a machine silently without a detached hub, with nothing in
  // any log saying why.
  test("does not stand aside for a Gullet in another token realm", async () => {
    const port = freePort();
    const stranger = new Hub({ port: freePort(), token: "some-other-realm" });
    stranger.listen();
    started.push(stranger);

    const exited = { code: null as number | null };
    void runDetachedHub({
      token: TOKEN,
      // The rival sits on an earlier candidate than the one we should end up on.
      candidates: [stranger.port, port],
      version: "1.0.0",
      exit: (code) => {
        exited.code = code;
      },
      onListening: (h) => started.push(h),
    });
    await Bun.sleep(150);
    expect(exited.code).toBeNull();
    // Bound the *later* candidate, leaving the rival realm untouched.
    expect(await probeCandidate(port)).toBe("compatible");
    const peer = await attachPeer(port);
    peer.close();
  });

  test("exits when no session has attached for the idle window", async () => {
    const port = freePort();
    const exited = { code: null as number | null };
    void runDetachedHub({
      token: TOKEN,
      port,
      version: "1.0.0",
      idleExitMs: 60,
      exit: (code) => {
        exited.code = code;
      },
    });
    await Bun.sleep(150);
    expect(exited.code).toBe(0);
  });

  test("an attached session holds the idle clock, and its departure restarts it", async () => {
    const port = freePort();
    const exited = { code: null as number | null };
    void runDetachedHub({
      token: TOKEN,
      port,
      version: "1.0.0",
      idleExitMs: 120,
      exit: (code) => {
        exited.code = code;
      },
    });
    await Bun.sleep(30);
    const peer = await attachPeer(port);

    // Well past the idle window: a hub with work to do must not walk out of it.
    await Bun.sleep(250);
    expect(exited.code).toBeNull();

    peer.close();
    await Bun.sleep(250);
    expect(exited.code).toBe(0);
  });

  test("retires for a newer sidecar instead of serving stale code all day", async () => {
    const port = freePort();
    const exited = { code: null as number | null };
    void runDetachedHub({
      token: TOKEN,
      port,
      version: "1.0.0",
      exit: (code) => {
        exited.code = code;
      },
    });
    await Bun.sleep(50);
    await expect(attachPeer(port, "1.1.0")).rejects.toThrow(/retiring/);
    await Bun.sleep(50);
    expect(exited.code).toBe(0);
    // And the port is free for that peer's next round, which is the point.
    expect(await probeCandidate(port)).toBe("silent");
  });
});

// The claim under test belongs to Bun and the OS, not to this file: a spawned
// hub must outlive the process that spawned it, or the whole feature is a
// session-scoped hub with extra steps. Verified rather than assumed, because
// this repo has already paid for assumed platform behaviour more than once.
describe("a spawned hub outlives its parent", () => {
  test("the child keeps serving after the spawner exits", async () => {
    const port = freePort();
    const entry = new URL("../gullet.ts", import.meta.url).pathname;

    // A real parent: spawn, hand over the token, and exit immediately. If Bun
    // took its children down with it, or the token never crossed, the probe
    // below would find nothing.
    const parent = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        const child = Bun.spawn([process.execPath, ${JSON.stringify(entry)}, "--detached-hub", "--port", "${port}"], {
          stdin: "pipe", stdout: "ignore", stderr: "ignore", detached: true,
        });
        child.stdin.write(${JSON.stringify(`${TOKEN}\n`)});
        child.stdin.end();
        child.unref();
        `,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await parent.exited).toBe(0);

    try {
      let identity = await probeCandidate(port);
      for (let i = 0; i < 40 && identity !== "compatible"; i++) {
        await Bun.sleep(50);
        identity = await probeCandidate(port);
      }
      expect(identity).toBe("compatible");

      // Not merely listening — holding the token it was handed on stdin, which
      // is the part that never appears in `ps`.
      const peer = await attachPeer(port, "0.0.1");
      peer.close();
    } finally {
      // The hub is nobody's child now, so nothing else will clean it up.
      await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
      const survivor = await attachPeer(port, "999.0.0").catch(() => null);
      survivor?.close();
      await Bun.sleep(100);
    }
  }, 15_000);
});
