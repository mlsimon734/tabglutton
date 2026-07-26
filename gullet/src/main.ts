// Wires the two halves together: MCP on stdio facing the agent, WebSocket hub
// on loopback facing the browsers.

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

  const hub = new Hub({ port: config.port, token: config.token });
  try {
    hub.listen();
  } catch (err) {
    // Almost always "port already in use" — usually a second Gullet from
    // another agent session. Say so instead of dying silently.
    console.error(
      `[gullet] could not listen on 127.0.0.1:${config.port}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (!config.token) {
    // Not fatal: the MCP server still starts so tool calls can explain the fix,
    // which the agent can relay. A hard exit just reads as "server crashed".
    console.error("[gullet] no token configured — set GULLET_TOKEN. Refusing all connections.");
  }
  console.error(`[gullet] listening on ws://127.0.0.1:${hub.port} (proto MCP over stdio)`);

  const shutdown = (): void => {
    hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await serveStdio({
    name: "gullet",
    version: GULLET_VERSION,
    instructions: GULLET_INSTRUCTIONS,
    tools: GULLET_TOOLS,
    call: createToolCaller({
      connections: () => hub.summaries(),
      request: (connectionId, method, params) => hub.request(connectionId, method, params),
      tokenConfigured: config.token.length > 0,
    }),
  });

  // stdin closed: the agent harness has gone away, so the socket should too.
  hub.stop();
  return 0;
}
