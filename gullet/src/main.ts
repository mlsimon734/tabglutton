// Wires the two halves together: MCP on stdio facing the agent, WebSocket hub
// on loopback facing the browsers.

import { errorMessage, type BridgeError } from "../../src/bridge-protocol.js";
import { Supervisor } from "./backend.js";
import { ConfigError, parseConfig, USAGE } from "./config.js";
import { serveStdio } from "./mcp.js";
import { createToolCaller, GULLET_INSTRUCTIONS, GULLET_TOOLS } from "./tools.js";

/** Reported to the MCP client on initialize. Keep in step with gullet/package.json. */
export const GULLET_VERSION = "0.1.0";

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE);
    return 0;
  }

  let config;
  try {
    config = parseConfig(argv, env);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : String(err));
    return 1;
  }

  // Misconfiguration is not fatal. The MCP server starts regardless so that tool
  // calls can explain the fix and the agent can relay it; exiting instead kills
  // the session before `initialize`, and every client reports that the same
  // unhelpful way — "connection closed".
  const backend = new Supervisor({ port: config.port, token: config.token });

  // Losing the port is no longer a failure. Whoever binds it serves the browser
  // and everyone else attaches to them, because nothing guarantees one Gullet
  // per agent session — Codex spawns two for one session, so a design where the
  // loser dies strands a client behind its own sibling.
  try {
    await backend.start();
  } catch (err) {
    // Neither fatal nor final. The election carries on underneath, so this is
    // logged and then left to `backend.fault()`, which the tool caller re-reads
    // per call — a port freed up mid-session starts working without a restart.
    // Waiting here instead is the trap: `serveStdio` is below, so an election
    // that never settles would hang `initialize` itself, and a client reports
    // that as "connection closed" with nothing else to go on.
    console.error(`[gullet] ${errorMessage(err)}`);
  }

  let tokenError: BridgeError | null = null;
  if (!config.token) {
    const message =
      "Tabglutton's bridge has no token. Open Tabglutton's settings, enable the agent bridge, " +
      "generate a token, and set TABGLUTTON_TOKEN to it.";
    console.error(`[gullet] ${message}`);
    tokenError = { code: "unauthorized", message };
  }

  const shutdown = (): void => {
    backend.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await serveStdio({
    // What the agent sees, and what namespaces its tools. Users know this thing
    // as Tabglutton; "gullet" is the internal name for the sidecar half only.
    name: "tabglutton",
    version: GULLET_VERSION,
    instructions: GULLET_INSTRUCTIONS,
    tools: GULLET_TOOLS,
    call: createToolCaller({
      // The first-call wait lives inside the backend, identically for both roles.
      connections: () => backend.connections(),
      request: (connectionId, method, params) => backend.request(connectionId, method, params),
      // A port we never bound is the more proximate problem, and fixing the
      // token would not make this process serve anything either way.
      startupError: () => backend.fault() ?? tokenError,
    }),
  });

  // stdin closed: the agent harness has gone away, so the socket should too. If
  // this process was the hub, dropping it is what tells the attached peers to
  // re-elect one of themselves.
  backend.stop();
  return 0;
}
