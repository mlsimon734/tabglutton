import {
  BRIDGE_PORT_CANDIDATES,
  DEFAULT_BRIDGE_PORT,
  isBridgePort,
  type ClipDestination,
} from "./bridge-protocol.js";
import type { NormalizeOpts } from "./normalize.js";
import { sanitizeSiteRules, seedRules, type SiteRule } from "./site-rules.js";
import { IS_CHROME } from "./target.js";
import { DEFAULT_ZOTERO_CONNECTOR_ID } from "./zotero.js";

export type ScopeMode = "hidden-false" | "current-window";
export type ClipMode = "clipboard" | "legacy-uri";
export type BridgePortMode = "auto" | "fixed";
/** Where Devour files a clipped page — declared with the wire contract, which now carries it. */
export type { ClipDestination };

export interface Settings {
  stripFragment: boolean;
  extraStripParams: string[];
  scope: ScopeMode;
  heuristicWarning: boolean;
  /** Obsidian, or plain markdown files in the browser's download folder. */
  clipDestination: ClipDestination;
  obsidianVault: string;
  /** Base folder inside the vault, or inside the download folder in file mode. */
  clippingsBaseFolder: string;
  /** Obsidian-only: how the note body reaches it. Unused in file mode. */
  clipMode: ClipMode;
  /**
   * User-editable site rules, first match wins (see `pickRule`). Seeded from
   * `BUILT_IN_RULES` when nothing is stored; an empty stored list is a user
   * who deleted every rule, not a reason to re-seed.
   */
  siteRules: SiteRule[];
  /**
   * Patterns (same shape as a rule's) whose tabs a grouping pass must never
   * reorder — parked, not grouped, whatever the rules say.
   */
  groupingSkipList: string[];
  /** Route scholarly items detected by Zotero Connector there instead of Obsidian. */
  zoteroRoutingEnabled: boolean;
  /** Published Connector ID by default; overrideable for an unpacked POC build. */
  zoteroConnectorId: string;
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
  clipDestination: "obsidian",
  obsidianVault: "",
  clippingsBaseFolder: "Clippings",
  clipMode: "clipboard",
  siteRules: seedRules(),
  groupingSkipList: [],
  zoteroRoutingEnabled: false,
  zoteroConnectorId: DEFAULT_ZOTERO_CONNECTOR_ID,
  optionsInTab: true,
  onboardingComplete: false,
  bridgeEnabled: false,
  bridgePortMode: "auto",
  bridgePort: DEFAULT_BRIDGE_PORT,
  bridgeToken: "",
  bridgeAllowTabLoad: false,
});

export function defaults(): Settings {
  return {
    ...DEFAULTS,
    extraStripParams: [...DEFAULTS.extraStripParams],
    siteRules: seedRules(),
    groupingSkipList: [...DEFAULTS.groupingSkipList],
  };
}

/** Whether an Obsidian vault is configured — the Obsidian path needs one. */
export function hasVault(settings: Settings | null): boolean {
  return !!settings?.obsidianVault.trim();
}

/** Whether clips are written as files rather than handed to Obsidian. */
export function clipsToFile(settings: Settings | null): boolean {
  return settings?.clipDestination === "file";
}

/**
 * Where one clip goes. The setting decides, with one exception: naming a vault
 * names Obsidian. `tab_clip`'s `vault` override is a destination the caller
 * stated outright, and filing it as a download instead would answer a request
 * the user made with one they did not — the same reason a blank override is a
 * `bad-request` rather than a fallback to settings.
 */
export function clipDestinationFor(
  settings: Settings,
  vaultOverride: string | undefined,
): ClipDestination {
  return vaultOverride ? "obsidian" : settings.clipDestination;
}

/**
 * Whether a clip has anywhere to go. Sole owner of that question: the popups
 * gate their buttons on it and `clipSelectedTabs` refuses the whole request
 * when it is false, and those must agree. File mode always has somewhere —
 * the download folder needs no configuring.
 */
export function hasClipDestination(settings: Settings | null): boolean {
  return clipsToFile(settings) || hasVault(settings) || !!settings?.zoteroRoutingEnabled;
}

/**
 * Whether the run will inject the Defuddle extractor, and so needs the host
 * grant Chrome only hands out from a click. Both destinations that produce a
 * note extract the page; only a Zotero-only run does not. Must stay
 * synchronous — its callers evaluate it before the first `await` in a click
 * handler, which is where `requestOrigins` has to be.
 */
export function clipNeedsPageAccess(settings: Settings | null): boolean {
  return clipsToFile(settings) || hasVault(settings);
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
  // Sanitized, not trusted: rules are user-shaped data an old build (or a hand
  // edit) may have stored differently; absent storage gets the seed here.
  const siteRules = sanitizeSiteRules(stored.siteRules);
  return { ...defaults(), ...stored, bridgePortMode, bridgePort, siteRules };
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
