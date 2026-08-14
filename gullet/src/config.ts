// CLI, environment, and global-file configuration for the sidecar.

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  asRecord,
  CONFIG_DIR_NAME,
  DEFAULT_TOKEN_FILE_NAME,
  errorMessage,
  isBridgePort,
} from "../../src/bridge-protocol.js";

export type TokenResolver = () => Promise<string>;

type TokenConfig = {
  /** Already-resolved CLI, environment, or .env token. */
  token: string;
  /** File or command source, retried by Supervisor when it is temporarily unavailable. */
  resolveToken?: TokenResolver;
  /**
   * Whether a Gullet that finds no hub should spawn a detached one and attach
   * to it, rather than binding the port itself. On by default; `--no-detach`
   * pins the old session-scoped shape, which is what to reach for when
   * debugging the hub, since it puts the hub's logs back on this process's
   * stderr.
   */
  detach: boolean;
  /**
   * This process *is* the detached hub. Set only by the flag the spawner
   * passes; there is no configuration file or environment route to it, because
   * nothing but a spawn should ever produce one.
   */
  detachedHub: boolean;
};

export type GulletConfig =
  | ({ portMode: "auto" } & TokenConfig)
  | ({ portMode: "fixed"; port: number } & TokenConfig);

export class ConfigError extends Error {}

export const TOKEN_COMMAND_TIMEOUT_MS = 5_000;

export const USAGE = `tabglutton-gullet — Tabglutton's agent bridge sidecar

  bunx tabglutton-gullet [--port <auto|1024-65535>] [--token <token>] [--no-detach]

  --port   automatic discovery by default, or a fixed loopback port (env TABGLUTTON_PORT)
  --token  shared token from Tabglutton's options page (env TABGLUTTON_TOKEN)

  --no-detach  serve the browser from this process instead of a detached hub

By default the first Gullet that finds no hub running starts one that outlives
it, and attaches to it as a peer; later sessions attach to the same hub. That is
what lets the browser hold a connection that predates your agent session. The
hub exits by itself after six idle hours, and stands aside for a newer Gullet.

GULLET_PORT / GULLET_TOKEN are accepted as aliases — users know this as
Tabglutton, "gullet" is only the sidecar's internal name.

With no token flag or environment variable, Gullet checks ./.env and then
~/.config/tabglutton/config.json. The global config may name tokenFile or
tokenCommand, but may never contain the token itself. Its default token file is
~/.config/tabglutton/token. XDG_CONFIG_HOME replaces ~/.config when set.

The token is required before any browser may connect. Prefer the token file or
environment: process arguments are visible to other local users.`;

interface ParsedFlags {
  port?: string;
  token?: string;
  detach?: boolean;
  detachedHub?: boolean;
}

interface FileConfig {
  port?: string | number;
  tokenFile?: string;
  tokenCommand?: string;
  detach?: boolean;
}

export interface TokenCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ConfigRuntime {
  cwd: string;
  readFile: (path: string) => Promise<string>;
  runTokenCommand: (
    command: string,
    options: {
      cwd: string;
      env: Readonly<Record<string, string | undefined>>;
      timeoutMs: number;
    },
  ) => Promise<TokenCommandResult>;
}

/** Read the global settings and select a token source without executing it. */
export async function loadConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  runtime: ConfigRuntime = defaultRuntime(),
): Promise<GulletConfig> {
  const flags = parseFlags(argv);
  const paths = configPaths(env, runtime.cwd);
  const fileConfig = await readFileConfig(paths.configFile, runtime);

  const rawPort =
    flags.port ?? firstDefined(env, "TABGLUTTON_PORT", "GULLET_PORT") ?? fileConfig.port;
  const selection = parsePort(rawPort);
  const mode: HubMode = {
    // A detached hub never spawns another one; it *is* the answer.
    detach: (flags.detach ?? fileConfig.detach ?? true) && flags.detachedHub !== true,
    detachedHub: flags.detachedHub ?? false,
  };

  // The spawner hands the token over stdin rather than argv, which `ps` would
  // publish. Resolving one here would be at best redundant and at worst wrong —
  // a `tokenCommand` re-run in a process with no terminal can block on a locked
  // secret manager forever.
  if (mode.detachedHub) return assembleConfig(selection, mode, "");

  // A flag or variable that is present but empty still counts as "the token was
  // configured here", so it stops the search rather than falling through to the
  // file sources — hence `!== undefined` rather than a truthiness check.
  const directToken = flags.token ?? firstDefined(env, "TABGLUTTON_TOKEN", "GULLET_TOKEN");
  if (directToken !== undefined) return assembleConfig(selection, mode, directToken.trim());

  const dotEnv = await readOptionalFile(join(runtime.cwd, ".env"), runtime);
  if (dotEnv !== null) {
    const token = firstDefined(parseDotEnv(dotEnv), "TABGLUTTON_TOKEN", "GULLET_TOKEN");
    if (token !== undefined) return assembleConfig(selection, mode, token.trim());
  }

  if (fileConfig.tokenCommand !== undefined) {
    const command = fileConfig.tokenCommand;
    return assembleConfig(
      selection,
      mode,
      "",
      tokenCommandResolver(command, dirname(paths.configFile), env, runtime),
    );
  }

  const tokenFile = resolveConfigPath(
    fileConfig.tokenFile ?? paths.defaultTokenFile,
    dirname(paths.configFile),
    paths.home,
  );
  return assembleConfig(selection, mode, "", tokenFileResolver(tokenFile, runtime));
}

