// Best-effort access to Obsidian's undocumented local vault registry. The
// extension cannot see the filesystem; Gullet can, because it runs beside the
// browser and the obsidian:// handler on the same host.

import { readFile, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { asRecord } from "../../src/bridge-protocol.js";

/** Vault names exactly as `obsidian://new?vault=` accepts them, or null for "cannot check". */
export type ObsidianVaultLookup = () => Promise<readonly string[] | null>;

/** Vault name → absolute vault directory, or null for "cannot check". */
export type ObsidianVaultPaths = () => Promise<ReadonlyMap<string, string> | null>;

type Environment = Readonly<Record<string, string | undefined>>;

/** The registry location used by a standard Obsidian install on this platform. */
export function obsidianRegistryPath(
  platform: NodeJS.Platform = process.platform,
  env: Environment = process.env,
): string | null {
  if (platform === "darwin") {
    return env.HOME
      ? posix.join(env.HOME, "Library", "Application Support", "obsidian", "obsidian.json")
      : null;
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME ?? (env.HOME ? posix.join(env.HOME, ".config") : null);
    return configHome ? posix.join(configHome, "obsidian", "obsidian.json") : null;
  }
  if (platform === "win32") {
    return env.APPDATA ? win32.join(env.APPDATA, "obsidian", "obsidian.json") : null;
  }
  return null;
}

/**
 * Parse only the registry shape we understand. A partial or changed shape is
 * "cannot check", not an empty registry: Obsidian owns this undocumented file,
 * so uncertainty must never become a false rejection. A registry that lists no
 * vaults at all is the same "cannot check" — it proves nothing about a name the
 * user just read off their own vault switcher.
 */
export function parseObsidianVaultRegistry(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  const entries = parseObsidianVaultEntries(raw, platform);
  return entries === null ? null : [...entries.keys()].sort((a, b) => a.localeCompare(b));
}

/**
 * The same registry read, keeping each vault's directory so a clip can be
 * confirmed on disk. Two vaults with the same basename are indistinguishable to
 * `obsidian://new?vault=` as well, so collapsing them loses nothing the URL
 * could have expressed.
 */
export function parseObsidianVaultEntries(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): Map<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const entries = asRecord(asRecord(parsed)?.vaults);
  if (!entries) return null;

  const vaults = new Map<string, string>();
  for (const value of Object.values(entries)) {
    const entry = asRecord(value);
    if (!entry || typeof entry.path !== "string") return null;
    const path = entry.path.trim();
    // Use only the host platform's separator; the other is a legal filename character.
    const basename = platform === "win32" ? win32.basename(path) : posix.basename(path);
    if (!basename) return null;
    vaults.set(basename, path);
  }
  return vaults.size === 0 ? null : vaults;
}

/**
 * Build one process-local lookup. Metadata is checked on each explicit vault
 * override, but the small JSON file is read and parsed only when its mtime or
 * size changes. A vault added while an agent session is running is therefore
 * picked up without permanently caching an earlier answer.
 */
export function createObsidianVaultLookup(
  path: string | null = obsidianRegistryPath(),
): ObsidianVaultLookup {
  const entries = createObsidianVaultEntryLookup(path);
  return async () => {
    const vaults = await entries();
    return vaults === null ? null : [...vaults.keys()].sort((a, b) => a.localeCompare(b));
  };
}

/** Same cached read, exposing each vault's directory. See {@link createObsidianVaultLookup}. */
export function createObsidianVaultPathLookup(
  path: string | null = obsidianRegistryPath(),
): ObsidianVaultPaths {
  return createObsidianVaultEntryLookup(path);
}

function createObsidianVaultEntryLookup(path: string | null): ObsidianVaultPaths {
  let cached: { signature: string; vaults: Map<string, string> | null } | undefined;

  return async () => {
    if (!path) return null;
    try {
      // One stat, not an exists() plus a second metadata read: a missing file
      // throws here and takes the same soft path as any other failure.
      const { mtimeMs, size } = await stat(path);
      const signature = `${mtimeMs}:${size}`;
      if (cached?.signature === signature) return cached.vaults;
      const vaults = parseObsidianVaultEntries(await readFile(path, "utf8"));
      cached = { signature, vaults };
      return vaults;
    } catch {
      // A missing registry, missing permissions, a concurrent Obsidian rewrite,
      // or any platform surprise only means this advisory check is unavailable.
      // The clip must still reach the extension, which retains the old
      // pass-through behavior.
      return null;
    }
  };
}
