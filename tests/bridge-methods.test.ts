import { describe, expect, test } from "bun:test";
import { isNoInjectionTargetError } from "../src/bridge-methods.js";

describe("isNoInjectionTargetError()", () => {
  test("recognizes Gecko's empty-result injection rejection", () => {
    expect(isNoInjectionTargetError("Missing host permission for the tab")).toBe(true);
    expect(isNoInjectionTargetError("Error: Missing host permission for the tab.")).toBe(true);
    // Gecko appends " or frames" unless the injection targeted frame 0 alone.
    expect(isNoInjectionTargetError("Missing host permission for the tab or frames")).toBe(true);
  });

  test("does not retry unrelated extraction or access failures", () => {
    expect(isNoInjectionTargetError("Cannot access contents of url")).toBe(false);
    expect(isNoInjectionTargetError("Defuddle could not parse this page")).toBe(false);
    expect(isNoInjectionTargetError(undefined)).toBe(false);
  });
});
