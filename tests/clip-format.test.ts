import { describe, test, expect } from "bun:test";
import {
  CLIPBOARD_FALLBACK_CONTENT,
  markdownForClip,
  normalizeBaseFolder,
  obsidianClipRequest,
  type ClipPayload,
  type FilePlatform,
} from "../src/clip-format.js";
import { BUILT_IN_RULES, type SiteRule } from "../src/site-rules.js";

const githubRule = BUILT_IN_RULES.find((r) => r.id === "github") as SiteRule;
const socialRule = BUILT_IN_RULES.find((r) => r.id === "social-x") as SiteRule;

function makePayload(partial: Partial<ClipPayload> = {}): ClipPayload {
  return {
    title: "Example Title",
    url: "https://example.com/article",
    author: "Ada Lovelace",
    published: "2026-01-15",
    description: "A short description.",
    site: "example.com",
    wordCount: 100,
    markdown: "# Heading\n\nBody text.",
    ...partial,
  };
}

const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

describe("markdownForClip - frontmatter shape", () => {
  test("output starts with --- and contains closing --- before body", () => {
    const md = markdownForClip(makePayload());
    expect(md.startsWith("---\n")).toBe(true);
    const closingIdx = md.indexOf("\n---\n");
    expect(closingIdx).toBeGreaterThan(0);
    const body = md.slice(closingIdx + "\n---\n".length);
    expect(body).toBe("# Heading\n\nBody text.");
  });

  test("body content is trimmed", () => {
    const md = markdownForClip(makePayload({ markdown: "\n\n  body\n\n" }));
    expect(md.endsWith("body")).toBe(true);
  });

  test("title is emitted as a quoted text value", () => {
    const md = markdownForClip(makePayload({ title: "Hello" }));
    expect(md).toContain('title: "Hello"\n');
  });

  test("double quotes in text values are escaped", () => {
    const md = markdownForClip(makePayload({ title: 'A "quoted" word', description: 'say "hi"' }));
    expect(md).toContain('title: "A \\"quoted\\" word"\n');
    expect(md).toContain('description: "say \\"hi\\""\n');
  });

  test("tags is always present as multitext with `clippings`", () => {
    const md = markdownForClip(makePayload());
    expect(md).toMatch(/tags:\n  - "clippings"\n/);
  });
});

describe("markdownForClip - source field", () => {
  test("emits the URL as the source", () => {
    const md = markdownForClip(makePayload({ url: "https://example.com/x" }));
    expect(md).toContain('source: "https://example.com/x"\n');
  });

  test("strips a trailing #:~:text= fragment from the source URL", () => {
    const md = markdownForClip(makePayload({ url: "https://example.com/x#:~:text=hello%20world" }));
    expect(md).toContain('source: "https://example.com/x"\n');
    expect(md).not.toContain("text=");
  });
});

describe("markdownForClip - author field", () => {
  test("wraps single author in [[wikilink]]", () => {
    const md = markdownForClip(makePayload({ author: "Ada Lovelace" }));
    expect(md).toMatch(/author:\n  - "\[\[Ada Lovelace\]\]"\n/);
  });

  test("splits CSV authors and wraps each", () => {
    const md = markdownForClip(makePayload({ author: "Ada Lovelace, Alan Turing" }));
    expect(md).toContain('  - "[[Ada Lovelace]]"\n');
    expect(md).toContain('  - "[[Alan Turing]]"\n');
  });

  test("empty author emits an empty multitext block", () => {
    const md = markdownForClip(makePayload({ author: "" }));
    expect(md).toMatch(/author:\n(?!  - )/);
  });
});

describe("markdownForClip - published field", () => {
  test("emits date when present", () => {
    const md = markdownForClip(makePayload({ published: "2026-01-15" }));
    expect(md).toContain("published: 2026-01-15\n");
  });

  test("takes only the part before the first comma", () => {
    const md = markdownForClip(makePayload({ published: "2026-01-15, draft" }));
    expect(md).toContain("published: 2026-01-15\n");
  });

  test("empty published produces a bare key", () => {
    const md = markdownForClip(makePayload({ published: "" }));
    expect(md).toMatch(/published:\n/);
  });
});

