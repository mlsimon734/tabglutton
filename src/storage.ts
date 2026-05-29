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
  onboardingComplete: boolean;
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
  onboardingComplete: false,
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
