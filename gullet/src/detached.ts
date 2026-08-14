// The hub that outlives the agent session which needed it.
//
// Everything else in Gullet exists inside a session: the harness spawns the
// process, the process binds a port, the browser finds it, and all of it goes
// away when the agent does. That lifetime is the reason session start has to
// *discover* anything at all — and discovery is where the bridge has spent its
// worst failures, because the first WebSocket dial of a session is a dial into a
// port that appeared seconds ago, in a browser that may have been idle for
// hours. (2026-07-29: probe found the sidecar in 180ms, the dial then sat in
// CONNECTING for the full 120s deadline, twice, with no SYN reaching TCP.
// docs/BRIDGE.md has the reproduction.)
//
// So the first Gullet to find no hub does not become one. It spawns a hub that
// is nobody's child, attaches to it as a peer — the path every later session
// already took — and lets the browser hold one long-lived connection to a port
// that stays answered. Session start becomes a local peer attach.
//
// Two properties keep that from being a daemon nobody asked for: it exits after
// DETACHED_HUB_IDLE_EXIT_MS with no session attached, and it stands aside for a
// newer Gullet rather than serving stale code for as long as sessions keep
// arriving (see `shouldRetireFor` in hub.ts). What it must never do is become a
// single point of failure: every caller here falls back to binding in-process,
// which is exactly what Gullet did before this file existed.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BRIDGE_PORT_CANDIDATES,
  CONFIG_DIR_NAME,
  errorMessage,
  isBridgePort,
} from "../../src/bridge-protocol.js";
import { delay } from "../../src/serialize.js";
import { Hub } from "./hub.js";
import { PeerClient } from "./peer.js";
import { probeCandidate } from "./probe.js";

/**
 * How long a detached hub sits with no session attached before exiting.
 *
 * Six hours is chosen against the gaps it has to survive rather than against any
 * property of the code: lunch, an afternoon of meetings, an evening pass over
 * the backlog. Every attaching session resets it, so an actively used hub lives
 * as long as it is used and a forgotten one is gone by morning. The cost of
 * getting it wrong is asymmetric and mild in both directions — too short pays
 * one cold discovery, too long leaves an idle process — which is why it is a
 * constant and not a setting.
 */
export const DETACHED_HUB_IDLE_EXIT_MS = 6 * 60 * 60_000;

/**
 * How long a parent waits for the hub it just spawned to answer its port.
 *
 * This is a local process start, so the honest number is small; the failure it
 * bounds is a child that dies on launch (a broken install, a read-only log
 * path), and the caller's fallback is to bind in-process, which costs
 * milliseconds. Waiting longer would put a spawn failure *inside*
 * ELECTION_START_TIMEOUT_MS and turn it into the startup hang that path exists
 * to prevent.
 */
const SPAWN_WAIT_MS = 3_000;
const SPAWN_POLL_MS = 50;

/**
 * Where a detached hub's stderr goes.
 *
 * It cannot go to the spawner's: stdout there is the MCP transport, and stderr
 * belongs to an agent harness that will be gone long before the hub is. A file
 * under the XDG state directory is the standard answer for a log, and keeping it
 * out of the config directory keeps that directory the thing the README says it
 * is — settings the user may commit.
 *
 * The file is small by construction rather than by rotation: the hub logs
 * lifecycle transitions, and the browser reconnect churn that a detached hub
 * sees all day is deliberately silent (see `completeHandshake` in hub.ts).
 */
export function detachedHubLogPath(env: Readonly<Record<string, string | undefined>>): string {
  const home = env.HOME?.trim() || homedir();
  const state = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  return join(state, CONFIG_DIR_NAME, "hub.log");
}

export interface SpawnDetachedHubOptions {
  token: string;
  /** Ours, used to tell our own realm's hub from a stranger's while waiting. */
  version: string;
  /** Present only for an explicit fixed-port configuration; auto otherwise. */
  port?: number;
  /** Where the child's diagnostics go. Absent discards them. */
  logPath?: string;
  /** Candidates to watch for the child coming up. Injected by tests. */
  candidates?: readonly number[];
  /** Overrides SPAWN_WAIT_MS. Exists so the give-up path is testable. */
  waitMs?: number;
}

/**
 * The command that starts a detached hub.
 *
 * Pure so it can be asserted on: it is the one part of the spawn that silently
 * decides *which code* the hub will run, and getting it wrong (the dev entry
 * against an installed package, say) produces a hub that works and is wrong.
 * `Bun.main` resolves to the running entry either way — `gullet/gullet.ts` from
 * a checkout, `dist/gullet.js` from the published package.
 *
 * The token is deliberately absent. It goes over stdin instead, because argv is
 * world-readable through `ps` and this token is the entirety of the bridge's
 * authentication.
 */
