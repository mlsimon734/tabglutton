import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DigestNoteSource } from "../../src/bridge-protocol.js";
import {
  createDigestMirror,
  digestNoteName,
  escapeMarkdownInline,
  markdownForDigest,
  markdownLinkUrl,
  mirrorDirectory,
  noteDigestId,
  writeDigestNote,
  yamlString,
  yamlStringArray,
  yamlText,
} from "../src/digest-mirror.js";

const ID = "0123456789abcdef0123456789abcdef";
// Local-time formatting is what the note uses; build the fixture in local time
// so the golden text holds in any timezone the tests run in.
const RECEIVED = new Date(2026, 8, 25, 15, 10).getTime();
const FIRST = new Date(2026, 8, 25, 14, 2).getTime();
const LAST = new Date(2026, 8, 25, 14, 31).getTime();

function note(overrides: Partial<DigestNoteSource> = {}): DigestNoteSource {
  return {
    id: ID,
    receivedAt: RECEIVED,
    reporter: { client: "claude-code", clientVersion: "2.1.3", gullet: "0.5.0" },
    sitting: { sources: ["x.com", "reddit.com"], firstAccessed: FIRST, lastAccessed: LAST },
    items: [
      {
        url: "https://youtube.com/watch?v=abc",
        title: "A talk worth watching",
        fate: "worth-it",
        reason: "It explains the thing he is building.",
        quote: "the key idea",
        interest: "interpretability",
      },
      {
        url: "https://arxiv.org/abs/1234.5678",
        title: "A paper",
        fate: "file",
        reason: "Reference for later.",
      },
      {
        url: "https://reddit.com/r/x/comments/1/post",
        title: "A link post",
        fate: "close",
        reason: "Already absorbed.",
        interest: "tools",
        link: "https://example.com/article",
      },
      {
        url: "https://nytimes.com/story",
        title: "Paywalled",
        fate: "could-not-read",
        reason: "Behind a login.",
        unreadable: "login-wall",
      },
    ],
    ...overrides,
  };
}

