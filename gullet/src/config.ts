// CLI/env parsing for the sidecar. Pure so the precedence rules are testable.

import { DEFAULT_BRIDGE_PORT } from "../../src/bridge-protocol.js";

export interface GulletConfig {
  port: number;
  /** Empty means "not configured" — the MCP server still starts and says so. */
  token: string;
}

export class ConfigError extends Error {}

const USAGE = `gullet — Tabglutton's agent bridge sidecar

  bun run gullet/gullet.ts [--port <1024-65535>] [--token <token>]

  --port   loopback port to listen on (default ${DEFAULT_BRIDGE_PORT}, env GULLET_PORT)
  --token  shared token from Tabglutton's options page (env GULLET_TOKEN)

The token is required before any browser may connect. Prefer the environment
variable: process arguments are visible to other local users, environments are not.`;

export function usage(): string {
  return USAGE;
}

export function parseConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): GulletConfig {
  let port: string | undefined = env.GULLET_PORT;
  let token: string | undefined = env.GULLET_TOKEN;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [flag, inline] = splitFlag(arg);
    switch (flag) {
      case "--port":
        port = inline ?? argv[++i];
        break;
      case "--token":
        token = inline ?? argv[++i];
        break;
      default:
        throw new ConfigError(`Unknown argument ${arg}.\n\n${USAGE}`);
    }
  }

  return { port: parsePort(port), token: (token ?? "").trim() };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_BRIDGE_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ConfigError(`Invalid port "${raw}" — expected an integer in 1024-65535.`);
  }
  return port;
}
