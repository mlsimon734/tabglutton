// Decides, and keeps deciding, whether this Gullet serves the browser itself or
// proxies through another one.
//
// The rule is just "bind the port, or attach to whoever did". What makes it
// worth a module is that the answer changes: agent sessions are short, so the
// hub exits often, and every peer then has to re-race for the port. Exactly one
// wins and the rest attach to it. The MCP half above never sees any of this — it
// holds a BridgeBackend and the role underneath swaps without it noticing.

import {
  BRIDGE_CONNECT_WAIT_MS,
  bridgePortCandidates,
  errorMessage,
  BridgeRequestError,
  type BridgeError,
  type BridgeWireMethod,
} from "../../src/bridge-protocol.js";
import { delay } from "../../src/serialize.js";
import type { TokenResolver } from "./config.js";
import { spawnDetachedHub } from "./detached.js";
import { Hub } from "./hub.js";
import { PeerClient } from "./peer.js";
import { probeCandidate } from "./probe.js";
import type { ConnectionSummary } from "./select.js";
import { GULLET_VERSION } from "./version.js";

export interface BridgeBackend {
  connections(): Promise<ConnectionSummary[]>;
  request(connectionId: string, method: BridgeWireMethod, params: unknown): Promise<unknown>;
  /** Why nothing can be served right now, or null. Re-read on every call. */
  fault(): BridgeError | null;
  /** Candidate ports held by another Tabglutton hub. Diagnosis, not routing. */
  rivalHubs(): Promise<number[]>;
  stop(): void;
}

/**
 * Gap between a failed election round and the next. The losing case is a hub
 * that has just exited: the port is briefly held by nobody while several peers
 * try for it at once, and a dial can land before the winner has finished
 * binding. Short enough that a session is not left waiting, long enough not to
 * spin.
 */
const ELECTION_RETRY_MS = 400;

/**
 * Ceiling the gap grows to while rounds keep failing. A port held by something
 * that will never authenticate — another service, or a Gullet carrying a
 * different token — is not the race above; it is a standing condition, and
 * retrying it four times over every two seconds for the life of the process is
 * noise. Backing off keeps the recovery without the spin.
 */
const ELECTION_RETRY_MAX_MS = 5_000;

/** Secret-manager and token-file retries back off independently of election. */
const TOKEN_RETRY_MS = 1_000;
const TOKEN_RETRY_MAX_MS = 30_000;

/**
 * How long `start()` waits for the first election before reporting a fault.
 *
 * It has to bound the *wait*, because `main` awaits `start()` before
 * `serveStdio`: an election that never settles means the MCP server never
 * answers `initialize`, and every client renders that as a hang naming no cause
 * — the exact failure the startup-error path was written to replace, reached by
 * a different road. The election itself carries on underneath and `fault()` is
 * re-read on every tool call, so a port that frees up later heals in place.
 */
const ELECTION_START_TIMEOUT_MS = 4_000;

/**
 * How many rounds may try to spawn a detached hub before this process gives up
 * on the idea and binds the port itself for the rest of its life.
 *
 * Without a bound, an environment where the spawn cannot work — a read-only
 * install, a sandbox that refuses `fork`, an entry path that no longer exists —
 * would start a doomed process on every election round, forever, while the
 * session it belongs to sat there with no bridge. Two attempts distinguishes a
 * lost race (the other spawn won, and we found its hub) from a spawn that will
 * never work, and the fallback is not a degraded mode: it is exactly what Gullet
 * did before detached hubs existed.
 */
const DETACH_ATTEMPTS = 2;

export type BackendRole = "hub" | "peer" | "electing";

export interface SupervisorOptions {
  /** Present only for an explicit fixed-port configuration. */
  port?: number;
  /** Automatic candidates; injectable so socket tests use ephemeral ports. */
  candidates?: readonly number[];
  token: string;
  /** A global file or command source. Retried after a transient startup failure. */
  resolveToken?: TokenResolver;
  /** Surfaced in logs only; the MCP half is deliberately unaware of the role. */
  onRoleChange?: (role: BackendRole) => void;
  /** Overrides ELECTION_START_TIMEOUT_MS. Exists so the give-up path is testable. */
  startTimeoutMs?: number;
  /** Overrides BRIDGE_CONNECT_WAIT_MS. Exists so tests need not wait out the window. */
  connectWaitMs?: number;
  /**
   * Start a hub that outlives this process rather than binding one here. On by
   * default; `--no-detach` turns it off.
   */
  detach?: boolean;
  /** Where a spawned hub writes its diagnostics. */
  hubLogPath?: string;
  /** Injected so tests exercise the election without starting real processes. */
  spawnHub?: (options: { token: string; port?: number }) => Promise<number | null>;
}

