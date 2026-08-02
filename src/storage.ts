import { BRIDGE_PORT_CANDIDATES, DEFAULT_BRIDGE_PORT, isBridgePort } from "./bridge-protocol.js";
import type { NormalizeOpts } from "./normalize.js";
import { IS_CHROME } from "./target.js";

export type ScopeMode = "hidden-false" | "current-window";
export type ClipMode = "clipboard" | "legacy-uri";
export type BridgePortMode = "auto" | "fixed";

export interface Settings {
  stripFragment: boolean;
  extraStripParams: string[];
  scope: ScopeMode;
  heuristicWarning: boolean;
  obsidianVault: string;
  clippingsBaseFolder: string;
  clipMode: ClipMode;
  /**
   * Whether Tabglutton's own settings buttons open the page in a full tab or
   * inside Firefox's Add-ons Manager. Firefox-only: the Chrome build ships
   * `open_in_tab: true` and hides the choice. See `openOptionsUi` for why the
   * manifest cannot express this at runtime.
   */
  optionsInTab: boolean;
  onboardingComplete: boolean;
  /** Agent bridge (see docs/BRIDGE.md). Off until the user opts in on the options page. */
  bridgeEnabled: boolean;
  bridgePortMode: BridgePortMode;
  /** Used only in fixed mode; retained while automatic mode is selected. */
  bridgePort: number;
  /** Shared secret; also pasted into Gullet's env. Empty until first generated. */
  bridgeToken: string;
  /**
   * Lets the bridge's `tabs_load` wake unloaded tabs. Separate from
   * `bridgeEnabled` because it is the one bridge method that acts on a page
   * rather than reading one, so enabling the bridge must not enable it too.
   */
  bridgeAllowTabLoad: boolean;
}

const DEFAULTS: Readonly<Settings> = Object.freeze({
  stripFragment: true,
  extraStripParams: [],
  // Chrome has no tab.hidden / workspaces — the "hidden-false" mode is meaningless there.
  scope: IS_CHROME ? "current-window" : "hidden-false",
  heuristicWarning: false,
  obsidianVault: "",
  clippingsBaseFolder: "Clippings",
  clipMode: "clipboard",
  optionsInTab: true,
  onboardingComplete: false,
  bridgeEnabled: false,
  bridgePortMode: "auto",
  bridgePort: DEFAULT_BRIDGE_PORT,
  bridgeToken: "",
  bridgeAllowTabLoad: false,
});

export function defaults(): Settings {
  return { ...DEFAULTS, extraStripParams: [...DEFAULTS.extraStripParams] };
}

export async function loadSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get(Object.keys(DEFAULTS))) as Partial<Settings>;
  const bridgePortMode = bridgePortModeFromStored(stored);
  // One-time migration. Historical defaults become automatic; an explicitly
  // chosen custom port keeps its old fixed semantics. Only written when there is
  // genuinely something stored to migrate: `loadSettings` is a read, called from
  // the `storage.onChanged` handler itself and from `openOptionsUi`, so a write
  // here costs a second change event and a full `bridge.sync()`. A profile with
  // nothing stored already agrees with the default and needs no persisting.
  if (stored.bridgePortMode !== bridgePortMode && stored.bridgePort !== undefined) {
    await browser.storage.local.set({ bridgePortMode });
  }
  const bridgePort = isBridgePort(stored.bridgePort ?? Number.NaN)
    ? (stored.bridgePort as number)
    : DEFAULT_BRIDGE_PORT;
  return { ...defaults(), ...stored, bridgePortMode, bridgePort };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.local.set(patch);
}

export function normalizeOptsFrom(settings: Settings): NormalizeOpts {
  return {
    stripFragment: settings.stripFragment,
    extraStripParams: settings.extraStripParams,
  };
}

/** Decide the one-time mode migration without depending on browser storage. */
export function bridgePortModeFromStored(
  stored: Pick<Partial<Settings>, "bridgePortMode" | "bridgePort">,
): BridgePortMode {
  if (stored.bridgePortMode === "auto" || stored.bridgePortMode === "fixed") {
    return stored.bridgePortMode;
  }
  const port = stored.bridgePort;
  if (!isBridgePort(port ?? Number.NaN)) return "auto";
  return port === 4588 || port === DEFAULT_BRIDGE_PORT ? "auto" : "fixed";
}

const BRIDGE_LAST_PORT_KEY = "bridgeLastPort";

/** A discovery cache, deliberately outside Settings so writing it cannot resync the bridge. */
export async function loadBridgeLastPort(): Promise<number | undefined> {
  const stored = (await browser.storage.local.get(BRIDGE_LAST_PORT_KEY)) as {
    bridgeLastPort?: unknown;
  };
  const port = stored.bridgeLastPort;
  return typeof port === "number" && BRIDGE_PORT_CANDIDATES.some((candidate) => candidate === port)
    ? port
    : undefined;
}

export async function saveBridgeLastPort(port: number): Promise<void> {
  if (!BRIDGE_PORT_CANDIDATES.some((candidate) => candidate === port)) return;
  await browser.storage.local.set({ [BRIDGE_LAST_PORT_KEY]: port });
}
