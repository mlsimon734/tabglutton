import { describe, expect, test } from "bun:test";
import {
  clipNotePath,
  createClipVerifier,
  isClipNoteName,
  type DirListing,
  type FileTime,
} from "../src/clip-verify.js";
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

/**
 * A note as `markdownForClip` writes one. Hand-built rather than imported: that
 * module's import graph reaches browser-typed code and this suite has no DOM.
 * `tests/clip-source.test.ts` pins the two formats together from the side that
 * owns the format.
 */
function clipNote(source: string): string {
  return `---\ntitle: "A Post"\nsource: "${source}"\ntags:\n  - "clippings"\n---\nBody.`;
}

/** A vault whose Clippings folder holds `entries`, each with the given mtime. */
function vaultWith(entries: Record<string, number>) {
  return {
    readDir: async (dir: string): Promise<DirListing> =>
      dir === "/vaults/test/Clippings" ? Object.keys(entries) : "missing",
    modifiedAt: async (p: string): Promise<FileTime> => {
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
      modifiedAt: async () => (++calls >= 3 ? SINCE + 10 : null),
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
  test("unknown when the clippings folder cannot be listed", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => "unreadable",
      modifiedAt: async () => null,
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("unknown");
  });

  // The same failure one level down: listable folder, unstattable note.
  test("unknown when a matching note cannot be stat'd", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => ["Note.md"],
      modifiedAt: async () => "unreadable",
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("unknown");
  });

  // But a folder Obsidian never created means the clip genuinely did not land.
  test("missing when the clippings folder does not exist at all", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => "missing",
      modifiedAt: async () => null,
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("missing");
  });

  // Two pages with the same title clipped at once produce one requested name.
  // If one handoff is dropped, the single fresh note must not vouch for both —
  // the second verification would close a tab whose content was never saved.
  test("one note vouches for one clip, even with both verifications in flight", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
    });
    const [first, second] = await Promise.all([
      verify("test", "Clippings/Note", SINCE),
      verify("test", "Clippings/Note", SINCE),
    ]);
    expect([first, second].sort()).toEqual(["landed", "missing"]);
  });

  // And the note goes to the clip that actually wrote it, not to whichever
  // verification looked first: the dropped one must be the one told "missing".
  // Freshness cannot do this — both timestamps precede the single write — so the
  // note's own recorded source is what decides.
  test("the landed verdict follows the handoff that wrote the note", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => clipNote("https://b.example/post"),
    });
    // Clip A is dropped and looks first; clip B is the one Obsidian filed.
    const [a, b] = await Promise.all([
      verify("test", "Clippings/Note", SINCE, "https://a.example/post"),
      verify("test", "Clippings/Note", SINCE, "https://b.example/post"),
    ]);
    expect(a).toBe("missing");
    expect(b).toBe("landed");
  });

  // Two Gullets sharing a browser keep separate claim maps, so attribution has
  // to hold with no shared state: a verifier that has never seen the other's
  // request still refuses a note belonging to it.
  test("a note recording another page never vouches for this clip", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => clipNote("https://elsewhere.example/post"),
    });
    expect(await verify("test", "Clippings/Note", SINCE, "https://mine.example/post")).toBe(
      "missing",
    );
  });

  // A scroll-to-text fragment addresses a position in a page, not a page, and
  // clip-format.ts strips it before recording the source.
  test("matches a source recorded without the tab's text fragment", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => clipNote("https://a.example/post"),
    });
    const url = "https://a.example/post#:~:text=selected%20words";
    expect(await verify("test", "Clippings/Note", SINCE, url)).toBe("landed");
  });

  // Positive disagreement disqualifies; absence of evidence must not. A note
  // with no readable frontmatter source falls back to freshness alone, so a
  // format change here degrades to the old behaviour instead of failing clips.
  test("a note with no recorded source still vouches on freshness", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => "just some text",
    });
    expect(await verify("test", "Clippings/Note", SINCE, "https://a.example/post")).toBe("landed");
  });

  test("unknown when a candidate note cannot be read", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => "unreadable",
    });
    expect(await verify("test", "Clippings/Note", SINCE, "https://a.example/post")).toBe("unknown");
  });

  // Both really landed: Obsidian sidesteps the collision, so there are two notes
  // and both verifications have their own proof.
  test("two notes vouch for two clips", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50, "Note 1.md": SINCE + 60 }),
    });
    const verdicts = await Promise.all([
      verify("test", "Clippings/Note", SINCE),
      verify("test", "Clippings/Note", SINCE),
    ]);
    expect(verdicts).toEqual(["landed", "landed"]);
  });

  // A claim is on that write, not on the path: deleting the note and re-filing
  // the page writes "Note.md" again, and that is a real clip.
  test("a newer write to a claimed path vouches for the next clip", async () => {
    const mtimes: Record<string, number> = { "Note.md": SINCE + 50 };
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => Object.keys(mtimes),
      modifiedAt: async (p): Promise<FileTime> =>
        mtimes[p.slice("/vaults/test/Clippings/".length)] ?? null,
    });
    expect(await verify("test", "Clippings/Note", SINCE)).toBe("landed");
    mtimes["Note.md"] = SINCE + 500;
    expect(await verify("test", "Clippings/Note", SINCE + 400)).toBe("landed");
  });
});
