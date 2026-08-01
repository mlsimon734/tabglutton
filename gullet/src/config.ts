// CLI/env parsing for the sidecar. Pure so the precedence rules are testable.

import { isBridgePort } from "../../src/bridge-protocol.js";

export type GulletConfig =
  | { portMode: "auto"; token: string }
  | { portMode: "fixed"; port: number; token: string };

export class ConfigError extends Error {}

export const USAGE = `gullet — Tabglutton's agent bridge sidecar

  bun run gullet/gullet.ts [--port <auto|1024-65535>] [--token <token>]

  --port   automatic discovery by default, or a fixed loopback port (env TABGLUTTON_PORT)
  --token  shared token from Tabglutton's options page (env TABGLUTTON_TOKEN)

GULLET_PORT / GULLET_TOKEN are accepted as aliases — users know this as
Tabglutton, "gullet" is only the sidecar's internal name.

The token is required before any browser may connect. Prefer the environment
variable: process arguments are visible to other local users, environments are not.`;

export function parseConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): GulletConfig {
  // Either spelling works, so a user who only ever sees "Tabglutton" in the
  // options page never has to learn that the process is called gullet.
  let port: string | undefined = env.TABGLUTTON_PORT ?? env.GULLET_PORT;
  let token: string | undefined = env.TABGLUTTON_TOKEN ?? env.GULLET_TOKEN;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = splitFlag(arg);
    switch (flag) {
      case "--port":
        port = inline ?? requireValue(flag, argv[++i]);
        break;
      case "--token":
        token = inline ?? requireValue(flag, argv[++i]);
        break;
      default:
        throw new ConfigError(`Unknown argument ${arg}.\n\n${USAGE}`);
    }
  }

  const selection = parsePort(port);
  const cleanToken = (token ?? "").trim();
  return selection === "auto"
    ? { portMode: "auto", token: cleanToken }
    : { portMode: "fixed", port: selection, token: cleanToken };
}

/**
 * A trailing `--port` or `--token` with nothing after it. Rejected rather than
 * defaulted: silently changing a requested fixed port into automatic mode (or
 * a token into empty) turns a typo into a sidecar serving somewhere the user
 * never named, with an error naming neither.
 */
function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new ConfigError(`${flag} needs a value.\n\n${USAGE}`);
  return value;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

function parsePort(raw: string | undefined): "auto" | number {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "auto") return "auto";
  // The whole string or nothing. `Number.parseInt` stops at the first character
  // it does not like and keeps what it has, so `4589oops` and `4589.5` both read
  // as 4589 — a typo would bind a port the user never named, and then every
  // browser that dials the port they *did* name is refused by a sidecar whose
  // error message mentions neither.
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!isBridgePort(port)) {
    throw new ConfigError(`Invalid port "${raw}" — expected an integer in 1024-65535.`);
  }
  return port;
}