export class Supervisor implements BridgeBackend {
  private readonly options: SupervisorOptions;
  private hub: Hub | null = null;
  private peer: PeerClient | null = null;
  private activePort: number | null = null;
  private role: BackendRole = "electing";
  private stopped = false;
  private token: string;
  private tokenFault: BridgeError | null = null;
  /** Resolves when the current election settles; awaited by calls that arrive mid-swap. */
  private settling: Promise<void> = Promise.resolve();
  /**
   * Set while election is in progress or a round got nowhere, cleared by one
   * that settles. Published rather than merely logged so calls arriving after
   * start's bounded wait are answered instead of parked on `settling` forever.
   */
  private electionFault: BridgeError | null = null;
  /** Spawn attempts spent; see DETACH_ATTEMPTS. */
  private detachAttempts = 0;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.token = options.token.trim();
    if (this.candidatePorts().length === 0) {
      throw new Error("Gullet needs at least one valid bridge port candidate.");
    }
  }

  /**
   * Run the first election, waiting only so long for it. Throws if it has not
   * settled by then — the election keeps going, and `fault()` tracks it.
   */
  async start(): Promise<void> {
    // Preserve the original synchronous handoff to `settling` for an already
    // resolved token. Calls may arrive concurrently with start(); none may see
    // the constructor's placeholder resolved promise and mistake it for an
    // election that finished with no backend.
    if (!this.token) {
      const fault = await this.acquireToken();
      if (fault) {
        // Only a configured source can heal; with none, acquireToken's answer is
        // fixed at construction time and a retry loop would wake the event loop
        // forever to re-derive it.
        if (this.options.resolveToken) void this.retryToken();
        throw new BridgeRequestError(fault.code, fault.message);
      }
    }
    this.settling = this.elect();
    await this.waitForSettling();
  }

  /** Bound calls that land while an election is still trying to settle. */
  private async waitForSettling(): Promise<void> {
    const budget = this.options.startTimeoutMs ?? ELECTION_START_TIMEOUT_MS;
    const settling = this.settling;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settled = await Promise.race([
      settling.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), budget);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (settled) return;
    const fault = this.fault();
    throw new BridgeRequestError(
      fault?.code ?? "unsupported",
      fault?.message ??
        `No Tabglutton bridge candidate settled within ${budget}ms ` +
          `(tried 127.0.0.1:${this.candidatePorts().join(", ")}).`,
    );
  }

  fault(): BridgeError | null {
    return this.tokenFault ?? this.electionFault;
  }

  /**
   * Resolve one configured token source. A command may be waiting on a locked
   * secret manager, or the token file may not have been created yet; neither is
   * a reason to kill the MCP transport before it can explain the problem.
   */
  private async acquireToken(): Promise<BridgeError | null> {
    if (this.token) return null;
    if (!this.options.resolveToken) {
      this.tokenFault = {
        code: "unauthorized",
        message:
          "Tabglutton's bridge has no token. Open Tabglutton's settings, enable the " +
          "agent bridge, generate a token, and copy the setup command.",
      };
      return this.tokenFault;
    }
    try {
      const token = (await this.options.resolveToken()).trim();
      if (!token) throw new Error("The configured token source returned an empty token.");
      this.token = token;
      this.tokenFault = null;
      return null;
    } catch (err) {
      this.tokenFault = { code: "unauthorized", message: errorMessage(err) };
      return this.tokenFault;
    }
  }

  /** Keep trying after initialize is unblocked; success starts election in place. */
  private async retryToken(): Promise<void> {
    let gap = TOKEN_RETRY_MS;
    while (!this.stopped) {
      await delay(gap);
      if (this.stopped) return;
      if (!(await this.acquireToken())) {
        console.error("[gullet] token source became available; starting bridge election");
        this.settling = this.elect();
        void this.settling.catch((err) =>
          console.error(`[gullet] election after token recovery failed: ${errorMessage(err)}`),
        );
        return;
      }
      gap = Math.min(gap * 2, TOKEN_RETRY_MAX_MS);
    }
  }

  private async elect(): Promise<void> {
    let gap = ELECTION_RETRY_MS;
    for (let attempt = 0; !this.stopped; attempt++) {
      const ports = this.candidatePorts();
      const observations = new Map<number, string>();
      // Deliberately *not* published while the round is merely in progress. A
      // round in flight is what `settling` already expresses, and `fault()` is
      // checked by every tool call *before* it awaits `settling` — so a fault
      // set here would fail every call landing inside a routine re-election
      // (the hub sidecar exiting, which happens constantly) instead of letting
      // it wait out the handover. Only a round that got nowhere publishes.

      // Discovery precedes every bind. Otherwise an earlier port becoming free
      // would split this token realm away from its already-running later hub.
      for (const port of ports) {
        if (this.stopped) return;
        if (await this.tryExistingHub(port, observations)) return;
      }

      // No hub exists, so make one that is not ours to lose. Between this and
      // the binding sweep below is the whole difference the detached hub makes:
      // the browser's connection stops being scoped to this agent session.
      // Everything here is best-effort — a spawn that does not land falls
      // through to binding in-process, which is what this always did.
      if (await this.trySpawnedHub(observations)) return;

      for (const port of ports) {
        if (this.stopped) return;
        // Binding is still the atomic election. The only new rule is that a
        // loser re-checks the exact port it lost before considering the next.
        // No `detached` here, so this hub counts itself as one session: its
        // lifetime is this agent session's, which is what made a live socket
        // proof of entitlement in the first place.
        const hub = new Hub({ port, token: this.token, version: GULLET_VERSION });
        try {
          hub.listen();
          this.hub = hub;
          this.peer = null;
          this.activePort = port;
          this.settle("hub");
          return;
        } catch {
          hub.stop();
          observations.set(port, "occupied");
        }
        if (await this.tryExistingHub(port, observations)) return;
      }

      const summary = ports
        .map((port) => `${port} ${observations.get(port) ?? "unavailable"}`)
        .join(", ");
      if (attempt === 0)
        console.error(`[gullet] no compatible candidate yet (${summary}); retrying`);
      // An incompatible candidate is named separately because it is the one
      // observation with a remedy this message can state, and because it is the
      // expected state right after a wire-protocol bump: an older *detached*
      // hub outlives the session that spawned it and holds the port for up to
      // DETACHED_HUB_IDLE_EXIT_MS. It cannot be asked to stand aside — retiring
      // requires proving the token, and the proof itself is protocol-shaped, so
      // no version of this ever retires across a protocol boundary. Saying
      // "check for incompatible versions" and leaving the user to find a
      // detached process they did not know existed is not good enough.
      const incompatible = [...observations]
        .filter(([, seen]) => seen === "incompatible")
        .map(([port]) => port);
      this.electionFault = {
        code: "unsupported",
        message:
          `Could not establish the Tabglutton bridge on any candidate (${summary}). ` +
          `${this.options.port === undefined ? "Automatic" : "Fixed-port"} mode will keep ` +
          `retrying; check for other services, incompatible Gullet versions, or sidecars ` +
          `using a different TABGLUTTON_TOKEN.` +
          (incompatible.length === 0
            ? ""
            : ` A Gullet speaking a different bridge protocol holds 127.0.0.1:${incompatible.join(", ")}. ` +
              `It will not stand aside — a protocol mismatch is refused before anything else is ` +
              `considered — so if you have just upgraded, stop the old one: it is most likely a ` +
              `background hub that outlived its session (\`pkill -f "gullet.*--detached-hub"\`).`),
      };
      await delay(gap);
      gap = Math.min(gap * 2, ELECTION_RETRY_MAX_MS);
    }
  }

  private candidatePorts(): number[] {
    return bridgePortCandidates(this.options.port, this.options.candidates);
  }

  /**
   * Start a detached hub and attach to it as a peer.
   *
   * Note what this deliberately does *not* do: trust the port it is handed. The
   * spawned hub runs the same canonical candidate order and may land anywhere in
   * it, and between its bind and our attach a rival could in principle have
   * taken over — so the answer is treated as a hint about *where to look*, and
   * `tryExistingHub` still probes and proves the token before anything is sent.
   */
  private async trySpawnedHub(observations: Map<number, string>): Promise<boolean> {
    if (this.options.detach === false) return false;
    if (this.detachAttempts >= DETACH_ATTEMPTS) return false;
    this.detachAttempts += 1;

    const spawn =
      this.options.spawnHub ??
      ((options: { token: string; port?: number }) =>
        spawnDetachedHub({
          ...options,
          version: GULLET_VERSION,
          ...(this.options.candidates === undefined ? {} : { candidates: this.options.candidates }),
          ...(this.options.hubLogPath === undefined ? {} : { logPath: this.options.hubLogPath }),
        }));

    let port: number | null;
    try {
      port = await spawn({
        token: this.token,
        ...(this.options.port === undefined ? {} : { port: this.options.port }),
      });
    } catch (err) {
      console.error(`[gullet] detached hub did not start: ${errorMessage(err)}`);
      return false;
    }
    if (this.stopped || port === null) {
      if (port === null) {
        console.error(
          "[gullet] no detached hub answered in time; serving the browser from this process",
        );
      }
      return false;
    }
    const attached = await this.tryExistingHub(port, observations);
    // The budget counts spawns that got us *nowhere*, not spawns. A session can
    // legitimately need several over its life — the hub it was using retires for
    // an upgrade, or is killed — and charging those against the same allowance
    // would silently drop a long-running session back to the session-scoped hub
    // this whole path exists to replace, with nothing in any log saying so.
    if (attached) this.detachAttempts = 0;
    return attached;
  }

  /** Probe first; only a marked, protocol-compatible endpoint receives a proof. */
  private async tryExistingHub(port: number, observations: Map<number, string>): Promise<boolean> {
    const identity = await probeCandidate(port);
    if (identity !== "compatible") {
      observations.set(port, identity);
      return false;
    }

    const peer = new PeerClient({
      port,
      token: this.token,
      version: GULLET_VERSION,
      onLost: () => this.reelect(),
    });
    try {
      await peer.connect();
      if (this.stopped) {
        peer.stop();
        return false;
      }
      this.peer = peer;
      this.hub = null;
      this.activePort = port;
      this.settle("peer");
      return true;
    } catch (err) {
      peer.stop();
      observations.set(port, `different realm or unavailable (${errorMessage(err)})`);
      return false;
    }
  }

  /** An election round that landed: the role is live, so the fault is history. */
  private settle(role: "hub" | "peer"): void {
    this.electionFault = null;
    this.setRole(role);
  }

  /** The hub we were attached to went away — race for the port with the other peers. */
  private reelect(): void {
    if (this.stopped || this.role !== "peer") return;
    console.error("[gullet] hub sidecar went away; re-electing");
    this.peer = null;
    this.activePort = null;
    this.setRole("electing");
    this.settling = this.elect();
    void this.settling.catch((err) => console.error(`[gullet] re-election failed: ${err}`));
  }

  private setRole(role: BackendRole): void {
    this.role = role;
    if (role === "hub") {
      console.error(`[gullet] serving as hub on 127.0.0.1:${this.activePort}`);
    }
    if (role === "peer") {
      console.error(`[gullet] attached to the hub on 127.0.0.1:${this.activePort}`);
    }
    this.options.onRoleChange?.(role);
  }

  // Both roles wait the same first-call window: a peer inherits it inside the
  // hub it is attached to, a hub applies it here. No caller gets a knob — the
  // wait lives at the layer that owns it, so the roles cannot diverge.
  /**
   * Another Tabglutton hub holding one of the candidate ports, if any.
   *
   * Exists because "the extension says connected" and "no browser is connected"
   * are both true when two hubs run with different tokens, and that pair of
   * facts reads as a broken bridge rather than as the split it is. Costs a few
   * loopback probes and is only ever called to explain a failure.
   */
  async rivalHubs(): Promise<number[]> {
    return rivalHubPorts(this.candidatePorts(), this.activePort);
  }

  async connections(): Promise<ConnectionSummary[]> {
    await this.waitForSettling();
    if (this.peer) return this.peer.connections();
    if (!this.hub) return [];
    return this.hub.connectionsWithin(this.options.connectWaitMs ?? BRIDGE_CONNECT_WAIT_MS);
  }

  async request(connectionId: string, method: BridgeWireMethod, params: unknown): Promise<unknown> {
    await this.waitForSettling();
    if (this.peer) return this.peer.request(connectionId, method, params);
    if (this.hub) return this.hub.request(connectionId, method, params);
    throw new Error("No bridge backend is available.");
  }

  stop(): void {
    this.stopped = true;
    this.peer?.stop();
    this.hub?.stop();
    this.peer = null;
    this.hub = null;
    this.activePort = null;
  }
}

/**
 * Candidate ports answering as a Tabglutton hub that is **not** this process.
 *
 * Only ever asked on the "no browser is connected" path, so the probes cost
 * nothing that matters and are done live rather than read from the election's
 * observations — a rival can appear long after we settled, which is exactly the
 * case worth catching.
 *
 * A compatible answer here almost always means a token mismatch: a hub sharing
 * our token would have been joined as a peer instead of left running beside us.
 * That is the diagnosis the caller turns into advice.
 */
async function rivalHubPorts(candidates: number[], activePort: number | null): Promise<number[]> {
  const others = candidates.filter((port) => port !== activePort);
  const probes = await Promise.all(
    others.map(async (port) => ((await probeCandidate(port)) === "compatible" ? port : null)),
  );
  return probes.filter((port): port is number => port !== null);
}