describe("markdownForClip - created timestamp", () => {
  test("emits an ISO timestamp with timezone offset", () => {
    const md = markdownForClip(makePayload());
    const match = md.match(/created: ([^\n]+)\n/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(ISO_OFFSET_RE);
  });
});

describe("obsidianClipRequest - legacy-uri mode", () => {
  test("uses Clippings/<title> as the file path", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Hello" }),
      "",
      "body",
      null,
      "legacy-uri",
    );
    expect(url).toContain("file=Clippings%2FHello");
  });

  test("encodes spaces and special chars in the file component", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Hello World & Co" }),
      "",
      "body",
      null,
      "legacy-uri",
    );
    expect(url).toContain("file=Clippings%2FHello%20World%20%26%20Co");
  });

  test("falls back to URL when title is empty", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "", url: "https://example.com/a" }),
      "",
      "body",
      null,
      "legacy-uri",
    );
    expect(url).toContain("file=Clippings%2F");
    expect(url).toContain("example.com");
  });

  test("includes vault only when non-empty", () => {
    const withVault = obsidianClipRequest(makePayload(), "MyVault", "body", null, "legacy-uri");
    expect(withVault.url).toContain("&vault=MyVault");
    const withoutVault = obsidianClipRequest(makePayload(), "", "body", null, "legacy-uri");
    expect(withoutVault.url).not.toContain("&vault=");
  });

  test("URL starts with obsidian://new?file= and ends with &content=...", () => {
    const { url } = obsidianClipRequest(makePayload(), "v", "hello", null, "legacy-uri");
    expect(url.startsWith("obsidian://new?file=")).toBe(true);
    expect(url).toContain("&content=hello");
  });

  test("does NOT include the &clipboard flag", () => {
    const { url } = obsidianClipRequest(makePayload(), "v", "hello", null, "legacy-uri");
    expect(url).not.toContain("&clipboard");
  });

  test("clipboard payload is null", () => {
    const { clipboard } = obsidianClipRequest(makePayload(), "v", "hello", null, "legacy-uri");
    expect(clipboard).toBeNull();
  });

  test("vault name is URL-encoded", () => {
    const { url } = obsidianClipRequest(makePayload(), "My Vault", "body", null, "legacy-uri");
    expect(url).toContain("&vault=My%20Vault");
  });

  test("content is URL-encoded (newlines, ampersands)", () => {
    const { url } = obsidianClipRequest(makePayload(), "", "line1\nline2&more", null, "legacy-uri");
    expect(url).toContain("content=line1%0Aline2%26more");
  });
});

describe("obsidianClipRequest - clipboard mode", () => {
  test("URL includes the &clipboard flag", () => {
    const { url } = obsidianClipRequest(makePayload(), "v", "hello", null, "clipboard");
    expect(url).toContain("&clipboard");
  });

  test("URL's &content= carries only the fallback string, not the real markdown", () => {
    const realContent = "real markdown body that should NOT appear in the URL";
    const { url } = obsidianClipRequest(makePayload(), "v", realContent, null, "clipboard");
    expect(url).toContain(`&content=${encodeURIComponent(CLIPBOARD_FALLBACK_CONTENT)}`);
    expect(url).not.toContain(encodeURIComponent(realContent));
  });

  test("clipboard payload equals the full content", () => {
    const realContent = "# Heading\n\nFull body with & special chars.";
    const { clipboard } = obsidianClipRequest(makePayload(), "v", realContent, null, "clipboard");
    expect(clipboard).toBe(realContent);
  });

  test("file path and vault are encoded the same as in legacy mode", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Hello World" }),
      "My Vault",
      "body",
      null,
      "clipboard",
    );
    expect(url).toContain("file=Clippings%2FHello%20World");
    expect(url).toContain("&vault=My%20Vault");
  });

  test("&clipboard appears before &content= so Obsidian sees the flag", () => {
    const { url } = obsidianClipRequest(makePayload(), "", "body", null, "clipboard");
    const clipboardIdx = url.indexOf("&clipboard");
    const contentIdx = url.indexOf("&content=");
    expect(clipboardIdx).toBeGreaterThan(0);
    expect(contentIdx).toBeGreaterThan(clipboardIdx);
  });
});

