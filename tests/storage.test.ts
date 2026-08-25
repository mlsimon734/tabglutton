// Tests cover the pure helpers in storage.ts only.
// loadSettings/saveSettings require browser.storage.local and are out of scope.
import { describe, test, expect } from "bun:test";
import { DEFAULT_BRIDGE_PORT } from "../src/bridge-protocol.js";
import {
  bridgePortModeFromStored,
  clipDestinationFor,
  clipNeedsPageAccess,
  defaults,
  hasClipDestination,
  normalizeOptsFrom,
  type Settings,
} from "../src/storage.js";
import { seedRules } from "../src/site-rules.js";
import { IS_CHROME } from "../src/target.js";

describe("defaults()", () => {
  test("returns the documented default values", () => {
    expect(defaults()).toEqual({
      stripFragment: true,
      extraStripParams: [],
      // Chrome forces current-window; Firefox/Zen uses the workspace heuristic.
      scope: IS_CHROME ? "current-window" : "hidden-false",
      heuristicWarning: false,
      clipDestination: "obsidian",
      obsidianVault: "",
      clippingsBaseFolder: "Clippings",
      clipMode: "clipboard",
      siteRules: seedRules(),
      groupingSkipList: [],
      zoteroRoutingEnabled: false,
      zoteroConnectorId: IS_CHROME ? "ekhagklcjbdpajgpjgmbionohlpdbjgc" : "zotero@chnm.gmu.edu",
      optionsInTab: true,
      onboardingComplete: false,
      bridgeEnabled: false,
      bridgePortMode: "auto",
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

describe("hasClipDestination()", () => {
  test("a fresh install has nowhere to clip", () => {
    expect(hasClipDestination(defaults())).toBe(false);
    expect(hasClipDestination(null)).toBe(false);
  });

  test("file mode always has somewhere — the download folder needs no setup", () => {
    expect(hasClipDestination({ ...defaults(), clipDestination: "file" })).toBe(true);
  });

  test("Obsidian mode still needs a vault, and a file destination is never inferred", () => {
    expect(hasClipDestination({ ...defaults(), obsidianVault: "MyVault" })).toBe(true);
    expect(hasClipDestination({ ...defaults(), zoteroRoutingEnabled: true })).toBe(true);
  });
});

describe("clipDestinationFor()", () => {
  test("the setting decides, so the bridge files where Devour files", () => {
    expect(clipDestinationFor(defaults(), undefined)).toBe("obsidian");
    expect(clipDestinationFor({ ...defaults(), clipDestination: "file" }, undefined)).toBe("file");
  });

  // The override is a destination the caller stated. Filing it as a download
  // instead would answer a request the user made with one they did not.
  test("naming a vault names Obsidian, even for a user set to files", () => {
    expect(clipDestinationFor({ ...defaults(), clipDestination: "file" }, "Main")).toBe("obsidian");
  });
});

describe("clipNeedsPageAccess()", () => {
  test("both note destinations inject the extractor", () => {
    expect(clipNeedsPageAccess({ ...defaults(), obsidianVault: "MyVault" })).toBe(true);
    expect(clipNeedsPageAccess({ ...defaults(), clipDestination: "file" })).toBe(true);
  });

  test("a Zotero-only run does not, so it must not spend the click's activation", () => {
    expect(clipNeedsPageAccess({ ...defaults(), zoteroRoutingEnabled: true })).toBe(false);
  });
});

describe("normalizeOptsFrom()", () => {
  test("maps Settings to NormalizeOpts", () => {
    const settings: Settings = {
      stripFragment: false,
      extraStripParams: ["campaign", "ref_x"],
      scope: "current-window",
      heuristicWarning: true,
      clipDestination: "obsidian",
      obsidianVault: "v",
      clippingsBaseFolder: "Inbox",
      clipMode: "clipboard",
      siteRules: [],
      groupingSkipList: [],
      zoteroRoutingEnabled: true,
      zoteroConnectorId: "connector@example.test",
      optionsInTab: true,
      onboardingComplete: true,
      bridgeEnabled: false,
      bridgePortMode: "auto",
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

describe("bridgePortModeFromStored()", () => {
  test("defaults new installs and historical default ports to automatic", () => {
    expect(bridgePortModeFromStored({})).toBe("auto");
    expect(bridgePortModeFromStored({ bridgePort: 4588 })).toBe("auto");
    expect(bridgePortModeFromStored({ bridgePort: DEFAULT_BRIDGE_PORT })).toBe("auto");
  });

  test("preserves a valid custom legacy port as fixed", () => {
    expect(bridgePortModeFromStored({ bridgePort: 5000 })).toBe("fixed");
  });

  test("preserves an explicit mode", () => {
    expect(bridgePortModeFromStored({ bridgePortMode: "fixed", bridgePort: 4589 })).toBe("fixed");
    expect(bridgePortModeFromStored({ bridgePortMode: "auto", bridgePort: 5000 })).toBe("auto");
  });

  test("repairs invalid legacy ports to automatic", () => {
    expect(bridgePortModeFromStored({ bridgePort: 80 })).toBe("auto");
  });
});
