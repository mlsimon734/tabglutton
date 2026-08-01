import { describe, test, expect } from "bun:test";
import { ConfigError, parseConfig } from "../src/config.js";

describe("parseConfig()", () => {
  test("defaults to automatic discovery and no token", () => {
    expect(parseConfig([], {})).toEqual({ portMode: "auto", token: "" });
  });

  test("reads the token and port from the environment", () => {
    expect(parseConfig([], { GULLET_TOKEN: "abc", GULLET_PORT: "5000" })).toEqual({
      portMode: "fixed",
      port: 5000,
      token: "abc",
    });
  });

  test("accepts TABGLUTTON_* as the primary spelling", () => {
    expect(parseConfig([], { TABGLUTTON_TOKEN: "abc", TABGLUTTON_PORT: "5000" })).toEqual({
      portMode: "fixed",
      port: 5000,
      token: "abc",
    });
  });

  test("prefers TABGLUTTON_* when both spellings are set", () => {
    const config = parseConfig([], {
      TABGLUTTON_TOKEN: "new",
      GULLET_TOKEN: "old",
      TABGLUTTON_PORT: "5002",
      GULLET_PORT: "5000",
    });
    expect(config).toEqual({ portMode: "fixed", port: 5002, token: "new" });
  });

  test("flags override the environment", () => {
    const config = parseConfig(["--port", "5001", "--token", "flag"], {
      GULLET_PORT: "5000",
      GULLET_TOKEN: "env",
    });
    expect(config).toEqual({ portMode: "fixed", port: 5001, token: "flag" });
  });

  test("accepts --flag=value form", () => {
    expect(parseConfig(["--port=5002", "--token=xyz"], {})).toEqual({
      portMode: "fixed",
      port: 5002,
      token: "xyz",
    });
  });

  test("trims surrounding whitespace off a pasted token", () => {
    expect(parseConfig([], { GULLET_TOKEN: "  abc\n" }).token).toBe("abc");
  });

  test("rejects a port outside the bindable range", () => {
    expect(() => parseConfig(["--port", "80"], {})).toThrow(ConfigError);
    expect(() => parseConfig(["--port", "70000"], {})).toThrow(ConfigError);
  });

  test("rejects a non-numeric port instead of silently defaulting", () => {
    expect(() => parseConfig(["--port", "abc"], {})).toThrow(ConfigError);
  });

  test("rejects a port that is only partly a number", () => {
    // `parseInt` keeps the digits it managed to read and discards the rest, so
    // each of these used to bind 4589 — a port the user never asked for, while
    // every browser dialling the one they did ask for is refused.
    for (const raw of ["4589oops", "4589.5", "4589 4590", "0x4589", "+4589"]) {
      expect(() => parseConfig(["--port", raw], {})).toThrow(ConfigError);
      expect(() => parseConfig([], { TABGLUTTON_PORT: raw })).toThrow(ConfigError);
    }
  });

  test("uses automatic discovery for an empty or explicit auto port", () => {
    expect(parseConfig([], { GULLET_PORT: "" })).toEqual({ portMode: "auto", token: "" });
    expect(parseConfig(["--port", "auto"], {})).toEqual({ portMode: "auto", token: "" });
    expect(parseConfig([], { TABGLUTTON_PORT: "auto" })).toEqual({
      portMode: "auto",
      token: "",
    });
  });

  test("rejects unknown arguments with usage text", () => {
    expect(() => parseConfig(["--daemon"], {})).toThrow(/Unknown argument --daemon/);
  });
});

describe("flags with no value", () => {
  test("rejects a trailing --port rather than silently defaulting", () => {
    // Defaulting turns a typo into a sidecar that binds the wrong port and then
    // reports a failure naming neither the flag nor the port.
    expect(() => parseConfig(["--port"], {})).toThrow(ConfigError);
    expect(() => parseConfig(["--port"], {})).toThrow("--port needs a value");
  });

  test("rejects a trailing --token rather than starting with none", () => {
    expect(() => parseConfig(["--token"], {})).toThrow("--token needs a value");
  });

  test("still accepts an explicitly empty value", () => {
    // `--token=` is a deliberate override of an inherited environment variable.
    expect(parseConfig(["--token="], { TABGLUTTON_TOKEN: "inherited" }).token).toBe("");
  });
});