type HubMode = Pick<TokenConfig, "detach" | "detachedHub">;

function assembleConfig(
  selection: "auto" | number,
  mode: HubMode,
  token: string,
  resolveToken?: TokenResolver,
): GulletConfig {
  return selection === "auto"
    ? { portMode: "auto", token, resolveToken, ...mode }
    : { portMode: "fixed", port: selection, token, resolveToken, ...mode };
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const parsed: ParsedFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = splitFlag(arg);
    switch (flag) {
      case "--port":
        parsed.port = inline ?? requireValue(flag, argv[++i]);
        break;
      case "--token":
        parsed.token = inline ?? requireValue(flag, argv[++i]);
        break;
      case "--detach":
        parsed.detach = true;
        break;
      case "--no-detach":
        parsed.detach = false;
        break;
      case "--detached-hub":
        parsed.detachedHub = true;
        break;
      default:
        throw new ConfigError(`Unknown argument ${arg}.\n\n${USAGE}`);
    }
  }
  return parsed;
}

/**
 * A trailing flag with nothing after it is rejected rather than silently
 * changing a requested port or token into a default.
 */
function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new ConfigError(`${flag} needs a value.\n\n${USAGE}`);
  return value;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

function parsePort(raw: string | number | undefined): "auto" | number {
  const value = String(raw ?? "").trim();
  if (value === "" || value === "auto") return "auto";
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!isBridgePort(port)) {
    throw new ConfigError(
      `Invalid port "${String(raw)}" — expected auto or an integer in 1024-65535.`,
    );
  }
  return port;
}

function firstDefined(
  values: Readonly<Record<string, string | undefined>>,
  primary: string,
  alias: string,
): string | undefined {
  return values[primary] !== undefined ? values[primary] : values[alias];
}

function configPaths(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): { configFile: string; defaultTokenFile: string; home: string } {
  const home = env.HOME?.trim() || homedir();
  const configuredRoot = env.XDG_CONFIG_HOME?.trim();
  const root = configuredRoot
    ? resolveConfigPath(configuredRoot, cwd, home)
    : join(home, ".config");
  const directory = join(root, CONFIG_DIR_NAME);
  return {
    configFile: join(directory, "config.json"),
    defaultTokenFile: join(directory, DEFAULT_TOKEN_FILE_NAME),
    home,
  };
}

