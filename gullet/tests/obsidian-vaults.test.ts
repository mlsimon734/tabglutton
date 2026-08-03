import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createObsidianVaultLookup,
  obsidianRegistryPath,
  parseObsidianVaultRegistry,
} from "../src/obsidian-vaults.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Obsidian registry locations", () => {
  test("uses each standard platform location", () => {
    expect(obsidianRegistryPath("darwin", { HOME: "/Users/michael" })).toBe(
      "/Users/michael/Library/Application Support/obsidian/obsidian.json",
    );
    expect(obsidianRegistryPath("linux", { HOME: "/home/michael" })).toBe(
      "/home/michael/.config/obsidian/obsidian.json",
    );
    expect(obsidianRegistryPath("linux", { XDG_CONFIG_HOME: "/config" })).toBe(
      "/config/obsidian/obsidian.json",
    );
    expect(obsidianRegistryPath("win32", { APPDATA: "C:\\Users\\m\\AppData\\Roaming" })).toBe(
      "C:\\Users\\m\\AppData\\Roaming\\obsidian\\obsidian.json",
    );
  });

  test("returns cannot-check when the platform or required home is unknown", () => {
    expect(obsidianRegistryPath("freebsd", { HOME: "/home/michael" })).toBeNull();
    expect(obsidianRegistryPath("darwin", {})).toBeNull();
    expect(obsidianRegistryPath("win32", {})).toBeNull();
  });
});

describe("Obsidian registry parsing", () => {
  test("preserves backslashes in legal macOS and Linux vault names", () => {
    const raw = JSON.stringify({
      vaults: {
        first: { path: "/Users/michael/Documents/Main Vault", ts: 1, open: true },
        second: { path: "/Notes/Research\\Work", ts: 2 },
      },
    });
    for (const platform of ["darwin", "linux"] as const) {
      expect(parseObsidianVaultRegistry(raw, platform)).toEqual(["Main Vault", "Research\\Work"]);
    }
  });

  test("uses backslashes as separators on Windows", () => {
    expect(
      parseObsidianVaultRegistry(
        JSON.stringify({ vaults: { first: { path: "C:\\Notes\\Work\\", ts: 1 } } }),
        "win32",
      ),
    ).toEqual(["Work"]);
  });

  test("treats malformed JSON or an unfamiliar shape as cannot-check", () => {
    expect(parseObsidianVaultRegistry("{")).toBeNull();
    expect(parseObsidianVaultRegistry(JSON.stringify({ vaults: [] }))).toBeNull();
    // A registry listing no vaults proves nothing about the requested name.
    expect(parseObsidianVaultRegistry(JSON.stringify({ vaults: {} }))).toBeNull();
    expect(
      parseObsidianVaultRegistry(JSON.stringify({ vaults: { id: { location: "/x" } } })),
    ).toBeNull();
  });
});

describe("Obsidian registry lookup", () => {
  test("is soft when absent and notices a registry created or changed mid-session", async () => {
    const root = await mkdtemp(join(tmpdir(), "tabglutton-obsidian-"));
    temporaryDirectories.push(root);
    const path = join(root, "obsidian", "obsidian.json");
    const lookup = createObsidianVaultLookup(path);

    expect(await lookup()).toBeNull();

    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify({ vaults: { one: { path: "/Notes/Work" } } }));
    expect(await lookup()).toEqual(["Work"]);

    // Different size guarantees a different cheap cache signature even on a
    // filesystem whose timestamp granularity collapses these adjacent writes.
    await Bun.write(
      path,
      JSON.stringify({
        vaults: {
          one: { path: "/Notes/Work" },
          two: { path: "/Notes/Personal Archive" },
        },
      }),
    );
    expect(await lookup()).toEqual(["Personal Archive", "Work"]);
  });

  test("recovers after malformed contents are replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "tabglutton-obsidian-"));
    temporaryDirectories.push(root);
    const path = join(root, "obsidian.json");
    const lookup = createObsidianVaultLookup(path);

    await Bun.write(path, "not json");
    expect(await lookup()).toBeNull();
    await Bun.write(path, JSON.stringify({ vaults: { one: { path: "/Notes/Main" } } }));
    expect(await lookup()).toEqual(["Main"]);
  });
});
