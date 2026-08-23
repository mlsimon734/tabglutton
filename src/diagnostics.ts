/**
 * The paste-ready diagnostics block, and the bounded log of bridge failures
 * behind its last section.
 *
 * Tabglutton collects no telemetry, which is what lets the AMO data-collection
 * form be all zeros. The consequence is that visibility into an install is
 * exactly the quality of its bug report, and the unaided version of that report
 * is "doesn't work". One click turns that into something answerable.
 *
 * **Everything rendered here gets pasted into a public issue**, so the two
 * things it must never carry are kept out by shape rather than by a filter:
 *
 * - The block is built from counts, enum values and version strings. It is
 *   never handed a `Settings` object — that carries `bridgeToken`, which is the
 *   entirety of the bridge's authentication — and never a tab's URL or title.
 *   `DiagnosticsFacts` is the whole of what can appear, so the guarantee is
 *   readable off one interface instead of trusted to a redaction pass nobody
 *   remembers to extend. There is deliberately no such pass: a block with
 *   nothing secret in it cannot leak one, whereas a redactor is a step you can
 *   forget.
 * - `BridgeErrorEntry.subject` is a term from a fixed vocabulary — a loopback
 *   port or a bridge method name — never a caught error's message. Error text
 *   from the clip and load paths quotes the URL it failed on, so recording it
 *   would put page addresses in the block through the one field that looks
 *   harmless.
 *
 * Nothing here touches `browser.*`. The callers gather the facts (the
 * background page holds the bridge's state, the options page has the gesture
 * that may read permissions), and this module stays pure and unit-tested.
 */

import type { PermissionGrant } from "./permissions.js";
import type { BridgePortMode, ClipDestination, ScopeMode } from "./storage.js";
import type { BridgeStatus } from "./bridge-client.js";
import type { BuildTarget } from "./target.js";

/**
 * What went wrong, as a closed set. A bug report needs to distinguish "nothing
 * is listening" from "something is listening and it is not Gullet" from "the
 * token is wrong"; it does not need the exception text, which is where the
 * URLs live.
 */
export type BridgeErrorKind =
  | "no-site-access"
  | "port-foreign"
  | "port-incompatible"
  | "proto-mismatch"
  | "bad-challenge"
  | "auth-failed"
  | "dial-failed"
  | "dial-timeout"
  | "handshake-timeout"
  | "handshake-rejected"
  | "heartbeat-lost"
  | "method-failed";

export interface BridgeErrorEntry {
  /** Epoch ms of the most recent occurrence in this run of identical failures. */
  at: number;
  kind: BridgeErrorKind;
  /**
   * A loopback port or a bridge method name — see the vocabulary rule in this
   * module's header. Never free text and never anything a page supplied.
   */
  subject?: string;
  /** Consecutive identical failures collapsed into this entry; at least 1. */
  count: number;
}

/**
 * Ten is enough to show a pattern and short enough to stay readable in an
 * issue. A bridge with no sidecar fails on a fixed cadence, so a longer buffer
 * would only hold more copies of the same minute.
 */
export const BRIDGE_ERROR_CAPACITY = 10;

/**
 * The last few bridge failures, newest evicting oldest.
 *
 * Consecutive identical failures collapse into one entry with a count, because
 * the failure mode this exists to catch — a reconnect loop against a port that
 * never answers — otherwise fills every slot with the same line inside a few
 * minutes and buries whatever came before it.
 *
 * Session-scoped on purpose. This lives with the bridge client, which on
 * Chrome MV3 dies with the service worker, so a report filed after the worker
 * has been asleep shows an empty log. That is accepted rather than persisted:
 * the alternative is a `storage` write per failure, on the exact path that is
 * already failing, to keep a history no user has asked for.
 */
export class BridgeErrorLog {
  private readonly capacity: number;
  private readonly entries: BridgeErrorEntry[] = [];