function resolveConfigPath(path: string, base: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

async function readFileConfig(path: string, runtime: ConfigRuntime): Promise<FileConfig> {
  const text = await readOptionalFile(path, runtime);
  if (text === null) return {};

  let parsed: unknown;
  try {
    // The documented file is JSONC so a committed settings file can explain a
    // secret-manager command or keep a trailing comma without a preprocessor.
    parsed = Bun.JSONC.parse(text);
  } catch (err) {
    throw new ConfigError(`Could not parse ${path}: ${errorMessage(err)}`);
  }
  const parsedConfig = asRecord(parsed);
  if (!parsedConfig) throw new ConfigError(`${path} must contain a JSON object.`);
  if (Object.hasOwn(parsedConfig, "token")) {
    throw new ConfigError(
      `${path} may not contain "token". Put the secret in the default token file, ` +
        `or configure "tokenFile" or "tokenCommand" instead.`,
    );
  }

  const allowed = new Set(["port", "tokenFile", "tokenCommand", "detach"]);
  const unknown = Object.keys(parsedConfig).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new ConfigError(`Unknown key "${unknown}" in ${path}.`);

  const nonEmptyString = (key: "tokenFile" | "tokenCommand", noun: string): string | undefined => {
    const value = parsedConfig[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigError(`"${key}" in ${path} must be a non-empty ${noun}.`);
    }
    return value;
  };

  const config: FileConfig = {};
  if (parsedConfig.port !== undefined) {
    if (typeof parsedConfig.port !== "string" && typeof parsedConfig.port !== "number") {
      throw new ConfigError(`"port" in ${path} must be "auto" or a number.`);
    }
    config.port = parsedConfig.port;
  }
  if (parsedConfig.detach !== undefined) {
    if (typeof parsedConfig.detach !== "boolean") {
      throw new ConfigError(`"detach" in ${path} must be true or false.`);
    }
    config.detach = parsedConfig.detach;
  }
  config.tokenFile = nonEmptyString("tokenFile", "path");
  config.tokenCommand = nonEmptyString("tokenCommand", "command");
  if (config.tokenFile !== undefined && config.tokenCommand !== undefined) {
    throw new ConfigError(`${path} must choose either "tokenFile" or "tokenCommand", not both.`);
  }
  return config;
}

function tokenFileResolver(path: string, runtime: ConfigRuntime): TokenResolver {
  return async () => {
    let token: string;
    try {
      token = (await runtime.readFile(path)).trim();
    } catch (err) {
      throw new ConfigError(
        `Could not read Tabglutton's token file at ${path}: ${errorMessage(err)}. ` +
          `Open Tabglutton's settings and copy the setup command again.`,
      );
    }
    if (!token) {
      throw new ConfigError(
        `Tabglutton's token file at ${path} is empty. ` +
          `Open Tabglutton's settings and copy the setup command again.`,
      );
    }
    return token;
  };
}

function tokenCommandResolver(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  runtime: ConfigRuntime,
): TokenResolver {
  return async () => {
    const result = await runtime.runTokenCommand(command, {
      cwd,
      env,
      timeoutMs: TOKEN_COMMAND_TIMEOUT_MS,
    });
    const stderr = result.stderr.trim();
    const detail = stderr ? ` Stderr: ${stderr}` : "";
    if (result.timedOut) {
      throw new ConfigError(
        `Tabglutton tokenCommand timed out after ${TOKEN_COMMAND_TIMEOUT_MS}ms.${detail}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new ConfigError(`Tabglutton tokenCommand exited ${result.exitCode}.${detail}`);
    }
    const token = result.stdout.trim();
    if (!token) throw new ConfigError(`Tabglutton tokenCommand returned an empty token.${detail}`);
    return token;
  };
}

async function readOptionalFile(path: string, runtime: ConfigRuntime): Promise<string | null> {
  try {
    return await runtime.readFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new ConfigError(`Could not read ${path}: ${errorMessage(err)}`);
  }
}

function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function defaultRuntime(): ConfigRuntime {
  return {
    cwd: process.cwd(),
    readFile: async (path) => Bun.file(path).text(),
    runTokenCommand: runTokenCommand,
  };
}

export async function runTokenCommand(
  command: string,
  options: {
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
    timeoutMs: number;
  },
): Promise<TokenCommandResult> {
  const env = Object.fromEntries(
    Object.entries(options.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const subprocess = Bun.spawn(["sh", "-c", command], {
    cwd: options.cwd,
    // A command is allowed to run children (op, rage, a credential helper).
    // Give the shell its own process group so the deadline can stop the whole
    // pipeline instead of killing only sh and then hanging on inherited pipes.
    detached: true,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(subprocess.stdout).text();
  const stderr = new Response(subprocess.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = Promise.all([subprocess.exited, stdout, stderr]).then(
    ([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr, timedOut: false as const }),
  );
  const outcome = await Promise.race([
    completed,
    new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), options.timeoutMs);
    }),
  ]);
  if (!outcome.timedOut) {
    if (timer !== undefined) clearTimeout(timer);
    return outcome;
  }

  // The shell can exit while a background child keeps its output pipes open.
  // The deadline therefore covers process exit *and* pipe drain; kill the
  // detached process group so those inherited descriptors close as well.
  try {
    process.kill(-subprocess.pid, "SIGKILL");
  } catch {
    subprocess.kill("SIGKILL");
  }
  const drained = await completed;
  return { ...drained, exitCode: -1, timedOut: true };
}

function isNotFound(err: unknown): boolean {
  return asRecord(err)?.code === "ENOENT";
}