describe("obsidianClipRequest - site rule subfolder routing", () => {
  test("places file under Clippings/<subfolder>/ when a rule is provided", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Repo Readme" }),
      "",
      "body",
      githubRule,
      "legacy-uri",
    );
    expect(url).toContain("file=Clippings%2FGitHub%2FRepo%20Readme");
  });

  test("uses the social-x rule's subfolder for x.com/twitter clips", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Thread" }),
      "",
      "body",
      socialRule,
      "legacy-uri",
    );
    expect(url).toContain("file=Clippings%2FSocial%2FThread");
  });

  test("falls back to Clippings/ when rule is null", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Plain" }),
      "",
      "body",
      null,
      "legacy-uri",
    );
    expect(url).toContain("file=Clippings%2FPlain");
    expect(url).not.toContain("Clippings%2FGitHub");
    expect(url).not.toContain("Clippings%2FSocial");
  });

  test("subfolder routing also applies in clipboard mode", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Repo Readme" }),
      "",
      "body",
      githubRule,
      "clipboard",
    );
    expect(url).toContain("file=Clippings%2FGitHub%2FRepo%20Readme");
  });
});

describe("normalizeBaseFolder", () => {
  test("returns 'Clippings' for empty / whitespace-only input", () => {
    expect(normalizeBaseFolder("")).toBe("Clippings");
    expect(normalizeBaseFolder("   ")).toBe("Clippings");
    expect(normalizeBaseFolder("\t \n")).toBe("Clippings");
  });

  test("strips leading and trailing slashes", () => {
    expect(normalizeBaseFolder("/Inbox/")).toBe("Inbox");
    expect(normalizeBaseFolder("///Inbox///")).toBe("Inbox");
  });

  test("collapses runs of internal slashes", () => {
    expect(normalizeBaseFolder("Inbox//Web")).toBe("Inbox/Web");
    expect(normalizeBaseFolder("a///b////c")).toBe("a/b/c");
  });

  test("trims outer whitespace before normalizing", () => {
    expect(normalizeBaseFolder("  /Inbox/Web/  ")).toBe("Inbox/Web");
  });

  test("leaves multi-segment paths intact", () => {
    expect(normalizeBaseFolder("Notes/Web/Clippings")).toBe("Notes/Web/Clippings");
  });

  test("an input of just slashes collapses to the default", () => {
    expect(normalizeBaseFolder("///")).toBe("Clippings");
  });
});

describe("obsidianClipRequest - custom base folder", () => {
  test("custom base folder rebases the file path (no rule)", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Note" }),
      "",
      "body",
      null,
      "legacy-uri",
      "Inbox",
    );
    expect(url).toContain("file=Inbox%2FNote");
    expect(url).not.toContain("Clippings");
  });

  test("custom base folder composes with site rules", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Repo Readme" }),
      "",
      "body",
      githubRule,
      "legacy-uri",
      "Inbox",
    );
    expect(url).toContain("file=Inbox%2FGitHub%2FRepo%20Readme");
  });

  test("multi-segment base folder is preserved", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Note" }),
      "",
      "body",
      socialRule,
      "legacy-uri",
      "Notes/Web",
    );
    expect(url).toContain("file=Notes%2FWeb%2FSocial%2FNote");
  });

  test("whitespace and stray slashes are normalized", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Note" }),
      "",
      "body",
      null,
      "legacy-uri",
      "  /Inbox//Web/  ",
    );
    expect(url).toContain("file=Inbox%2FWeb%2FNote");
  });

  test("blank/whitespace base folder falls back to 'Clippings'", () => {
    const { url: u1 } = obsidianClipRequest(
      makePayload({ title: "Note" }),
      "",
      "body",
      null,
      "legacy-uri",
      "",
    );
    const { url: u2 } = obsidianClipRequest(
      makePayload({ title: "Note" }),
      "",
      "body",
      null,
      "legacy-uri",
      "   ",
    );
    expect(u1).toContain("file=Clippings%2FNote");
    expect(u2).toContain("file=Clippings%2FNote");
  });

  test("custom base folder also applies in clipboard mode", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "Repo Readme" }),
      "",
      "body",
      githubRule,
      "clipboard",
      "Inbox",
    );
    expect(url).toContain("file=Inbox%2FGitHub%2FRepo%20Readme");
  });
});

