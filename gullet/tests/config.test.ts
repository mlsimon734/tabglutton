import { describe, test, expect } from "bun:test";
import {
  ConfigError,
  loadConfig,
  runTokenCommand,
  TOKEN_COMMAND_TIMEOUT_MS,
  type ConfigRuntime,
  type GulletConfig,
} from "../src/config.js";

function missing(path: string): Error & { code: string } {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

function runtime(
  files: Readonly<Record<string, string>>,
  runTokenCommand: ConfigRuntime["runTokenCommand"] = async () => ({
    exitCode: 0,
    stdout: "command-token\n",
    stderr: "",
    timedOut: false,
  }),
): ConfigRuntime {
  return {
    cwd: "/workspace",
    readFile: async (path) => {
      const value = files[path];
      if (value === undefined) throw missing(path);
      return value;
    },
    runTokenCommand,
  };
}

/**
 * The CLI/env half of loadConfig, with every file absent so the runtime is pure.
 * These used to run against a separate `parseConfig`, which meant the precedence
 * rules had two implementations and the tested one was not the one that shipped.
 */
function parsed(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<GulletConfig> {
  return loadConfig(argv, env, runtime({}));
}

/** Port and token only: with no token configured, loadConfig also attaches a resolver. */
async function selection(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<{ portMode: string; port?: number; token: string }> {
  const config = await parsed(argv, env);
  return config.portMode === "fixed"
    ? { portMode: "fixed", port: config.port, token: config.token }
    : { portMode: "auto", token: config.token };
}

describe("CLI and environment precedence", () => {
  test("defaults to automatic discovery and no token", async () => {
    expect(await selection([])).toEqual({ portMode: "auto", token: "" });
  });

  test("reads the token and port from the environment", async () => {
    expect(await selection([], { GULLET_TOKEN: "abc", GULLET_PORT: "5000" })).toEqual({
      portMode: "fixed",
      port: 5000,
      token: "abc",
    });
  });

  test("accepts TABGLUTTON_* as the primary spelling", async () => {
    expect(await selection([], { TABGLUTTON_TOKEN: "abc", TABGLUTTON_PORT: "5000" })).toEqual({
      portMode: "fixed",
      port: 5000,
      token: "abc",
    });
  });

  test("prefers TABGLUTTON_* when both spellings are set", async () => {
    const config = await selection([], {
      TABGLUTTON_TOKEN: "new",
      GULLET_TOKEN: "old",
      TABGLUTTON_PORT: "5002",
      GULLET_PORT: "5000",
    });
    expect(config).toEqual({ portMode: "fixed", port: 5002, token: "new" });
  });

  test("flags override the environment", async () => {
    const config = await selection(["--port", "5001", "--token", "flag"], {
      GULLET_PORT: "5000",
      GULLET_TOKEN: "env",
    });
    expect(config).toEqual({ portMode: "fixed", port: 5001, token: "flag" });
  });

  test("accepts --flag=value form", async () => {
    expect(await selection(["--port=5002", "--token=xyz"])).toEqual({
      portMode: "fixed",
      port: 5002,
      token: "xyz",
    });
  });

  test("trims surrounding whitespace off a pasted token", async () => {
    expect((await parsed([], { GULLET_TOKEN: "  abc\n" })).token).toBe("abc");
  });

  test("rejects a port outside the bindable range", async () => {
    expect(parsed(["--port", "80"])).rejects.toThrow(ConfigError);
    expect(parsed(["--port", "70000"])).rejects.toThrow(ConfigError);
  });

  test("rejects a non-numeric port instead of silently defaulting", async () => {
    expect(parsed(["--port", "abc"])).rejects.toThrow(ConfigError);
  });

  test("rejects a port that is only partly a number", async () => {
    // `parseInt` keeps the digits it managed to read and discards the rest, so
    // each of these used to bind 4589 — a port the user never asked for, while
    // every browser dialling the one they did ask for is refused.
    for (const raw of ["4589oops", "4589.5", "4589 4590", "0x4589", "+4589"]) {
      expect(parsed(["--port", raw])).rejects.toThrow(ConfigError);
      expect(parsed([], { TABGLUTTON_PORT: raw })).rejects.toThrow(ConfigError);
    }
  });

  test("uses automatic discovery for an empty or explicit auto port", async () => {
    expect(await selection([], { GULLET_PORT: "" })).toEqual({ portMode: "auto", token: "" });
    expect(await selection(["--port", "auto"])).toEqual({ portMode: "auto", token: "" });
    expect(await selection([], { TABGLUTTON_PORT: "auto" })).toEqual({
      portMode: "auto",
      token: "",
    });
  });

  test("rejects unknown arguments with usage text", async () => {
    expect(parsed(["--daemon"])).rejects.toThrow(/Unknown argument --daemon/);
  });
});

describe("flags with no value", () => {
  test("rejects a trailing --port rather than silently defaulting", async () => {
    // Defaulting turns a typo into a sidecar that binds the wrong port and then
    // reports a failure naming neither the flag nor the port.
    expect(parsed(["--port"])).rejects.toThrow(ConfigError);
    expect(parsed(["--port"])).rejects.toThrow("--port needs a value");
  });

  test("rejects a trailing --token rather than starting with none", async () => {
    expect(parsed(["--token"])).rejects.toThrow("--token needs a value");
  });

  test("still accepts an explicitly empty value", async () => {
    // `--token=` is a deliberate override of an inherited environment variable,
    // and stops the search rather than falling through to the file sources.
    const config = await parsed(["--token="], { TABGLUTTON_TOKEN: "inherited" });
    expect(config.token).toBe("");
    expect(config.resolveToken).toBeUndefined();
  });
});

describe("loadConfig()", () => {
  test("uses XDG_CONFIG_HOME for settings and the default token file", async () => {
    const config = await loadConfig(
      [],
      { HOME: "/home/michael", XDG_CONFIG_HOME: "/xdg" },
      runtime({
        "/xdg/tabglutton/config.json": '{"port": 5003}',
        "/xdg/tabglutton/token": " file-token\n",
      }),
    );
    expect(config).toMatchObject({ portMode: "fixed", port: 5003, token: "" });
    expect(await config.resolveToken?.()).toBe("file-token");
  });

  test("resolves a relative tokenFile from the config directory", async () => {
    const config = await loadConfig(
      [],
      { HOME: "/home/michael" },
      runtime({
        "/home/michael/.config/tabglutton/config.json": '{"tokenFile":"secret/token"}',
        "/home/michael/.config/tabglutton/secret/token": "abc",
      }),
    );
    expect(await config.resolveToken?.()).toBe("abc");
  });

  test("accepts comments and trailing commas in the global settings", async () => {
    const config = await loadConfig(
      [],
      { HOME: "/home/michael" },
      runtime({
        "/home/michael/.config/tabglutton/config.json": `{
          // Safe to commit: the secret stays in the referenced file.
          "port": "auto",
          "tokenFile": "token",
        }`,
        "/home/michael/.config/tabglutton/token": "abc",
      }),
    );
    expect(await config.resolveToken?.()).toBe("abc");
  });

  test("uses CLI, environment, and .env tokens in precedence order", async () => {
    const files = {
      "/workspace/.env": "GULLET_TOKEN=dot-env\nTABGLUTTON_TOKEN='dot-primary'\n",
      "/home/michael/.config/tabglutton/config.json":
        '{"tokenCommand":"secret command","port":5004}',
    };
    const fromDotEnv = await loadConfig([], { HOME: "/home/michael" }, runtime(files));
    expect(fromDotEnv).toEqual({ portMode: "fixed", port: 5004, token: "dot-primary" });

    const fromEnv = await loadConfig(
      [],
      { HOME: "/home/michael", TABGLUTTON_TOKEN: "env" },
      runtime(files),
    );
    expect(fromEnv.token).toBe("env");

    const fromFlag = await loadConfig(
      ["--token", "flag"],
      { HOME: "/home/michael", TABGLUTTON_TOKEN: "env" },
      runtime(files),
    );
    expect(fromFlag.token).toBe("flag");
  });

  test("executes tokenCommand lazily with a bounded wait and config-directory cwd", async () => {
    let call: { command: string; cwd: string; timeoutMs: number } | undefined;
    const config = await loadConfig(
      [],
      { HOME: "/home/michael" },
      runtime(
        {
          "/home/michael/.config/tabglutton/config.json":
            '{"tokenCommand":"op read op://Private/Tabglutton/token"}',
        },
        async (command, options) => {
          call = { command, cwd: options.cwd, timeoutMs: options.timeoutMs };
          return { exitCode: 0, stdout: "from-op\n", stderr: "", timedOut: false };
        },
      ),
    );

    expect(call).toBeUndefined();
    expect(await config.resolveToken?.()).toBe("from-op");
    expect(call).toEqual({
      command: "op read op://Private/Tabglutton/token",
      cwd: "/home/michael/.config/tabglutton",
      timeoutMs: TOKEN_COMMAND_TIMEOUT_MS,
    });
  });

  test("attaches tokenCommand stderr to timeout and exit errors", async () => {
    const config = await loadConfig(
      [],
      { HOME: "/home/michael" },
      runtime(
        {
          "/home/michael/.config/tabglutton/config.json": '{"tokenCommand":"op read item"}',
        },
        async () => ({
          exitCode: -1,
          stdout: "",
          stderr: "1Password is locked",
          timedOut: true,
        }),
      ),
    );
    await expect(config.resolveToken?.()).rejects.toThrow(
      `timed out after ${TOKEN_COMMAND_TIMEOUT_MS}ms. Stderr: 1Password is locked`,
    );
  });

  test("rejects an inline token even when a higher-precedence token is present", async () => {
    await expect(
      loadConfig(
        ["--token", "safe-elsewhere"],
        { HOME: "/home/michael" },
        runtime({
          "/home/michael/.config/tabglutton/config.json": '{"token":"must-not-be-here"}',
        }),
      ),
    ).rejects.toThrow(/may not contain "token".*tokenFile.*tokenCommand/);
  });

  test("rejects simultaneous tokenFile and tokenCommand sources", async () => {
    await expect(
      loadConfig(
        [],
        { HOME: "/home/michael" },
        runtime({
          "/home/michael/.config/tabglutton/config.json":
            '{"tokenFile":"token","tokenCommand":"op read item"}',
        }),
      ),
    ).rejects.toThrow(/either "tokenFile" or "tokenCommand"/);
  });
});

describe("runTokenCommand()", () => {
  test("keeps the deadline active while a background child holds the output pipes", async () => {
    const started = performance.now();
    const result = await runTokenCommand("sleep 30 & printf token", {
      cwd: process.cwd(),
      env: { PATH: Bun.env.PATH },
      timeoutMs: 100,
    });

    expect(result.timedOut).toBeTrue();
    expect(result.stdout).toBe("token");
    expect(performance.now() - started).toBeLessThan(1_500);
  }, 2_000);
});