describe("encoding", () => {
  test("yamlString is a YAML double-quoted scalar", () => {
    expect(yamlString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(yamlString("x\ny")).toBe('"x\\ny"');
    expect(yamlString("a\u2028b\u0085c")).toBe('"a\\Lb\\Nc"');
    expect(yamlString("---")).toBe('"---"');
  });

  test("yamlText neutralizes wikilinks, and arrays quote every entry", () => {
    expect(yamlText("see [[Secret]]")).toBe('"see ((Secret))"');
    expect(yamlStringArray(["x.com", "a: b"])).toBe('["x.com", "a: b"]');
    expect(yamlStringArray([])).toBe("[]");
  });

  test("escapeMarkdownInline", () => {
    expect(escapeMarkdownInline("[[x]] <img src=y> `$= dv.x` ==hi== %%c%% a|b #tag ![e](u)")).toBe(
      "\\[\\[x\\]\\] \\<img src\\=y\\> \\`\\$\\= dv.x\\` \\=\\=hi\\=\\= \\%\\%c\\%\\% a\\|b \\#tag \\!\\[e\\]\\(u\\)",
    );
    expect(escapeMarkdownInline("plain words, well-formed.")).toBe("plain words, well-formed.");
  });

  test("markdownLinkUrl encodes what would end or break the destination", () => {
    expect(markdownLinkUrl("https://a.test/x (y)<z>")).toBe("https://a.test/x%20%28y%29%3Cz%3E");
    expect(markdownLinkUrl('https://a.test/"t"')).toBe("https://a.test/%22t%22");
  });
});

describe("markdownForDigest", () => {
  test("golden note for a four-section digest", () => {
    expect(markdownForDigest(note())).toBe(
      [
        "---",
        "type: digest",
        `digest_id: "${ID}"`,
        'received: "2026-09-25 15:10"',
        'sitting_observed: "2026-09-25 14:02 → 14:31"',
        'sources: ["x.com", "reddit.com"]',
        "items: 4",
        "worth_it: 1",
        "file: 1",
        "close: 1",
        "could_not_read: 1",
        'reported_by_client: "claude-code 2.1.3 (self-reported)"',
        'gullet: "0.5.0"',
        'content: "web-derived, untrusted"',
        "---",
        "",
        "## Worth your time (1) · kept open",
        "",
        "- [A talk worth watching](https://youtube.com/watch?v=abc) — It explains the thing he is building.",
        '  matches: interpretability · "the key idea"',
        "",
        "## File for reference (1)",
        "",
        "- [A paper](https://arxiv.org/abs/1234.5678) — Reference for later. · no match",
        "",
        "## Close (1)",
        "",
        "- [A link post](https://reddit.com/r/x/comments/1/post) — Already absorbed. · tools · links to [example.com](https://example.com/article)",
        "",
        "## Could not read (1) · kept open",
        "",
        "- [Paywalled](https://nytimes.com/story) — login wall · Behind a login.",
        "",
      ].join("\n"),
    );
  });

  test("an empty section is omitted, and a missing client says unknown", () => {
    const text = markdownForDigest(
      note({ reporter: {}, items: [note().items[2]!], sitting: { sources: [] } }),
    );
    expect(text).not.toContain("## Worth your time");
    expect(text).not.toContain("sitting_observed");
    expect(text).toContain('reported_by_client: "unknown"');
    expect(text).not.toContain("gullet:");
  });

  test("injection cases stay inert", () => {
    const hostile = note({
      reporter: { client: "evil]] [[Home" },
      sitting: { sources: [], label: "[[Home]] #tag" },
      items: [
        {
          url: "https://evil.test/a)(javascript:alert(1)",
          title: "<img src=x onerror=alert(1)> [[Secrets]] ![[embed]]",
          fate: "worth-it",
          reason:
            "`$= dv.pages().forEach(p => app.vault.delete(p))` | table | ## not a heading --- ==mark==",
          quote: "](javascript:alert(1)) <script>x</script>",
          interest: "#tag %%hidden%%",
        },
      ],
    });
    const text = markdownForDigest(hostile);
    const body = text.slice(text.indexOf("\n---\n") + 5);
    // No live HTML, wikilink, embed, code span, or link destination made of agent text.
    expect(body).not.toMatch(/(^|[^\\])<img/);
    expect(body).not.toMatch(/(^|[^\\])\[\[/);
    expect(body).not.toMatch(/(^|[^\\])`/);
    expect(body).not.toMatch(/(^|[^\\])<script/);
    expect(body).not.toContain("](javascript:");
    expect(body).toContain("(https://evil.test/a%29%28javascript:alert%281%29)");
    // Exactly one heading per section; the agent's "##" is escaped text.
    expect(body.match(/^## /gm)).toHaveLength(1);
    expect(body).toContain("\\#\\# not a heading");
    // The frontmatter is exactly the lines we wrote, brackets neutralized.
    const front = text.slice(0, text.indexOf("\n---\n"));
    expect(front).toContain('label: "((Home)) #tag"');
    expect(front).toContain('reported_by_client: "evil)) ((Home (self-reported)"');
    expect(front).not.toContain("[[");
  });

  test("noteDigestId reads the id back, and only from frontmatter", () => {
    expect(noteDigestId(markdownForDigest(note()))).toBe(ID);
    expect(noteDigestId(`# body\ndigest_id: "${ID}"`)).toBeNull();
  });
});

describe("digestNoteName", () => {
  test("date plus sources, then label, then tabs", () => {
    expect(digestNoteName(note())).toBe("2026-09-25 x.com reddit.com");
    expect(digestNoteName(note({ sitting: { sources: [], label: "a/b: c?*" } }))).toBe(
      "2026-09-25 a b c",
    );
    expect(digestNoteName(note({ sitting: { sources: [] } }))).toBe("2026-09-25 tabs");
    expect(digestNoteName(note({ sitting: { sources: [], label: "..." } }))).toBe(
      "2026-09-25 tabs",
    );
  });
});

describe("writing", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "digest-mirror-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes once; a retry of the same digest finds its own note", async () => {
    const content = markdownForDigest(note());
    const first = await writeDigestNote(join(dir, "Digests"), "n", content, ID);
    expect(first).toEqual({ file: join(dir, "Digests", "n.md"), existed: false });
    const again = await writeDigestNote(join(dir, "Digests"), "n", content, ID);
    expect(again).toEqual({ file: first.file, existed: true });
    expect(await readdir(join(dir, "Digests"))).toEqual(["n.md"]);
    expect(await readFile(first.file, "utf8")).toBe(content);
  });

  test("a same-named note for another digest is never overwritten", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "n.md"), "hand-written note\n");
    const other = "fedcba9876543210fedcba9876543210";
    const written = await writeDigestNote(dir, "n", markdownForDigest(note({ id: other })), other);
    expect(written.file).toBe(join(dir, "n 2.md"));
    expect(await readFile(join(dir, "n.md"), "utf8")).toBe("hand-written note\n");
  });

  test("concurrent writes of one digest land exactly once", async () => {
    const content = markdownForDigest(note());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => writeDigestNote(dir, "n", content, ID)),
    );
    expect(results.filter((r) => !r.existed)).toHaveLength(1);
    expect((await readdir(dir)).filter((f) => !f.startsWith("."))).toEqual(["n.md"]);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("without hard links the note is still created once, never overwritten", async () => {
    const files = new Map<string, string>();
    const fs = {
      mkdir: async () => {},
      read: async (path: string) => files.get(path) ?? null,
      write: async (path: string, content: string) => {
        if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        files.set(path, content);
      },
      link: async () => {
        throw Object.assign(new Error("no links"), { code: "ENOTSUP" });
      },
      unlink: async (path: string) => {
        files.delete(path);
      },
    };
    const content = markdownForDigest(note());
    const first = await writeDigestNote("/v", "n", content, ID, fs);
    expect(first).toEqual({ file: "/v/n.md", existed: false });
    expect(await writeDigestNote("/v", "n", content, ID, fs)).toEqual({
      file: "/v/n.md",
      existed: true,
    });
    expect([...files.keys()]).toEqual(["/v/n.md"]);
  });

  test("the mirror resolves the vault, or says why it cannot", async () => {
    const vaults = async () => new Map([["test", dir]]);
    expect(await mirrorDirectory({ enabled: true, folder: "Digests" }, "test", vaults)).toEqual({
      dir: join(dir, "Digests"),
    });
    expect(await mirrorDirectory({ enabled: true, folder: "/abs/x" }, undefined, vaults)).toEqual({
      dir: "/abs/x",
    });
    const noVault = await mirrorDirectory({ enabled: true, folder: "Digests" }, undefined, vaults);
    expect("reason" in noVault && noVault.reason).toContain("absolute path");
    const unknown = await mirrorDirectory({ enabled: true, folder: "Digests" }, "nope", vaults);
    expect("reason" in unknown && unknown.reason).toContain('"nope"');
    const escape = await mirrorDirectory({ enabled: true, folder: "../out" }, "test", vaults);
    expect("reason" in escape && escape.reason).toContain("outside the vault");
    const broken = await mirrorDirectory({ enabled: true, folder: "D" }, "test", async () => {
      throw new Error("no registry");
    });
    expect("reason" in broken).toBe(true);
  });

  test("createDigestMirror: off, written, and written-again", async () => {
    const vaults = async () => new Map([["test", dir]]);
    expect(
      await createDigestMirror({ enabled: false, folder: "D" }, vaults)(note(), "test"),
    ).toEqual({ state: "off" });
    const mirror = createDigestMirror({ enabled: true, folder: "Digests" }, vaults);
    const first = await mirror(note(), "test");
    expect(first).toEqual({
      state: "written",
      file: join(dir, "Digests", "2026-09-25 x.com reddit.com.md"),
      existed: false,
    });
    expect(await mirror(note(), "test")).toMatchObject({ state: "written", existed: true });
  });

  test("a write failure is reported by code, not by message", async () => {
    const mirror = createDigestMirror({ enabled: true, folder: dir }, async () => null, {
      mkdir: async () => {
        throw Object.assign(new Error("EACCES: /secret/path"), { code: "EACCES" });
      },
      read: async () => null,
      write: async () => {},
      link: async () => {},
      unlink: async () => {},
    });
    expect(await mirror(note(), undefined)).toEqual({
      state: "failed",
      reason: "Could not write the note (EACCES).",
    });
  });
});