export function detachedHubArgv(execPath: string, entry: string, port?: number): string[] {
  return [
    execPath,
    entry,
    "--detached-hub",
    ...(port === undefined ? [] : ["--port", String(port)]),
  ];
}

/**
 * Start a detached hub and wait for it to answer. Resolves with the port it took,
 * or null — and null is never fatal to the caller, only a reason to bind here
 * instead.
 */
export async function spawnDetachedHub(options: SpawnDetachedHubOptions): Promise<number | null> {
  const candidates = (
    options.port === undefined ? (options.candidates ?? BRIDGE_PORT_CANDIDATES) : [options.port]
  ).filter(isBridgePort);
  if (candidates.length === 0) return null;

  // Losing the log must not lose the hub, so an unwritable directory downgrades
  // to discarding diagnostics rather than failing the spawn.
  let logPath = options.logPath;
  if (logPath !== undefined) {
    try {
      await mkdir(dirname(logPath), { recursive: true });
    } catch (err) {
      console.error(`[gullet] detached hub log unavailable: ${errorMessage(err)}`);
      logPath = undefined;
    }
  }

  try {
    const child = Bun.spawn(detachedHubArgv(process.execPath, Bun.main, options.port), {
      stdin: "pipe",
      // Never the parent's: stdout *is* the MCP transport, and a child writing a
      // byte to it corrupts the session that spawned it.
      stdout: "ignore",
      stderr: logPath === undefined ? "ignore" : Bun.file(logPath),
      // Its own process group, so the Ctrl-C that ends an interactive agent
      // session does not take the hub down with it — the whole point is a
      // lifetime that is not the session's.
      detached: true,
      env: { ...process.env },
    });
    child.stdin.write(`${options.token}\n`);
    child.stdin.end();
    // Stop holding our own event loop open for it. Measured on Bun 1.3.14 /
    // macOS: the child reparents to pid 1 and keeps running after we exit.
    child.unref();
  } catch (err) {
    console.error(`[gullet] could not spawn a detached hub: ${errorMessage(err)}`);
    return null;
  }

  return waitForHub(candidates, options.token, options.version, options.waitMs ?? SPAWN_WAIT_MS);
}

/**
 * Poll the candidates for a hub of our own token realm. Which candidate the
 * child took is its decision, not ours — it runs the same canonical order and
 * may skip an occupied port — so this watches the whole set rather than assuming
 * the first.
 *
 * The realm check is what keeps this from answering with somebody else's hub. A
 * rival realm holding an earlier candidate answers a bare probe instantly, well
 * before our child has bound anything, and returning it would send the caller
 * back to the in-process fallback having spent one of its two spawn attempts on
 * a hub that did come up. Two token realms on one machine is supported, and the
 * failure that produces — the second realm never getting a detached hub, for no
 * logged reason — is exactly the kind that is found months later.
 *
 * A rival is checked once and then remembered, so the poll costs one handshake
 * per foreign hub rather than one per 50ms tick.
 */
