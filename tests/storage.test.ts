// Tests cover the pure helpers in storage.ts only.
// loadSettings/saveSettings require browser.storage.local and are out of scope.
import { describe, test, expect } from "bun:test";
import { DEFAULT_BRIDGE_PORT } from "../src/bridge-protocol.js";
import { defaults, normalizeOptsFrom, type Settings } from "../src/storage.js";
import { IS_CHROME } from "../src/target.js";

describe("defaults()", () => {
  test("returns the documented default values", () => {
    expect(defaults()).toEqual({
      stripFragment: true,
      extraStripParams: [],
      // Chrome forces current-window; Firefox/Zen uses the workspace heuristic.
      scope: IS_CHROME ? "current-window" : "hidden-false",
      heuristicWarning: false,
      obsidianVault: "",
      clippingsBaseFolder: "Clippings",
      clipMode: "clipboard",
      onboardingComplete: false,
      bridgeEnabled: false,
      bridgePort: DEFAULT_BRIDGE_PORT,
      bridgeToken: "",
      bridgeAllowTabLoad: false,
    });
  });

  test("onboardingComplete defaults to false (first-run flow gate)", () => {
    expect(defaults().onboardingComplete).toBe(false);
  });

  test("the agent bridge is off until the user opts in", () => {
    expect(defaults().bridgeEnabled).toBe(false);
    expect(defaults().bridgeToken).toBe("");
  });

  // Its own opt-in, not a consequence of enabling the bridge: loading is the one
  // bridge method that acts on a page rather than reading one.
  test("letting agents load tabs stays off even once the bridge is on", () => {
    expect(defaults().bridgeAllowTabLoad).toBe(false);
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
      clippingsBaseFolder: "Inbox",
      clipMode: "clipboard",
      onboardingComplete: true,
      bridgeEnabled: false,
      bridgePort: DEFAULT_BRIDGE_PORT,
      bridgeToken: "",
      bridgeAllowTabLoad: false,
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
