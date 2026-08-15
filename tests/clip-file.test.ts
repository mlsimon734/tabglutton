// Pure logic only: `saveClipFile` drives browser.downloads and is exercised in a
// live browser, per the split documented in AGENTS.md.
import { describe, expect, test } from "bun:test";
import { clipDownloadPath, markdownDataUrl } from "../src/clip-file.js";
import { clipNotePath, type ClipPayload, type FilePlatform } from "../src/clip-format.js";
import { BUILT_IN_RULES, type SiteRule } from "../src/site-rules.js";

const githubRule = BUILT_IN_RULES.find((r) => r.id === "github") as SiteRule;

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

const PLATFORMS: FilePlatform[] = ["win", "mac", "other"];

describe("clipDownloadPath - shares the vault's path", () => {
  test("default folder, no rule", () => {
    expect(clipDownloadPath(makePayload(), null, "Clippings", "mac")).toBe(
      "Clippings/Example Title.md",
    );
  });

  test("a site rule's subfolder still applies", () => {
    expect(
      clipDownloadPath(
        makePayload({ url: "https://github.com/x/y", title: "Repo" }),
        githubRule,
        "Clippings",
        "mac",
      ),
    ).toBe("Clippings/GitHub/Repo.md");
  });

  test("a custom base folder is used verbatim, nested segments included", () => {
    expect(clipDownloadPath(makePayload(), null, "Inbox/Web", "mac")).toBe(
      "Inbox/Web/Example Title.md",
    );
  });

  test("an empty base folder falls back to Clippings, as it does in the vault", () => {
    expect(clipDownloadPath(makePayload(), null, "   ", "mac")).toBe("Clippings/Example Title.md");
  });

  // The whole point of reusing clipNotePath rather than forking the formatter:
  // one page filed by either destination lands under the same name.
  test("is the vault-relative note path plus .md, on every platform", () => {
    for (const platform of PLATFORMS) {
      const payload = makePayload({ title: 'Weird: <name> "quoted"?' });
      const note = clipNotePath(payload, githubRule, "Clippings", platform);
      expect(clipDownloadPath(payload, githubRule, "Clippings", platform)).toBe(`${note}.md`);
    }
  });

  test("the per-platform note sanitizer is the one doing the work", () => {
    const payload = makePayload({ title: 'Report: "Q1" <draft>' });
    expect(clipDownloadPath(payload, null, "Clippings", "mac")).toBe(
      'Clippings/Report "Q1" <draft>.md',
    );
    expect(clipDownloadPath(payload, null, "Clippings", "win")).toBe(
      "Clippings/Report Q1 draft.md",
    );
  });
});

describe("clipDownloadPath - the downloads API's own rules", () => {
  // Each of these rejects the whole downloads.download call rather than being
  // cleaned up, and Obsidian accepts all of them, so they are trimmed here.
  test("a component that ends with a dot is trimmed", () => {
    expect(clipDownloadPath(makePayload({ title: "Version 1." }), null, "Clippings", "mac")).toBe(
      "Clippings/Version 1.md",
    );
  });

  test("dots and back-references in the base folder are dropped", () => {
    expect(clipDownloadPath(makePayload(), null, "../../etc", "mac")).toBe("etc/Example Title.md");
    expect(clipDownloadPath(makePayload(), null, "./Notes/.", "mac")).toBe(
      "Notes/Example Title.md",
    );
  });

  test("a base folder that trims away entirely leaves a bare file name", () => {
    expect(clipDownloadPath(makePayload(), null, "..", "mac")).toBe("Example Title.md");
  });

  test("a backslash never becomes a Windows path separator", () => {
    expect(clipDownloadPath(makePayload({ title: "a\\b" }), null, "Notes\\Web", "mac")).toBe(
      "NotesWeb/ab.md",
    );
  });

  // A title that sanitizes away must not promote its folder into the file name.
  test("a note name that trims to nothing falls back to Untitled", () => {
    expect(clipDownloadPath(makePayload({ title: "..." }), null, "Clippings", "mac")).toBe(
      "Clippings/Untitled.md",
    );
    expect(clipDownloadPath(makePayload({ title: "\\" }), null, "Clippings", "mac")).toBe(
      "Clippings/Untitled.md",
    );
  });
});

describe("markdownDataUrl", () => {
  test("round-trips ASCII", () => {
    const url = markdownDataUrl("# Hello\n\nBody.");
    expect(url.startsWith("data:text/markdown;base64,")).toBe(true);
    expect(decode(url)).toBe("# Hello\n\nBody.");
  });

  // btoa reads Latin-1, so a clip containing any of this throws without the
  // TextEncoder step rather than writing a mangled note.
  test("round-trips non-Latin-1 text and astral characters", () => {
    const text = "Тест — 日本語 — 🐛 — naïve";
    expect(decode(markdownDataUrl(text))).toBe(text);
  });

  test("round-trips a note longer than one encoding chunk", () => {
    const text = "é".repeat(0x8000 + 17);
    expect(decode(markdownDataUrl(text))).toBe(text);
  });
});

function decode(dataUrl: string): string {
  const base64 = dataUrl.slice("data:text/markdown;base64,".length);
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}