async function waitForHub(
  candidates: readonly number[],
  token: string,
  version: string,
  waitMs: number,
): Promise<number | null> {
  const deadline = Date.now() + waitMs;
  const foreign = new Set<number>();
  do {
    for (const port of candidates) {
      if (foreign.has(port)) continue;
      if ((await probeCandidate(port)) !== "compatible") continue;
      if (await sameRealmHubAt(port, token, version)) return port;
      foreign.add(port);
    }
    if (foreign.size === candidates.length) return null;
    await delay(SPAWN_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

/**
 * Whether a hub *of our own token realm* holds this port.
 *
 * The probe alone cannot answer this. It identifies Gullet and its protocol, and
 * that is all it is allowed to do — a markerless local service must never be
 * handed a token proof — but "a Gullet" is not "our Gullet". Two token realms on
 * one machine is a supported configuration, and standing aside for a rival
 * realm's hub would mean the second realm silently never gets a detached hub at
 * all, degrading to an in-process one with nothing to say why. So the probe
 * gates the handshake and the handshake decides, exactly as the Supervisor's own
 * discovery sweep does.
 *
 * Attaching also gives the incumbent its chance to retire: an older hub meeting
 * this peer stands down, the connect fails, and we go on to bind the port it
 * just released.
 */
async function sameRealmHubAt(port: number, token: string, version: string): Promise<boolean> {
  if ((await probeCandidate(port)) !== "compatible") return false;
  const peer = new PeerClient({
    port,
    token,
    version,
    // Not `"peer"`: asking a hub whether it is ours must not make us one of its
    // sessions. A real attachment here would broadcast `sessions: 1` and then
    // `0` to every connected browser, and a browser whose socket dropped between
    // those two frames would hold its page awake for a hub serving nobody — and
    // it would reset the incumbent's six-hour idle clock every time anyone
    // looked at it, so a hub could be kept alive indefinitely by its visitors.
    role: "probe",
    onLost: () => {},
  });
  try {
    await peer.connect();
    return true;
  } catch {
    return false;
  } finally {
    peer.stop();
  }
}

/** The idle window as the log should say it, at production and test scales alike. */
function humanMs(ms: number): string {
  if (ms >= 60 * 60_000) return `${+(ms / (60 * 60_000)).toFixed(1)} hours`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} minutes`;
  return `${ms}ms`;
}

export interface DetachedHubOptions {
  token: string;
  port?: number;
  candidates?: readonly number[];
  version: string;
  /** Overrides DETACHED_HUB_IDLE_EXIT_MS so the exit path is testable. */
  idleExitMs?: number;
  /** How the process ends. Injected by tests; `process.exit` in production. */
  exit?: (code: number) => void;
  /** The bound hub, for a caller whose `exit` does not actually end anything. */
  onListening?: (hub: Hub) => void;
}

/**
 * The child's whole life: bind a candidate, serve, exit when nobody has needed
 * it for hours.
 *
 * Its election is deliberately *not* the Supervisor's. A session-scoped Gullet
 * that meets an existing hub attaches to it, because it has an MCP client to
 * serve either way; a detached hub that meets one has nothing to offer and no
 * one to answer to, so the correct move is to exit and leave the incumbent
 * alone. That is also what settles two parents racing to spawn: both children
 * start, one binds, the other finds it and goes away.
 */
export async function runDetachedHub(options: DetachedHubOptions): Promise<number> {
  const candidates = (
    options.port === undefined ? (options.candidates ?? BRIDGE_PORT_CANDIDATES) : [options.port]
  ).filter(isBridgePort);
  if (candidates.length === 0) {
    console.error("[gullet] detached hub has no valid port candidate.");
    return 1;
  }

  // Discovery before binding, same rule and same reason as the Supervisor's: an
  // earlier candidate coming free must not split this token realm away from a
  // hub already running on a later one.
  for (const port of candidates) {
    if (await sameRealmHubAt(port, options.token, options.version)) {
      console.error(`[gullet] a same-token hub already holds 127.0.0.1:${port}; not starting`);
      return 0;
    }
  }

  const exit = options.exit ?? ((code: number) => process.exit(code));
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let hub: Hub | null = null;
  // Resolved only by `shutdown`. Returning from here instead would end the
  // process the moment it started working, because the entry point is
  // `process.exit(await main(...))` — a hub's whole job is to not return.
  let finish: (code: number) => void = () => {};
  const serving = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const shutdown = (reason: string, code: number): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    console.error(`[gullet] detached hub exiting: ${reason}`);
    hub?.stop();
    exit(code);
    // Only reached when `exit` is a test double; the real one never returns.
    finish(code);
  };

  const idleExitMs = options.idleExitMs ?? DETACHED_HUB_IDLE_EXIT_MS;
  const armIdleExit = (sessions: number): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (sessions > 0) return;
    idleTimer = setTimeout(
      () => shutdown(`no agent session for ${humanMs(idleExitMs)}`, 0),
      idleExitMs,
    );
  };

  for (const port of candidates) {
    const candidate = new Hub({
      port,
      token: options.token,
      detached: true,
      version: options.version,
      onSessionsChange: armIdleExit,
      onRetire: () => shutdown("a newer Gullet asked for the port", 0),
    });
    try {
      candidate.listen();
    } catch {
      candidate.stop();
      continue;
    }
    hub = candidate;
    console.error(`[gullet] detached hub serving on 127.0.0.1:${port} (v${options.version})`);
    break;
  }

  if (!hub) {
    console.error(
      `[gullet] detached hub could not bind any candidate (${candidates.join(", ")}); ` +
        `the session that spawned it will serve the browser itself.`,
    );
    return 1;
  }

  process.on("SIGINT", () => shutdown("interrupted", 0));
  process.on("SIGTERM", () => shutdown("terminated", 0));
  armIdleExit(0);
  options.onListening?.(hub);
  return serving;
}
