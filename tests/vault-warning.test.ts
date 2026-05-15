import { describe, test, expect } from "bun:test";
import { vaultWarningFor } from "../src/vault-warning.js";

describe("vaultWarningFor", () => {
  test("returns empty for an empty string", () => {
    expect(vaultWarningFor("")).toBe("");
  });

  test("returns empty for a plain vault name", () => {
    expect(vaultWarningFor("My Vault")).toBe("");
  });

  test("trims surrounding whitespace before validating", () => {
    expect(vaultWarningFor("   My Vault   ")).toBe("");
  });

  test("warns when value starts with ~", () => {
    expect(vaultWarningFor("~/Documents/Vault")).toContain("filesystem path");
  });

  test("warns when value starts with /", () => {
    expect(vaultWarningFor("/Users/foo/vault")).toContain("filesystem path");
  });

  test("warns when value contains / but does not start with ~ or /", () => {
    expect(vaultWarningFor("Notes/Daily")).toContain('shouldn\'t contain "/"');
  });
});
