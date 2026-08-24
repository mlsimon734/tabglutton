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

  // Interior `..` that normalizes back inside is an ordinary path, not an escape.
  test("normalizes a path that stays inside the vault", () => {
    expect(clipNotePath("/vaults/test", "Clippings/Drafts/../Papers/Note")).toBe(
      "/vaults/test/Clippings/Papers/Note.md",
    );
  });

  // `file` comes off the wire; a plain join followed it anywhere on disk.
  test("refuses a path that climbs out of the vault", () => {
    expect(clipNotePath("/vaults/test", "../../../../Users/someone/.ssh/id_ed25519")).toBeNull();
    expect(clipNotePath("/vaults/test", "Clippings/../../elsewhere/Note")).toBeNull();
  });

  test("refuses an absolute path, which resolve takes whole", () => {
    expect(clipNotePath("/vaults/test", "/etc/hosts")).toBeNull();
  });

  // The prefix footgun: a sibling directory whose name starts with the vault's
  // is not inside the vault, and a bare startsWith would have said it was.
  test("refuses a sibling that merely shares the vault's prefix", () => {
    expect(clipNotePath("/vaults/test", "../test-evil/Note")).toBeNull();
  });

  // The escape does not get in through the branch that leaves `.md` alone.
  test("refuses an escape whose name already carries the extension", () => {
    expect(clipNotePath("/vaults/test", "../test.md")).toBeNull();
  });

  // Containment resolves the *vault* path too, and a trailing space is a legal
  // directory name that `parseObsidianVaultEntries` goes out of its way to keep.
  // Normalizing it away here would send every clip in such a vault to `unknown`.
  test("preserves a vault directory whose name ends in a space", () => {
    expect(clipNotePath("/vaults/test ", "Clippings/Note")).toBe("/vaults/test /Clippings/Note.md");
  });

  // The one branch a "simplify to root + sep" tidy-up would break: at the
  // filesystem root that prefix becomes "//" and rejects every path.
  test("a vault at the filesystem root still contains its notes", () => {
    expect(clipNotePath("/", "Note")).toBe("/Note.md");
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
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("landed");
  });

  // Obsidian never overwrites: a second clip of the same page lands as "Note 1.md".
  // Checking only the requested path called that a failure and refused the close.
  test("landed when Obsidian sidestepped a name collision with a numbered variant", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE - 60_000, "Note 1.md": SINCE + 40 }),
    });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("landed");
  });

  test("landed when Obsidian writes a moment late, without waiting the full deadline", async () => {
    let calls = 0;
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => ["Note.md"],
      modifiedAt: async () => (++calls >= 3 ? SINCE + 10 : null),
    });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("landed");
    expect(calls).toBe(3);
  });

  // The reason existence alone is not enough: a page filed on an earlier run
  // leaves a note behind that would vouch for a handoff that never happened.
  test("missing when only a stale note from an earlier clip is present", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE - 60_000, "Note 1.md": SINCE - 30_000 }),
    });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("missing");
  });

  test("landed when the note is barely older than our timestamp, within slack", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE - 500 }),
    });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("landed");
  });

  test("missing once the deadline passes with nothing written", async () => {
    const verify = createClipVerifier(vaults, { ...fakeClock(), ...vaultWith({}) });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("missing");
  });

  test("a fresh note by another name does not vouch for this clip", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Something Else.md": SINCE + 100 }),
    });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("missing");
  });

  // The soft contract: inability to check is never a failed clip.
  test("unknown when the registry cannot be read", async () => {
    const verify = createClipVerifier(async () => null, { ...fakeClock(), ...vaultWith({}) });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("unknown");
  });

  test("unknown when the registry throws", async () => {
    const verify = createClipVerifier(
      async () => {
        throw new Error("permission denied");
      },
      { ...fakeClock(), ...vaultWith({}) },
    );
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("unknown");
  });

  test("unknown when the registry does not name that vault", async () => {
    const verify = createClipVerifier(vaults, { ...fakeClock(), ...vaultWith({}) });
    expect(await verify("Some Other Vault", "Clippings/Note", { since: SINCE })).toBe("unknown");
  });

  // `file` is the extension's word for where the note went, and the extension is
  // reachable by anything holding the browser connection. A reported path that
  // leaves the vault is answered `unknown` — and nothing out there is looked at,
  // which is the half that keeps the verdict from being an existence oracle.
  test("unknown when the reported path escapes the vault, without looking", async () => {
    let looked = 0;
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => {
        looked += 1;
        return ["id_ed25519.md"];
      },
      modifiedAt: async () => SINCE + 50,
    });
    expect(
      await verify("test", "../../../../Users/someone/.ssh/id_ed25519", { since: SINCE }),
    ).toBe("unknown");
    expect(looked).toBe(0);
  });

  test("unknown when the reported path is absolute", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => ["hosts.md"],
      modifiedAt: async () => SINCE + 50,
    });
    expect(await verify("test", "/etc/hosts", { since: SINCE })).toBe("unknown");
  });

  test("unknown when the escape lands in a sibling sharing the vault's prefix", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => ["Note.md"],
      modifiedAt: async () => SINCE + 50,
    });
    expect(await verify("test", "../test-evil/Note", { since: SINCE })).toBe("unknown");
  });

  // Containment must cost a legitimate deep path nothing.
  test("landed for a nested note whose path normalizes back inside the vault", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async (dir): Promise<DirListing> =>
        dir === "/vaults/test/Clippings/Papers" ? ["Note.md"] : "missing",
      modifiedAt: async () => SINCE + 50,
    });
    expect(await verify("test", "Clippings/Drafts/../Papers/Note", { since: SINCE })).toBe(
      "landed",
    );
  });

  // A folder that exists but cannot be listed is "cannot check", not "not written".
  test("unknown when the clippings folder cannot be listed", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => "unreadable",
      modifiedAt: async () => null,
    });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("unknown");
  });

  // The same failure one level down: listable folder, unstattable note.
  test("unknown when a matching note cannot be stat'd", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => ["Note.md"],
      modifiedAt: async () => "unreadable",
    });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("unknown");
  });

  // But a folder Obsidian never created means the clip genuinely did not land.
  test("missing when the clippings folder does not exist at all", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      readDir: async () => "missing",
      modifiedAt: async () => null,
    });
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("missing");
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
      verify("test", "Clippings/Note", { since: SINCE }),
      verify("test", "Clippings/Note", { since: SINCE }),
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
      verify("test", "Clippings/Note", { since: SINCE, sourceUrl: "https://a.example/post" }),
      verify("test", "Clippings/Note", { since: SINCE, sourceUrl: "https://b.example/post" }),
    ]);
    expect(a).toBe("missing");
    expect(b).toBe("landed");
  });

  // The residual the source-URL check could not close: two clips of the SAME
  // page, from separate processes with separate claim maps, one dropped. Both
  // notes would name the same source, so only the text tells them apart.
  test("a content hash separates two clips of the same page across processes", async () => {
    const options = {
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => "the note B wrote",
      hashNote: async (content: string) => `hash:${content}`,
    };
    // Separate verifiers, as two Gullet processes would have.
    const a = createClipVerifier(vaults, { ...fakeClock(), ...options });
    const b = createClipVerifier(vaults, { ...fakeClock(), ...options });
    const evidence = { since: SINCE, sourceUrl: "https://a.example/post" };
    expect(
      await a("test", "Clippings/Note", { ...evidence, contentHash: "hash:the note A wrote" }),
    ).toBe("mismatched");
    expect(
      await b("test", "Clippings/Note", { ...evidence, contentHash: "hash:the note B wrote" }),
    ).toBe("landed");
  });

  // Obsidian creates the note and fills it a beat later — measured live in both
  // real vaults. Without this the empty file has no parseable source, falls
  // through as "mine", and vouches for a clip whose text is not there yet.
  test("an empty note is the write window, not a landed clip", async () => {
    let reads = 0;
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => (++reads >= 3 ? clipNote("https://a.example/post") : ""),
    });
    expect(
      await verify("test", "Clippings/Note", { since: SINCE, sourceUrl: "https://a.example/post" }),
    ).toBe("landed");
    expect(reads).toBe(3); // it kept polling rather than accepting the empty file
  });

  // Distinguishing the two failures matters: "nothing was written" and "someone
  // wrote this and it is not ours" call for different actions from the user.
  test("reports mismatched, not missing, when a note for this page is foreign", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => clipNote("https://a.example/post"),
      hashNote: async () => "some other hash",
    });
    expect(
      await verify("test", "Clippings/Note", {
        since: SINCE,
        sourceUrl: "https://a.example/post",
        contentHash: "ours",
      }),
    ).toBe("mismatched");
  });

  // But a note for a *different* page says nothing about ours either way, so it
  // must not colour the verdict — that is still a plain missing.
  test("a same-named note for another page leaves the verdict missing", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => clipNote("https://elsewhere.example/post"),
      hashNote: async () => "some other hash",
    });
    expect(
      await verify("test", "Clippings/Note", {
        since: SINCE,
        sourceUrl: "https://a.example/post",
        contentHash: "ours",
      }),
    ).toBe("missing");
  });

  // An extension that predates the hash still gets the source-URL attribution.
  test("falls back to source attribution when no hash is supplied", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => clipNote("https://a.example/post"),
    });
    expect(
      await verify("test", "Clippings/Note", { since: SINCE, sourceUrl: "https://a.example/post" }),
    ).toBe("landed");
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
    expect(
      await verify("test", "Clippings/Note", {
        since: SINCE,
        sourceUrl: "https://mine.example/post",
      }),
    ).toBe("missing");
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
    expect(await verify("test", "Clippings/Note", { since: SINCE, sourceUrl: url })).toBe("landed");
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
    expect(
      await verify("test", "Clippings/Note", { since: SINCE, sourceUrl: "https://a.example/post" }),
    ).toBe("landed");
  });

  test("unknown when a candidate note cannot be read", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50 }),
      readNote: async () => "unreadable",
    });
    expect(
      await verify("test", "Clippings/Note", { since: SINCE, sourceUrl: "https://a.example/post" }),
    ).toBe("unknown");
  });

  // Both really landed: Obsidian sidesteps the collision, so there are two notes
  // and both verifications have their own proof.
  test("two notes vouch for two clips", async () => {
    const verify = createClipVerifier(vaults, {
      ...fakeClock(),
      ...vaultWith({ "Note.md": SINCE + 50, "Note 1.md": SINCE + 60 }),
    });
    const verdicts = await Promise.all([
      verify("test", "Clippings/Note", { since: SINCE }),
      verify("test", "Clippings/Note", { since: SINCE }),
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
    expect(await verify("test", "Clippings/Note", { since: SINCE })).toBe("landed");
    mtimes["Note.md"] = SINCE + 500;
    expect(await verify("test", "Clippings/Note", { since: SINCE + 400 })).toBe("landed");
  });
});
