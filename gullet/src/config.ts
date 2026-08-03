// CLI, environment, and global-file configuration for the sidecar.

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isBridgePort } from "../../src/bridge-protocol.js";

export type TokenResolver = () => Promise<string>;

type TokenConfig = {
  /** Already-resolved CLI, environment, or .env token. */
  token: string;
  /** File or command source, retried by Supervisor when it is temporarily unavailable. */
  resolveToken?: TokenResolver;
};

export type GulletConfig =
  | ({ portMode: "auto" } & TokenConfig)
  | ({ portMode: "fixed"; port: number } & TokenConfig);

export class ConfigError extends Error {}

export const TOKEN_COMMAND_TIMEOUT_MS = 5_000;

export const USAGE = `tabglutton-gullet — Tabglutton's agent bridge sidecar

  bunx tabglutton-gullet [--port <auto|1024-65535>] [--token <token>]

  --port   automatic discovery by default, or a fixed loopback port (env TABGLUTTON_PORT)
  --token  shared token from Tabglutton's options page (env TABGLUTTON_TOKEN)

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
  portSet: boolean;
  token?: string;
  tokenSet: boolean;
}

interface FileConfig {
  port?: string | number;
  tokenFile?: string;
  tokenCommand?: string;
}

interface TokenCommandResult {
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

/**
 * The old pure CLI/env surface remains useful to callers and unit tests. File
 * access lives in loadConfig(), which main uses.
 */
export function parseConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): GulletConfig {
  const flags = parseFlags(argv);
  const port = flags.portSet ? flags.port : firstDefined(env, "TABGLUTTON_PORT", "GULLET_PORT");
  const token = flags.tokenSet
    ? flags.token
    : firstDefined(env, "TABGLUTTON_TOKEN", "GULLET_TOKEN");
  return assembleConfig(parsePort(port), (token ?? "").trim());
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

  const rawPort = flags.portSet
    ? flags.port
    : (firstDefined(env, "TABGLUTTON_PORT", "GULLET_PORT") ?? fileConfig.port);
  const selection = parsePort(rawPort);

  const directToken = flags.tokenSet
    ? { set: true, value: flags.token }
    : definedEnv(env, "TABGLUTTON_TOKEN", "GULLET_TOKEN");
  if (directToken.set) return assembleConfig(selection, (directToken.value ?? "").trim());

  const dotEnv = await readOptionalFile(join(runtime.cwd, ".env"), runtime);
  if (dotEnv !== null) {
    const values = parseDotEnv(dotEnv);
    const token = definedEnv(values, "TABGLUTTON_TOKEN", "GULLET_TOKEN");
    if (token.set) return assembleConfig(selection, (token.value ?? "").trim());
  }

  if (fileConfig.tokenCommand !== undefined) {
    const command = fileConfig.tokenCommand;
    return assembleConfig(
      selection,
      "",
      tokenCommandResolver(command, dirname(paths.configFile), env, runtime),
    );
  }

  const tokenFile = resolveConfigPath(
    fileConfig.tokenFile ?? paths.defaultTokenFile,
    dirname(paths.configFile),
    paths.home,
  );
  return assembleConfig(selection, "", tokenFileResolver(tokenFile, runtime));
}

function assembleConfig(
  selection: "auto" | number,
  token: string,
  resolveToken?: TokenResolver,
): GulletConfig {
  const tokenConfig = resolveToken === undefined ? { token } : { token, resolveToken };
  return selection === "auto"
    ? { portMode: "auto", ...tokenConfig }
    : { portMode: "fixed", port: selection, ...tokenConfig };
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const parsed: ParsedFlags = { portSet: false, tokenSet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = splitFlag(arg);
    switch (flag) {
      case "--port":
        parsed.port = inline ?? requireValue(flag, argv[++i]);
        parsed.portSet = true;
        break;
      case "--token":
        parsed.token = inline ?? requireValue(flag, argv[++i]);
        parsed.tokenSet = true;
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

function definedEnv(
  values: Readonly<Record<string, string | undefined>>,
  primary: string,
  alias: string,
): { set: boolean; value?: string } {
  if (values[primary] !== undefined) return { set: true, value: values[primary] };
  if (values[alias] !== undefined) return { set: true, value: values[alias] };
  return { set: false };
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
  const directory = join(root, "tabglutton");
  return {
    configFile: join(directory, "config.json"),
    defaultTokenFile: join(directory, "token"),
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
    throw new ConfigError(`Could not parse ${path}: ${messageOf(err)}`);
  }
  if (!isRecord(parsed)) throw new ConfigError(`${path} must contain a JSON object.`);
  if (Object.hasOwn(parsed, "token")) {
    throw new ConfigError(
      `${path} may not contain "token". Put the secret in the default token file, ` +
        `or configure "tokenFile" or "tokenCommand" instead.`,
    );
  }

  const allowed = new Set(["port", "tokenFile", "tokenCommand"]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new ConfigError(`Unknown key "${unknown}" in ${path}.`);

  const config: FileConfig = {};
  if (parsed.port !== undefined) {
    if (typeof parsed.port !== "string" && typeof parsed.port !== "number") {
      throw new ConfigError(`"port" in ${path} must be "auto" or a number.`);
    }
    config.port = parsed.port;
  }
  if (parsed.tokenFile !== undefined) {
    if (typeof parsed.tokenFile !== "string" || parsed.tokenFile.trim() === "") {
      throw new ConfigError(`"tokenFile" in ${path} must be a non-empty path.`);
    }
    config.tokenFile = parsed.tokenFile;
  }
  if (parsed.tokenCommand !== undefined) {
    if (typeof parsed.tokenCommand !== "string" || parsed.tokenCommand.trim() === "") {
      throw new ConfigError(`"tokenCommand" in ${path} must be a non-empty command.`);
    }
    config.tokenCommand = parsed.tokenCommand;
  }
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
        `Could not read Tabglutton's token file at ${path}: ${messageOf(err)}. ` +
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
    throw new ConfigError(`Could not read ${path}: ${messageOf(err)}`);
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

async function runTokenCommand(
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
  const outcome = await Promise.race([
    subprocess.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    new Promise<{ exitCode: number; timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ exitCode: -1, timedOut: true }), options.timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.timedOut) {
    try {
      process.kill(-subprocess.pid, "SIGKILL");
    } catch {
      subprocess.kill("SIGKILL");
    }
    await subprocess.exited;
  }
  return { ...outcome, stdout: await stdout, stderr: await stderr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err.code === "ENOENT";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
