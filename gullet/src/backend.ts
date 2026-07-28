// Decides, and keeps deciding, whether this Gullet serves the browser itself or
// proxies through another one.
//
// The rule is just "bind the port, or attach to whoever did". What makes it
// worth a module is that the answer changes: agent sessions are short, so the
// hub exits often, and every peer then has to re-race for the port. Exactly one
// wins and the rest attach to it. The MCP half above never sees any of this — it
// holds a BridgeBackend and the role underneath swaps without it noticing.

import { errorMessage, type BridgeError, type BridgeMethod } from "../../src/bridge-protocol.js";
import { Hub } from "./hub.js";
import { PeerClient } from "./peer.js";
import type { ConnectionSummary } from "./select.js";

export interface BridgeBackend {
  connections(timeoutMs: number): Promise<ConnectionSummary[]>;
  request(connectionId: string, method: BridgeMethod, params: unknown): Promise<unknown>;
  /** Why nothing can be served right now, or null. Re-read on every call. */
  fault(): BridgeError | null;
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

export type BackendRole = "hub" | "peer" | "electing";

export interface SupervisorOptions {
  port: number;
  token: string;
  /** Surfaced in logs only; the MCP half is deliberately unaware of the role. */
  onRoleChange?: (role: BackendRole) => void;
  /** Overrides ELECTION_START_TIMEOUT_MS. Exists so the give-up path is testable. */
  startTimeoutMs?: number;
}

export class Supervisor implements BridgeBackend {
  private readonly options: SupervisorOptions;
  private hub: Hub | null = null;
  private peer: PeerClient | null = null;
  private role: BackendRole = "electing";
  private stopped = false;
  /** Resolves when the current election settles; awaited by calls that arrive mid-swap. */
  private settling: Promise<void> = Promise.resolve();
  /**
   * Set by an election round that got nowhere, cleared by one that settles.
   * Published rather than merely logged so that calls arriving during an
   * election with nothing to settle into are answered instead of parked on
   * `settling` forever.
   */
  private electionFault: BridgeError | null = null;

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  /**
   * Run the first election, waiting only so long for it. Throws if it has not
   * settled by then — the election keeps going, and `fault()` tracks it.
   */
  async start(): Promise<void> {
    const budget = this.options.startTimeoutMs ?? ELECTION_START_TIMEOUT_MS;
    this.settling = this.elect();
    const settled = await Promise.race([
      this.settling.then(() => true),
      delay(budget).then(() => false),
    ]);
    if (settled) return;
    throw new Error(
      this.electionFault?.message ??
        `Nothing bound or answered on 127.0.0.1:${this.options.port} within ${budget}ms.`,
    );
  }

  fault(): BridgeError | null {
    return this.electionFault;
  }

  private async elect(): Promise<void> {
    let gap = ELECTION_RETRY_MS;
    for (let attempt = 0; !this.stopped; attempt++) {
      // Binding is the election: the OS decides, and it decides atomically, so
      // there is no window in which two processes both believe they are the hub.
      const hub = new Hub({ port: this.options.port, token: this.options.token });
      try {
        hub.listen();
        this.hub = hub;
        this.peer = null;
        this.settle("hub");
        return;
      } catch {
        hub.stop();
      }

      const peer = new PeerClient({
        port: this.options.port,
        token: this.options.token,
        onLost: () => this.reelect(),
      });
      try {
        await peer.connect();
        this.peer = peer;
        this.hub = null;
        this.settle("peer");
        return;
      } catch (err) {
        peer.stop();
        // Neither worked: someone holds the port but is not answering yet, or
        // has just dropped it. Both resolve themselves within a round or two —
        // and what does not is a port held by something that will never
        // authenticate at all, which no number of rounds improves. So the reason
        // is published for callers as well as logged, and the gap widens.
        if (attempt === 0) {
          console.error(`[gullet] no hub to attach to yet (${errorMessage(err)}); retrying`);
        }
        this.electionFault = {
          code: "unsupported",
          message:
            `Could not reach the Tabglutton bridge on 127.0.0.1:${this.options.port}: ` +
            `${errorMessage(err)}. Nothing could bind the port or attach to whatever holds it. ` +
            `Check that no other service is using it, and that TABGLUTTON_TOKEN matches the token ` +
            `in Tabglutton's settings.`,
        };
        await delay(gap);
        gap = Math.min(gap * 2, ELECTION_RETRY_MAX_MS);
      }
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
    this.setRole("electing");
    this.settling = this.elect();
    void this.settling.catch((err) => console.error(`[gullet] re-election failed: ${err}`));
  }

  private setRole(role: BackendRole): void {
    this.role = role;
    if (role === "hub") console.error("[gullet] serving as hub (owns the browser connection)");
    if (role === "peer") console.error("[gullet] attached to an existing hub sidecar");
    this.options.onRoleChange?.(role);
  }

  async connections(timeoutMs: number): Promise<ConnectionSummary[]> {
    await this.settling;
    // A peer inherits the hub's own wait, so it passes no timeout of its own.
    if (this.peer) return this.peer.connections();
    return this.hub ? this.hub.connectionsWithin(timeoutMs) : [];
  }

  async request(connectionId: string, method: BridgeMethod, params: unknown): Promise<unknown> {
    await this.settling;
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
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
