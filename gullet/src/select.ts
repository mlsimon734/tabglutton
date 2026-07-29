// Which browser does a tool call mean? Pure so the ambiguity rules can be
// tested without standing up sockets.

import { BridgeRequestError, type BridgeBrowser } from "../../src/bridge-protocol.js";

export interface ConnectionSummary {
  connectionId: string;
  browser: BridgeBrowser;
  /** Self-reported, e.g. "Zen" or "Chrome". Not unique. */
  label: string;
  extVersion: string;
}

function matches(summary: ConnectionSummary, target: string): boolean {
  const wanted = target.trim().toLowerCase();
  return (
    summary.connectionId.toLowerCase() === wanted ||
    summary.browser === wanted ||
    summary.label.toLowerCase() === wanted
  );
}

function describe(summaries: readonly ConnectionSummary[]): string {
  return summaries.map((s) => `${s.connectionId} (${s.label})`).join(", ");
}

/**
 * Connections a read-only call should fan out over: everything when no target
 * is named, otherwise just the matches.
 */
export function selectAll(
  summaries: readonly ConnectionSummary[],
  target?: string,
): ConnectionSummary[] {
  if (summaries.length === 0) {
    throw new BridgeRequestError(
      "no-connection",
      "No browser is connected. Open the browser with Tabglutton installed and make sure the agent bridge is enabled in its settings.",
    );
  }
  if (target === undefined) return [...summaries];
  const matched = summaries.filter((s) => matches(s, target));
  if (matched.length === 0) {
    throw new BridgeRequestError(
      "not-found",
      `No connected browser matches "${target}". Connected: ${describe(summaries)}.`,
    );
  }
  return matched;
}

/**
 * The single connection a tab-scoped call acts on. Tab ids are only meaningful
 * within one browser, so guessing between two is never acceptable.
 */
export function selectOne(
  summaries: readonly ConnectionSummary[],
  target?: string,
): ConnectionSummary {
  const matched = selectAll(summaries, target);
  if (matched.length > 1) {
    throw new BridgeRequestError(
      "ambiguous-target",
      target === undefined
        ? `More than one browser is connected; pass "browser" to pick one. Connected: ${describe(summaries)}.`
        : `"${target}" matches more than one connection: ${describe(matched)}.`,
    );
  }
  // selectAll throws on zero matches, so exactly one remains.
  return matched[0];
}
