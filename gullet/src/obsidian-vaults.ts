// Best-effort access to Obsidian's undocumented local vault registry. The
// extension cannot see the filesystem; Gullet can, because it runs beside the
// browser and the obsidian:// handler on the same host.

import { posix, win32 } from "node:path";

export interface KnownObsidianVault {
  /** The exact basename accepted by obsidian://new?vault=. */
  name: string;
  path: string;
}

export type ObsidianVaultLookup = () => Promise<readonly KnownObsidianVault[] | null>;

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
 * so uncertainty must never become a false rejection.
 */
export function parseObsidianVaultRegistry(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): KnownObsidianVault[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const root = asRecord(parsed);
  const entries = asRecord(root?.vaults);
  if (!entries) return null;

  const byName = new Map<string, KnownObsidianVault>();
  for (const value of Object.values(entries)) {
    const entry = asRecord(value);
    if (!entry || typeof entry.path !== "string") return null;
    const path = entry.path.trim();
    const name = vaultName(path, platform);
    if (!name) return null;
    byName.set(name, { name, path });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build one process-local lookup. Metadata is checked on each explicit vault
 * override, but the small JSON file is read and parsed only when its mtime or
 * size changes. A vault added while an agent session is running is therefore
 * picked up without permanently caching an earlier answer.
 */
export function createObsidianVaultLookup(
  path: string | null = obsidianRegistryPath(),
  platform: NodeJS.Platform = process.platform,
): ObsidianVaultLookup {
  let cached: { signature: string; vaults: KnownObsidianVault[] | null } | undefined;

  return async () => {
    if (!path) return null;
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      const signature = `${file.lastModified}:${file.size}`;
      if (cached?.signature === signature) return cached.vaults;
      const vaults = parseObsidianVaultRegistry(await file.text(), platform);
      cached = { signature, vaults };
      return vaults;
    } catch {
      // Missing permissions, a concurrent Obsidian rewrite, or any platform
      // surprise only means this advisory check is unavailable. The clip must
      // still reach the extension, which retains the old pass-through behavior.
      return null;
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Use only the host platform's separator; the other one is a legal filename character. */
function vaultName(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.basename(path) : posix.basename(path);
}
