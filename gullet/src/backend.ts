// Decides, and keeps deciding, whether this Gullet serves the browser itself or
// proxies through another one.
//
// The rule is just "bind the port, or attach to whoever did". What makes it
// worth a module is that the answer changes: agent sessions are short, so the
// hub exits often, and every peer then has to re-race for the port. Exactly one
// wins and the rest attach to it. The MCP half above never sees any of this — it
// holds a BridgeBackend and the role underneath swaps without it noticing.

import { errorMessage, type BridgeMethod } from "../../src/bridge-protocol.js";
import { Hub } from "./hub.js";
import { PeerClient } from "./peer.js";
import type { ConnectionSummary } from "./select.js";

export interface BridgeBackend {
  connections(timeoutMs: number): Promise<ConnectionSummary[]>;
  request(connectionId: string, method: BridgeMethod, params: unknown): Promise<unknown>;
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

export type BackendRole = "hub" | "peer" | "electing";

export interface SupervisorOptions {
  port: number;
  token: string;
  /** Surfaced in logs only; the MCP half is deliberately unaware of the role. */
  onRoleChange?: (role: BackendRole) => void;
}

export class Supervisor implements BridgeBackend {
  private readonly options: SupervisorOptions;
  private hub: Hub | null = null;
  private peer: PeerClient | null = null;
  private role: BackendRole = "electing";
  private stopped = false;
  /** Resolves when the current election settles; awaited by calls that arrive mid-swap. */
  private settling: Promise<void> = Promise.resolve();

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  /** Run the first election. Throws only if the port can be neither bound nor dialled. */
  async start(): Promise<void> {
    this.settling = this.elect();
    await this.settling;
  }

  private async elect(): Promise<void> {
    for (let attempt = 0; !this.stopped; attempt++) {
      // Binding is the election: the OS decides, and it decides atomically, so
      // there is no window in which two processes both believe they are the hub.
      const hub = new Hub({ port: this.options.port, token: this.options.token });
      try {
        hub.listen();
        this.hub = hub;
        this.peer = null;
        this.setRole("hub");
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
        this.setRole("peer");
        return;
      } catch (err) {
        peer.stop();
        // Neither worked: someone holds the port but is not answering yet, or
        // has just dropped it. Both resolve themselves within a round or two.
        if (attempt === 0) {
          console.error(`[gullet] no hub to attach to yet (${errorMessage(err)}); retrying`);
        }
        await delay(ELECTION_RETRY_MS);
      }
    }
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
