// The one line of format shared across the extension/sidecar boundary.
//
// Gullet attributes a clip to the note that recorded its URL, which means it
// parses the `source` property `markdownForClip` writes. It cannot import this
// module — clip-format's import graph reaches browser-typed code and Gullet's
// tsconfig has no DOM — so the coupling is pinned from this side, where the
// format lives. `noteOwnership` degrades to freshness-only if these ever drift,
// so a break here is a lost defence rather than a wrong answer, and this test is
// how it stops being silent.

import { describe, expect, test } from "bun:test";
import { markdownForClip, type ClipPayload } from "../src/clip-format.js";
import { clipContentHash, noteSourceUrl } from "../gullet/src/clip-verify.js";

function payload(overrides: Partial<ClipPayload> = {}): ClipPayload {
  return {
    title: "A Post",
    url: "https://example.com/post",
    author: "",
    published: "",
    description: "",
    site: "Example",
    wordCount: 10,
    markdown: "Body.",
    ...overrides,
  };
}

describe("frontmatter source, as Gullet reads it", () => {
  test("round-trips the clipped page's URL", () => {
    expect(noteSourceUrl(markdownForClip(payload()))).toBe("https://example.com/post");
  });

  test("round-trips a URL carrying quotes and other escapables", () => {
    const url = 'https://example.com/search?q="quoted"&x=\\';
    expect(noteSourceUrl(markdownForClip(payload({ url })))).toBe(url);
  });

  // The strip Gullet mirrors: a text fragment addresses a position, not a page.
  test("records a text-fragment URL without the fragment", () => {
    const note = markdownForClip(payload({ url: "https://example.com/post#:~:text=some%20words" }));
    expect(noteSourceUrl(note)).toBe("https://example.com/post");
  });

  // A title with a quote in it must not truncate the frontmatter and take the
  // source line with it.
  test("survives a title that itself contains quotes", () => {
    const note = markdownForClip(payload({ title: 'The "Best" Post' }));
    expect(noteSourceUrl(note)).toBe("https://example.com/post");
  });
});

/**
 * The other cross-boundary coupling: the extension hashes with WebCrypto in the
 * browser, Gullet with Bun's hasher on the filesystem side, and a clip is
 * attributed by those two agreeing. Nothing else would catch them diverging —
 * over an encoding, a digest, or a hex-vs-base64 change — and the symptom would
 * be every clip reported as unconfirmed.
 */
describe("content hash, across the extension/sidecar boundary", () => {
  async function webCryptoSha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  test("the browser's digest of a clip matches the one Gullet takes of the file", async () => {
    const note = markdownForClip(payload());
    expect(await clipContentHash(note)).toBe(await webCryptoSha256Hex(note));
  });

  // Non-ASCII is where an encoding mismatch would surface — a real clip is full
  // of it (em dashes, smart quotes, emoji).
  test("agrees on text well outside ASCII", async () => {
    const note = markdownForClip(
      payload({ title: "Ünïcödé — 🐊 “smart” quotes", markdown: "Ünïcödé body 🐊" }),
    );
    expect(await clipContentHash(note)).toBe(await webCryptoSha256Hex(note));
  });
});
