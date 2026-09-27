import { describe, expect, test } from "bun:test";
import {
  factsFor,
  fitWithin,
  IMAGE_SOURCE_MAX_PIXELS,
  imageDimensions,
  imageSourceAllowed,
  isStorableImage,
  PAGE_FACTS_VERSION,
  PAGE_IMAGE_MAX_CHARS,
  pageFactsFrom,
  parsePageFacts,
  quoteRepeatsDescription,
  rememberFacts,
  resolvePageResource,
  safeFavicon,
  shortPublished,
  type PageFacts,
} from "../src/page-facts.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function facts(tabId: number, url: string, extra: Partial<PageFacts> = {}): PageFacts {
  return { tabId, url, readAt: 1, ...extra };
}

describe("pageFactsFrom", () => {
  test("keeps the page's own metadata as inert single lines", () => {
    const f = pageFactsFrom({
      tabId: 3,
      url: "https://a.test/x",
      readAt: 9,
      payload: {
        title: "  A\ttitle\n",
        description: "Line one.\nLine two ‮evil",
        site: "A Site",
        author: "",
        published: "2026-09-18",
        page: { extras: { duration: "2:04:31", comments: 3 } },
      },
      tabFavicon: "https://a.test/f.ico",
      image: PNG,
    });
    expect(f).toEqual({
      tabId: 3,
      url: "https://a.test/x",
      readAt: 9,
      title: "A title",
      description: "Line one. Line two evil",
      site: "A Site",
      published: "2026-09-18",
      favicon: "https://a.test/f.ico",
      image: PNG,
      extras: { duration: "2:04:31", comments: 3 },
    });
  });

  test("unsafe favicon schemes and oversized images are dropped", () => {
    const f = pageFactsFrom({
      tabId: 1,
      url: "https://a.test/",
      readAt: 1,
      payload: {},
      tabFavicon: "https://cdn.test/icon.png",
      image: `data:image/png;base64,${"A".repeat(PAGE_IMAGE_MAX_CHARS)}`,
    });
    expect(f.favicon).toBe("https://cdn.test/icon.png");
    expect(f.image).toBeUndefined();
    const g = pageFactsFrom({
      tabId: 1,
      url: "https://a.test/",
      readAt: 1,
      payload: { page: { extras: { duration: "<b>" } } },
      tabFavicon: "javascript:alert(1)",
      image: "https://a.test/og.png",
    });
    expect(g).toEqual({ tabId: 1, url: "https://a.test/", readAt: 1 });
  });

  test("long descriptions are cut", () => {
    const f = pageFactsFrom({
      tabId: 1,
      url: "https://a.test/",
      readAt: 1,
      payload: { description: "word ".repeat(200) },
    });
    expect(f.description!.length).toBeLessThanOrEqual(400);
    expect(f.description!.endsWith("…")).toBe(true);
  });
});

