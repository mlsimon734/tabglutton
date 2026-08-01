import { DEFAULT_BRIDGE_PORT } from "./bridge-protocol.js";
import type { NormalizeOpts } from "./normalize.js";
import { IS_CHROME } from "./target.js";

export type ScopeMode = "hidden-false" | "current-window";
export type ClipMode = "clipboard" | "legacy-uri";

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
  /** Agent bridge (see BRIDGE.md). Off until the user opts in on the options page. */
  bridgeEnabled: boolean;
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
  bridgePort: DEFAULT_BRIDGE_PORT,
  bridgeToken: "",
  bridgeAllowTabLoad: false,
});

export function defaults(): Settings {
  return { ...DEFAULTS, extraStripParams: [...DEFAULTS.extraStripParams] };
}

export async function loadSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get(Object.keys(DEFAULTS))) as Partial<Settings>;
  return { ...defaults(), ...stored };
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
