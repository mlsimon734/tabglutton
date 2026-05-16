import type { NormalizeOpts } from "./normalize.js";

export type ScopeMode = "hidden-false" | "current-window";
export type ClipMode = "clipboard" | "legacy-uri";

export interface Settings {
  stripFragment: boolean;
  extraStripParams: string[];
  scope: ScopeMode;
  heuristicWarning: boolean;
  obsidianVault: string;
  clipMode: ClipMode;
  onboardingComplete: boolean;
}

const DEFAULTS: Readonly<Settings> = Object.freeze({
  stripFragment: true,
  extraStripParams: [],
  scope: "hidden-false",
  heuristicWarning: false,
  obsidianVault: "",
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
