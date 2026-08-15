// "Is a compatible Tabglutton hub already on this port?", asked over plain HTTP.
//
// Lives on its own because three callers need it and they must not need each
// other: the Supervisor's election, the detached hub's own stand-aside check,
// and the parent waiting for a hub it just spawned to come up. It is also the
// rule that keeps a token proof away from a stranger — a markerless local
// service answers this and gets nothing else.

import {
  BRIDGE_PROBE_HEADER,
  classifyBridgeProbe,
  type BridgeProbeIdentity,
} from "../../src/bridge-protocol.js";

const DISCOVERY_PROBE_TIMEOUT_MS = 500;

/** Everything `classifyBridgeProbe` can say, plus "nothing answered at all". */
export type CandidateProbe = BridgeProbeIdentity | "silent";

export async function probeCandidate(port: number): Promise<CandidateProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    const header = response.headers.get(BRIDGE_PROBE_HEADER);
    if (header !== null) {
      // Nothing reads the body on this path, and an unconsumed one holds its
      // pooled connection open — every 400ms-5s, per candidate, while a round
      // keeps failing.
      void response.body?.cancel();
      return classifyBridgeProbe(header, "");
    }
    return classifyBridgeProbe(null, await responseHead(response));
  } catch {
    return "silent";
  } finally {
    clearTimeout(timer);
  }
}

async function responseHead(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  try {
    const { value } = await reader.read();
    return value ? new TextDecoder().decode(value.slice(0, 128)) : "";
  } finally {
    void reader.cancel();
  }
}
