import { describe, test, expect } from "bun:test";
import { markdownForClip, obsidianNewNoteUrl, type ClipPayload } from "../src/clip-format.js";

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

describe("obsidianNewNoteUrl", () => {
  test("uses Clippings/<title> as the file path", () => {
    const url = obsidianNewNoteUrl(makePayload({ title: "Hello" }), "", "body");
    expect(url).toContain("file=Clippings%2FHello");
  });

  test("encodes spaces and special chars in the file component", () => {
    const url = obsidianNewNoteUrl(makePayload({ title: "Hello World & Co" }), "", "body");
    expect(url).toContain("file=Clippings%2FHello%20World%20%26%20Co");
  });

  test("falls back to URL when title is empty", () => {
    const url = obsidianNewNoteUrl(
      makePayload({ title: "", url: "https://example.com/a" }),
      "",
      "body",
    );
    expect(url).toContain("file=Clippings%2F");
    expect(url).toContain("example.com");
  });

  test("includes vault only when non-empty", () => {
    const withVault = obsidianNewNoteUrl(makePayload(), "MyVault", "body");
    expect(withVault).toContain("&vault=MyVault");
    const withoutVault = obsidianNewNoteUrl(makePayload(), "", "body");
    expect(withoutVault).not.toContain("&vault=");
  });

  test("URL starts with obsidian://new?file= and ends with &content=...", () => {
    const url = obsidianNewNoteUrl(makePayload(), "v", "hello");
    expect(url.startsWith("obsidian://new?file=")).toBe(true);
    expect(url).toContain("&content=hello");
  });

  test("vault name is URL-encoded", () => {
    const url = obsidianNewNoteUrl(makePayload(), "My Vault", "body");
    expect(url).toContain("&vault=My%20Vault");
  });

  test("content is URL-encoded (newlines, ampersands)", () => {
    const url = obsidianNewNoteUrl(makePayload(), "", "line1\nline2&more");
    expect(url).toContain("content=line1%0Aline2%26more");
  });
});

describe("obsidianNewNoteUrl - sanitizeFileName robustness", () => {
  function fileSegment(url: string): string {
    const m = url.match(/file=([^&]+)/)!;
    return decodeURIComponent(m[1]!).replace(/^Clippings\//, "");
  }

  test("strips # | ^ [ ]", () => {
    const seg = fileSegment(obsidianNewNoteUrl(makePayload({ title: "a#b|c^d[e]f" }), "", "x"));
    expect(seg).toBe("abcdef");
  });

  test("strips / and : ", () => {
    const seg = fileSegment(obsidianNewNoteUrl(makePayload({ title: "a/b:c" }), "", "x"));
    expect(seg).toBe("abc");
  });

  test("strips ASCII control characters", () => {
    const seg = fileSegment(obsidianNewNoteUrl(makePayload({ title: "a\x00b\x1fc" }), "", "x"));
    expect(seg).toBe("abc");
  });

  test("strips leading dot(s)", () => {
    const seg = fileSegment(obsidianNewNoteUrl(makePayload({ title: "...hidden" }), "", "x"));
    expect(seg).toBe("hidden");
  });

  test("empty/whitespace-only/all-stripped title falls back to 'Untitled'", () => {
    expect(fileSegment(obsidianNewNoteUrl(makePayload({ title: "   " }), "", "x"))).toBe(
      "Untitled",
    );
    expect(fileSegment(obsidianNewNoteUrl(makePayload({ title: "###|||" }), "", "x"))).toBe(
      "Untitled",
    );
  });

  test("caps file name at 245 characters", () => {
    const longTitle = "a".repeat(500);
    const seg = fileSegment(obsidianNewNoteUrl(makePayload({ title: longTitle }), "", "x"));
    expect(seg.length).toBe(245);
  });
});
