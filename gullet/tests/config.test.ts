import { describe, test, expect } from "bun:test";
import { DEFAULT_BRIDGE_PORT } from "../../src/bridge-protocol.js";
import { ConfigError, parseConfig } from "../src/config.js";

describe("parseConfig()", () => {
  test("defaults to the documented port and no token", () => {
    expect(parseConfig([], {})).toEqual({ port: DEFAULT_BRIDGE_PORT, token: "" });
  });

  test("reads the token and port from the environment", () => {
    expect(parseConfig([], { GULLET_TOKEN: "abc", GULLET_PORT: "5000" })).toEqual({
      port: 5000,
      token: "abc",
    });
  });

  test("flags override the environment", () => {
    const config = parseConfig(["--port", "5001", "--token", "flag"], {
      GULLET_PORT: "5000",
      GULLET_TOKEN: "env",
    });
    expect(config).toEqual({ port: 5001, token: "flag" });
  });

  test("accepts --flag=value form", () => {
    expect(parseConfig(["--port=5002", "--token=xyz"], {})).toEqual({ port: 5002, token: "xyz" });
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

  test("falls back to the default for an empty port value", () => {
    expect(parseConfig([], { GULLET_PORT: "" }).port).toBe(DEFAULT_BRIDGE_PORT);
  });

  test("rejects unknown arguments with usage text", () => {
    expect(() => parseConfig(["--daemon"], {})).toThrow(/Unknown argument --daemon/);
  });
});
