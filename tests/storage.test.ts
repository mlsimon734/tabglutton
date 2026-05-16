// Tests cover the pure helpers in storage.ts only.
// loadSettings/saveSettings require browser.storage.local and are out of scope.
import { describe, test, expect } from "bun:test";
import { defaults, normalizeOptsFrom, type Settings } from "../src/storage.js";

describe("defaults()", () => {
  test("returns the documented default values", () => {
    expect(defaults()).toEqual({
      stripFragment: true,
      extraStripParams: [],
      scope: "hidden-false",
      heuristicWarning: false,
      obsidianVault: "",
      clipMode: "clipboard",
      onboardingComplete: false,
    });
  });

  test("onboardingComplete defaults to false (first-run flow gate)", () => {
    expect(defaults().onboardingComplete).toBe(false);
  });

  test("mutating the result does not affect subsequent calls (extraStripParams is cloned)", () => {
    const a = defaults();
    a.extraStripParams.push("campaign");
    a.obsidianVault = "MyVault";
    const b = defaults();
    expect(b.extraStripParams).toEqual([]);
    expect(b.obsidianVault).toBe("");
  });

  test("each call returns a fresh object", () => {
    expect(defaults()).not.toBe(defaults());
  });
});

describe("normalizeOptsFrom()", () => {
  test("maps Settings to NormalizeOpts", () => {
    const settings: Settings = {
      stripFragment: false,
      extraStripParams: ["campaign", "ref_x"],
      scope: "current-window",
      heuristicWarning: true,
      obsidianVault: "v",
      clipMode: "clipboard",
      onboardingComplete: true,
    };
    expect(normalizeOptsFrom(settings)).toEqual({
      stripFragment: false,
      extraStripParams: ["campaign", "ref_x"],
    });
  });

  test("works with default settings", () => {
    expect(normalizeOptsFrom(defaults())).toEqual({
      stripFragment: true,
      extraStripParams: [],
    });
  });
});