  constructor(capacity: number = BRIDGE_ERROR_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  record(kind: BridgeErrorKind, subject?: string, at: number = Date.now()): void {
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === kind && last.subject === subject) {
      last.count += 1;
      last.at = at;
      return;
    }
    this.entries.push({ at, kind, subject, count: 1 });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /** Oldest first, which is the order the block renders them in. */
  list(): readonly BridgeErrorEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

export interface DiagnosticsBridgeFacts {
  enabled: boolean;
  /** Whether a token exists at all — never the token. An enabled bridge without
   * one reports "disabled", which reads as a bug until you know this. */
  hasToken: boolean;
  portMode: BridgePortMode;
  /** The configured fixed port, meaningful only in `fixed` mode. */
  fixedPort: number;
  status: BridgeStatus;
  connectedPort?: number;
  allowTabLoad: boolean;
  errors: readonly BridgeErrorEntry[];
}

export interface DiagnosticsGrants {
  /** `CLIP_ORIGINS` — the Defuddle extractor's injection target. */
  sites: PermissionGrant;
  /** `BRIDGE_ORIGINS` — the sidecar probe's loopback origin. */
  loopback: PermissionGrant;
  downloads: PermissionGrant;
}

/**
 * The half of the block only the background page can answer — it owns the
 * bridge client and the settings the extension is actually running on.
 */
export interface DiagnosticsBackgroundFacts {
  /** "Firefox 134.0.2", "Chrome 151.0.7049.42", or "unknown". */
  engine: string;
  /** `getPlatformInfo`'s os and arch, or "unknown". */
  platform: string;
  tabsInScope: number;
  tabsTotal: number;
  duplicates: number;
  windows: number;
  scope: ScopeMode;
  clipDestination: ClipDestination;
  zoteroRouting: boolean;
  bridge: DiagnosticsBridgeFacts;
}

/**
 * The complete vocabulary of the block. Adding a field here is the moment to
 * re-read this module's header: whatever goes in gets published.
 */
export interface DiagnosticsFacts {
  version: string;
  target: BuildTarget;
  grants: DiagnosticsGrants;
  /**
   * Absent when the background page never answered, which the block reports
   * rather than papering over with the values this page happens to have
   * rendered: on Chrome MV3 a service worker that will not wake for a runtime
   * message is itself the bug in a fair number of these reports, and settings
   * read back off the form would hide it behind a plausible-looking summary.
   */
  background?: DiagnosticsBackgroundFacts;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse and relative, so the block carries no wall-clock time from the user's machine. */
export function agoLabel(elapsedMs: number): string {
  if (elapsedMs < 5_000) return "just now";
  if (elapsedMs < MINUTE) return `${Math.round(elapsedMs / 1_000)}s ago`;
  if (elapsedMs < HOUR) return `${Math.round(elapsedMs / MINUTE)}m ago`;
  if (elapsedMs < DAY) return `${Math.round(elapsedMs / HOUR)}h ago`;
  return `${Math.round(elapsedMs / DAY)}d ago`;
}

function bridgeLine(bridge: DiagnosticsBridgeFacts): string {
  const parts = [bridge.enabled ? "on" : "off"];
  if (bridge.enabled && !bridge.hasToken) parts.push("no token");
  parts.push(bridge.portMode === "fixed" ? `fixed port ${bridge.fixedPort}` : "automatic port");
  parts.push(
    bridge.connectedPort === undefined
      ? bridge.status
      : `${bridge.status} on ${bridge.connectedPort}`,
  );
  parts.push(`tab load ${bridge.allowTabLoad ? "allowed" : "off"}`);
  return parts.join(" · ");
}

function errorLines(errors: readonly BridgeErrorEntry[], now: number): string[] {
  return errors.map((entry) => {
    const subject = entry.subject ? ` ${entry.subject}` : "";
    const repeat = entry.count > 1 ? ` (x${entry.count})` : "";
    return `  ${agoLabel(now - entry.at)}  ${entry.kind}${subject}${repeat}`;
  });
}

/** Pads the label column so the block scans as a table inside the code fence. */
function row(label: string, value: string): string {
  return `${label.padEnd(13)}${value}`;
}

/**
 * The block itself, fenced because its destination is a GitHub comment box and
 * unfenced these rows reflow into one unreadable paragraph.
 */
export function renderDiagnostics(facts: DiagnosticsFacts, now: number): string {
  const grants = facts.grants;
  const lines = [
    "```text",
    `Tabglutton ${facts.version} diagnostics (${facts.target} build)`,
    row(
      "grants",
      `sites ${grants.sites} · loopback ${grants.loopback} · downloads ${grants.downloads}`,
    ),
  ];
  const bg = facts.background;
  if (!bg) {
    lines.push(row("note", "the background page did not answer, so nothing else is known"), "```");
    return lines.join("\n");
  }
  lines.push(
    row("engine", bg.engine),
    row("platform", bg.platform),
    row(
      "tabs",
      `${bg.tabsInScope} in scope of ${bg.tabsTotal} open · ` +
        `${bg.duplicates} duplicate${bg.duplicates === 1 ? "" : "s"} · ` +
        `${bg.windows} window${bg.windows === 1 ? "" : "s"}`,
    ),
    row("scope", bg.scope),
    row("clips", `${bg.clipDestination} · zotero routing ${bg.zoteroRouting ? "on" : "off"}`),
    row("bridge", bridgeLine(bg.bridge)),
  );
  // Its own heading rather than another padded row: the entries hang under it,
  // and a value column that its label overflows is worse than neither.
  const errors = bg.bridge.errors;
  lines.push(
    errors.length === 0
      ? "bridge errors (none this session)"
      : `bridge errors (${errors.length}, oldest first)`,
    ...errorLines(errors, now),
    "```",
  );
  return lines.join("\n");
}
