import { describe, expect, test } from "bun:test";
import { clipNotePath, createClipVerifier, isClipNoteName } from "../src/clip-verify.js";
import type { ObsidianVaultPaths } from "../src/obsidian-vaults.js";

const vaults: ObsidianVaultPaths = async () => new Map([["test", "/vaults/test"]]);

/** No real clock: the verifier's deadline is driven by an injected `now`. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("clipNotePath", () => {
  test("appends .md to the vault-relative path Obsidian was given", () => {
    expect(clipNotePath("/vaults/test", "Clippings/Note")).toBe("/vaults/test/Clippings/Note.md");
  });

  test("does not double an extension the name already carries", () => {
    expect(clipNotePath("/vaults/test", "Clippings/Note.md")).toBe(
      "/vaults/test/Clippings/Note.md",
    );
  });
});

const SINCE = 1_000_000;

/** A vault whose Clippings folder holds `entries`, each with the given mtime. */
function vaultWith(entries: Record<string, number>) {
  return {
    readDir: async (dir: string) =>
      dir === "/vaults/test/Clippings" ? Object.keys(entries) : null,
    modifiedAt: async (p: string) => {
      if (p === "/vaults/test/Clippings") return SINCE; // the folder itself exists
      const name = p.slice("/vaults/test/Clippings/".length);
      return entries[name] ?? null;
    },
  };
}

describe("isClipNoteName", () => {
  test("matches the requested name and Obsidian's numbered variants", () => {
    expect(isClipNoteName("Note.md", "Note")).toBe(true);
    expect(isClipNoteName("Note 1.md", "Note")).toBe(true);
    expect(isClipNoteName("Note 12.md", "Note")).toBe(true);
  });

  test("does not match a different note that merely shares a prefix", () => {
    expect(isClipNoteName("Note again.md", "Note")).toBe(false);
    expect(isClipNoteName("Notebook.md", "Note")).toBe(false);
    expect(isClipNoteName("Note .md", "Note")).toBe(false);
    expect(isClipNoteName("Note 1.txt", "Note")).toBe(false);
  });

  test("treats regex metacharacters in a title as literal text", () => {
    expect(isClipNoteName("C++ (a|b).md", "C++ (a|b)")).toBe(true);
    expect(isClipNoteName("C++ (a|b) 2.md", "C++ (a|b)")).toBe(true);
    expect(isClipNoteName("Cxx (aab).md", "C++ (a|b)")).toBe(false);
  });
});

describe("createClipVerifier", () => {
  test("landed when the note was written after the clip was requested", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("landed");
  });

  // Obsidian never overwrites: a second clip of the same page lands as "Note 1.md".
  // Checking only the requested path called that a failure and refused the close.
  test("landed when Obsidian sidestepped a name collision with a numbered variant", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE - 60_000, "Note 1.md": SINCE + 40 }),
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("landed");
  });

  test("landed when Obsidian writes a moment late, without waiting the full deadline", async () => {
    let calls = 0;
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => ["Note.md"],
      modifiedAt: async (p) => {
        if (p === "/vaults/test/Clippings") return SINCE;
        return ++calls >= 3 ? SINCE + 10 : null;
      },
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("landed");
    expect(calls).toBe(3);
  });

  // The reason existence alone is not enough: a page filed on an earlier run
  // leaves a note behind that would vouch for a handoff that never happened.
  test("missing when only a stale note from an earlier clip is present", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE - 60_000, "Note 1.md": SINCE - 30_000 }),
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("missing");
  });

  test("landed when the note is barely older than our timestamp, within slack", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE - 500 }),
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("landed");
  });

  test("missing once the deadline passes with nothing written", async () => {
    const verify = createClipVerifier(vaults, { ...fakeClock(), ...vaultWith({}) });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("missing");
  });

  test("a fresh note by another name does not vouch for this clip", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Something Else.md": SINCE + 100 }),
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("missing");
  });

  // The soft contract: inability to check is never a failed clip.
  test("unknown when the registry cannot be read", async () => {
    const verify = createClipVerifier(async () => null, { ...fakeClock(), ...vaultWith({}) });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("unknown");
  });

  test("unknown when the registry throws", async () => {
    const verify = createClipVerifier(
      async () => {
        throw new Error("permission denied");
      },
      { ...fakeClock(), ...vaultWith({}) },
    );
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("unknown");
  });

  test("unknown when the registry does not name that vault", async () => {
    const verify = createClipVerifier(vaults, { ...fakeClock(), ...vaultWith({}) });
    expect(await verify("Some Other Vault", "Clippings/Note", SINCE)).toBe("unknown");
  });

  // A folder that exists but cannot be listed is "cannot check", not "not written".
  test("unknown when the clippings folder exists but cannot be listed", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => null,
      modifiedAt: async (p) => (p === "/vaults/test/Clippings" ? SINCE : null),
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("unknown");
  });

  // But a folder Obsidian never created means the clip genuinely did not land.
  test("missing when the clippings folder does not exist at all", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => null,
      modifiedAt: async () => null,
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("missing");
  });
});
