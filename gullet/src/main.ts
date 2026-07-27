// Wires the two halves together: MCP on stdio facing the agent, WebSocket hub
// on loopback facing the browsers.

import {
  BRIDGE_CONNECT_WAIT_MS,
  errorMessage,
  type BridgeError,
} from "../../src/bridge-protocol.js";
import { ConfigError, parseConfig, USAGE } from "./config.js";
import { Hub } from "./hub.js";
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

  // Neither of the two ways this can be misconfigured is fatal. The MCP server
  // starts regardless so that tool calls can explain the fix and the agent can
  // relay it; exiting instead kills the session before `initialize`, and every
  // client reports that the same unhelpful way — "connection closed".
  const hub = new Hub({ port: config.port, token: config.token });
  let startupError: BridgeError | null = null;

  try {
    hub.listen();
    console.error(`[gullet] listening on ws://127.0.0.1:${hub.port} (proto MCP over stdio)`);
  } catch (err) {
    // Almost always a second Gullet from another agent session: only one
    // process can hold the port, and the browser only ever dials that one.
    const message =
      `Another process is already listening on 127.0.0.1:${config.port}, ` +
      `almost certainly a Tabglutton sidecar from another agent session. Only one can hold ` +
      `the port. Close that session, or start this one with --port <free port> and set the ` +
      `same port in Tabglutton's settings.`;
    console.error(`[gullet] ${message} (${errorMessage(err)})`);
    startupError = { code: "unsupported", message };
  }

  if (!config.token) {
    const message =
      "Tabglutton's bridge has no token. Open Tabglutton's settings, enable the agent bridge, " +
      "generate a token, and set TABGLUTTON_TOKEN to it.";
    console.error(`[gullet] ${message}`);
    // `??=`: a port we never bound is the more proximate problem, and fixing
    // the token would not make this process serve anything.
    startupError ??= { code: "unauthorized", message };
  }

  const shutdown = (): void => {
    hub.stop();
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
      connections: () => hub.connectionsWithin(BRIDGE_CONNECT_WAIT_MS),
      request: (connectionId, method, params) => hub.request(connectionId, method, params),
      startupError,
    }),
  });

  // stdin closed: the agent harness has gone away, so the socket should too.
  hub.stop();
  return 0;
}