describe("image and favicon rules", () => {
  test("only base64 raster data URLs under the cap are storable", () => {
    expect(isStorableImage(PNG)).toBe(true);
    expect(isStorableImage("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(isStorableImage("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isStorableImage("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isStorableImage('data:image/png;base64,AA")')).toBe(false);
    expect(isStorableImage("https://a.test/x.png")).toBe(false);
  });

  test("favicons: http(s) or a small raster data URL", () => {
    expect(safeFavicon("https://a.test/f.ico")).toBe("https://a.test/f.ico");
    expect(safeFavicon(PNG)).toBe(PNG);
    expect(safeFavicon("data:image/svg+xml,<svg onload=x>")).toBeUndefined();
    expect(safeFavicon("chrome://favicon/x")).toBeUndefined();
  });

  test("page resources resolve against the page and must be http(s)", () => {
    expect(resolvePageResource("/og.png", "https://a.test/p/q")).toBe("https://a.test/og.png");
    expect(resolvePageResource("//cdn.test/i.jpg", "https://a.test/")).toBe(
      "https://cdn.test/i.jpg",
    );
    expect(resolvePageResource("javascript:alert(1)", "https://a.test/")).toBeNull();
    expect(resolvePageResource("file:///etc/passwd", "https://a.test/")).toBeNull();
    expect(resolvePageResource(undefined, "https://a.test/")).toBeNull();
  });

  test("fitWithin scales the long edge down, never up", () => {
    expect(fitWithin(1280, 720, 640)).toEqual({ width: 640, height: 360 });
    expect(fitWithin(300, 1200, 640)).toEqual({ width: 160, height: 640 });
    expect(fitWithin(200, 100, 640)).toEqual({ width: 200, height: 100 });
    expect(fitWithin(0, 100, 640)).toEqual({ width: 0, height: 0 });
  });
});

describe("rememberFacts", () => {
  test("a re-read replaces, newest first, capped", () => {
    let list: PageFacts[] = [];
    list = rememberFacts(list, facts(1, "https://a.test/", { readAt: 1 }));
    list = rememberFacts(list, facts(2, "https://b.test/", { readAt: 2 }));
    list = rememberFacts(list, facts(1, "https://a.test/", { readAt: 3 }));
    expect(list.map((f) => [f.tabId, f.readAt])).toEqual([
      [1, 3],
      [2, 2],
    ]);
    expect(rememberFacts(list, facts(3, "https://c.test/"), 2).map((f) => f.tabId)).toEqual([3, 1]);
  });

  test("past the image budget the oldest reads lose their image and keep their text", () => {
    let list: PageFacts[] = [];
    for (let i = 0; i < 4; i++) {
      list = rememberFacts(
        list,
        facts(i, `https://${i}.test/`, { image: PNG, description: `d${i}` }),
        300,
        PNG.length * 2,
      );
    }
    expect(list.map((f) => [f.tabId, f.image !== undefined, f.description])).toEqual([
      [3, true, "d3"],
      [2, true, "d2"],
      [1, false, "d1"],
      [0, false, "d0"],
    ]);
  });
});

describe("factsFor and parsing", () => {
  test("tab id and normalized URL together", () => {
    const list = [facts(1, "https://www.a.test/x?utm_source=feed"), facts(2, "https://a.test/y")];
    expect(factsFor(list, 1, "https://a.test/x", {})?.tabId).toBe(1);
    expect(factsFor(list, 2, "https://a.test/x", {})).toBeUndefined();
    expect(factsFor(list, 1, "", {})).toBeUndefined();
  });

  test("storage is re-checked; bad entries are dropped whole", () => {
    const good = facts(1, "https://a.test/", { image: PNG, extras: { duration: "1:00" } });
    const parsed = parsePageFacts({
      v: PAGE_FACTS_VERSION,
      facts: [
        good,
        { ...facts(2, "https://b.test/"), image: "https://evil.test/x.png" },
        { ...facts(3, "https://c.test/"), favicon: "javascript:x" },
        { ...facts(4, "https://d.test/"), extras: { duration: "<img>", comments: -1 } },
        "junk",
      ],
    });
    expect(parsed).toEqual([good, facts(4, "https://d.test/")]);
    expect(parsePageFacts({ v: 99, facts: [good] })).toEqual([]);
    expect(parsePageFacts(undefined)).toEqual([]);
  });
});

describe("panel helpers", () => {
  test("a quote that repeats the description is recognised, cut short or not", () => {
    const d = "Sarah tackles war termination: why wars are easy to start, hard to end.";
    expect(quoteRepeatsDescription("Sarah tackles war termination: why wars are easy…", d)).toBe(
      true,
    );
    expect(quoteRepeatsDescription(`“${d}”`, d)).toBe(true);
    expect(quoteRepeatsDescription("A different line entirely, from the body text.", d)).toBe(
      false,
    );
    expect(quoteRepeatsDescription("Sarah", d)).toBe(false);
    expect(quoteRepeatsDescription(undefined, d)).toBe(false);
    expect(quoteRepeatsDescription("x", undefined)).toBe(false);
  });

  test("shortPublished: a short day, the year only when it differs", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(shortPublished("2026-09-18T10:00:00Z", now)).toMatch(/18/);
    expect(shortPublished("2026-09-18T10:00:00Z", now)).not.toMatch(/2026/);
    expect(shortPublished("2024-01-02T10:00:00Z", now)).toMatch(/2024/);
    expect(shortPublished("last week", now)).toBe("last week");
    expect(shortPublished(undefined, now)).toBeUndefined();
  });
});

describe("thumbnail source guards", () => {
  test("a page cannot aim the fetch at a private address", () => {
    const page = "https://news.test/a";
    expect(imageSourceAllowed("https://cdn.test/og.png", page)).toBe(true);
    expect(imageSourceAllowed("http://192.168.1.1/admin.png", page)).toBe(false);
    expect(imageSourceAllowed("http://10.0.0.2/x.png", page)).toBe(false);
    expect(imageSourceAllowed("http://127.0.0.1:4589/x.png", page)).toBe(false);
    expect(imageSourceAllowed("http://172.20.0.1/x.png", page)).toBe(false);
    expect(imageSourceAllowed("http://169.254.169.254/latest", page)).toBe(false);
    expect(imageSourceAllowed("http://[::1]/x.png", page)).toBe(false);
    expect(imageSourceAllowed("http://[fd00::1]/x.png", page)).toBe(false);
    expect(imageSourceAllowed("http://printer.local/x.png", page)).toBe(false);
    expect(imageSourceAllowed("http://localhost:3000/x.png", page)).toBe(false);
    expect(imageSourceAllowed("http://172.32.0.1/x.png", page)).toBe(true);
    // The page's own host is where the page itself loaded from.
    expect(imageSourceAllowed("http://127.0.0.1:8787/og.png", "http://127.0.0.1:8787/p")).toBe(
      true,
    );
    expect(imageSourceAllowed("javascript:alert(1)", page)).toBe(false);
  });

  test("image headers give their size without decoding", () => {
    const bytes = (...parts: Array<number[] | string>) =>
      new Uint8Array(
        parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
      );
    const png = bytes(
      [0x89],
      "PNG",
      [13, 10, 26, 10, 0, 0, 0, 13],
      "IHDR",
      [0, 0, 5, 0, 0, 0, 2, 208],
    );
    expect(imageDimensions(png)).toEqual({ width: 1280, height: 720 });
    expect(imageDimensions(bytes("GIF89a", [0x40, 0x01, 0xf0, 0x00]))).toEqual({
      width: 320,
      height: 240,
    });
    // JPEG: SOI, an APP0 segment, then SOF0 with height 600 and width 800.
    const jpeg = bytes(
      [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00],
      [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    expect(imageDimensions(jpeg)).toEqual({ width: 800, height: 600 });
    const vp8x = bytes(
      "RIFF",
      [0, 0, 0, 0],
      "WEBP",
      "VP8X",
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0x7f, 0x02, 0, 0x67, 0x01, 0],
    );
    expect(imageDimensions(vp8x)).toEqual({ width: 640, height: 360 });
    expect(imageDimensions(bytes("<svg"))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
    // A tiny file can declare an enormous image.
    const huge = bytes(
      [0x89],
      "PNG",
      [13, 10, 26, 10, 0, 0, 0, 13],
      "IHDR",
      [0, 1, 0, 0, 0, 1, 0, 0],
    );
    const size = imageDimensions(huge)!;
    expect(size.width * size.height).toBeGreaterThan(IMAGE_SOURCE_MAX_PIXELS);
  });
});