describe("obsidianClipRequest - sanitizeFileName robustness", () => {
  function fileSegment(url: string): string {
    const m = url.match(/file=([^&]+)/)!;
    return decodeURIComponent(m[1]!).replace(/^Clippings\//, "");
  }

  test("strips # | ^ [ ]", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "a#b|c^d[e]f" }),
      "",
      "x",
      null,
      "legacy-uri",
    );
    expect(fileSegment(url)).toBe("abcdef");
  });

  test("strips / and : ", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "a/b:c" }),
      "",
      "x",
      null,
      "legacy-uri",
    );
    expect(fileSegment(url)).toBe("abc");
  });

  test("strips ASCII control characters", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "a\x00b\x1fc" }),
      "",
      "x",
      null,
      "legacy-uri",
    );
    expect(fileSegment(url)).toBe("abc");
  });

  test("strips leading dot(s)", () => {
    const { url } = obsidianClipRequest(
      makePayload({ title: "...hidden" }),
      "",
      "x",
      null,
      "legacy-uri",
    );
    expect(fileSegment(url)).toBe("hidden");
  });

  test("empty/whitespace-only/all-stripped title falls back to 'Untitled'", () => {
    expect(
      fileSegment(
        obsidianClipRequest(makePayload({ title: "   " }), "", "x", null, "legacy-uri").url,
      ),
    ).toBe("Untitled");
    expect(
      fileSegment(
        obsidianClipRequest(makePayload({ title: "###|||" }), "", "x", null, "legacy-uri").url,
      ),
    ).toBe("Untitled");
  });

  test("caps file name at 245 characters", () => {
    const longTitle = "a".repeat(500);
    const { url } = obsidianClipRequest(
      makePayload({ title: longTitle }),
      "",
      "x",
      null,
      "legacy-uri",
    );
    expect(fileSegment(url).length).toBe(245);
  });
});

describe("obsidianClipRequest - sanitizeFileName per platform", () => {
  function nameOn(title: string, platform: FilePlatform): string {
    const { url } = obsidianClipRequest(
      makePayload({ title }),
      "",
      "x",
      null,
      "legacy-uri",
      "Clippings",
      platform,
    );
    return decodeURIComponent(url.match(/file=([^&]+)/)![1]!).replace(/^Clippings\//, "");
  }

  test("Obsidian's own reserved characters go on every platform", () => {
    for (const platform of ["win", "mac", "other"] as const) {
      expect(nameOn("a#b|c^d[e]f", platform)).toBe("abcdef");
    }
  });

  test("/ and : go on every platform", () => {
    for (const platform of ["win", "mac", "other"] as const) {
      expect(nameOn("a/b:c", platform)).toBe("abc");
    }
  });

  test("Windows strips the characters Windows rejects", () => {
    expect(nameOn(`a<b>c"d\\e?f*g`, "win")).toBe("abcdefg");
  });

  test("macOS keeps them, matching Obsidian Web Clipper", () => {
    expect(nameOn(`a<b>c"d\\e?f*g`, "mac")).toBe(`a<b>c"d\\e?f*g`);
  });

  test("Linux and the rest get the Windows set, for vaults that sync", () => {
    expect(nameOn(`a<b>c"d\\e?f*g`, "other")).toBe("abcdefg");
  });

  test("Windows rewrites reserved DOS device names", () => {
    expect(nameOn("CON", "win")).toBe("_CON");
    expect(nameOn("nul.txt", "win")).toBe("_nul.txt");
    expect(nameOn("com3", "win")).toBe("_com3");
    // Only the whole name is reserved; a prefix is not.
    expect(nameOn("Console tricks", "win")).toBe("Console tricks");
    expect(nameOn("CON", "mac")).toBe("CON");
  });

  test("Windows trims trailing dots, which it silently drops on write", () => {
    // Obsidian appends ".md", so the note would be looked up as "Markdown..md"
    // and written as "Markdown.md".
    expect(nameOn("Markdown.", "win")).toBe("Markdown");
    expect(nameOn("Markdown.", "mac")).toBe("Markdown.");
  });

  test("a title that sanitizes away still falls back to Untitled", () => {
    expect(nameOn(`<>"?*`, "win")).toBe("Untitled");
  });
});
