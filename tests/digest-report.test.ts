import { describe, expect, test } from "bun:test";
import {
  BRIDGE_METHODS,
  BRIDGE_SIDECAR_METHODS,
  BridgeRequestError,
  DIGEST_LIMITS,
  parseDigestMirrorParams,
  parseDigestReportParams,
  sanitizeDigestText,
} from "../src/bridge-protocol.js";

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tabId: 1,
    url: "https://example.com/a",
    title: "A page",
    fate: "close",
    reason: "One line.",
    ...overrides,
  };
}

function refusal(raw: unknown): string {
  try {
    parseDigestReportParams(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeRequestError);
    expect((err as BridgeRequestError).code).toBe("bad-request");
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("method lists", () => {
  test("digest_report is an agent tool, digest_mirror is sidecar-only", () => {
    expect(BRIDGE_METHODS).toContain("digest_report");
    expect(BRIDGE_METHODS as readonly string[]).not.toContain("digest_mirror");
    expect(BRIDGE_SIDECAR_METHODS).toContain("digest_mirror");
  });
});

describe("parseDigestReportParams", () => {
  test("accepts a minimal report and keeps only what it knows", () => {
    const parsed = parseDigestReportParams({ items: [item({ extra: "ignored" })] });
    expect(parsed).toEqual({
      items: [
        {
          tabId: 1,
          url: "https://example.com/a",
          title: "A page",
          fate: "close",
          reason: "One line.",
        },
      ],
    });
  });

  test("items must be 1..150", () => {
    expect(refusal({ items: [] })).toContain("items");
    const many = Array.from({ length: DIGEST_LIMITS.items }, (_, i) => item({ tabId: i }));
    expect(parseDigestReportParams({ items: many }).items).toHaveLength(150);
    expect(refusal({ items: [...many, item({ tabId: 999 })] })).toContain("limit is 150");
  });

  test("names the item index and field", () => {
    expect(refusal({ items: [item(), item({ tabId: 2, fate: "maybe" })] })).toContain(
      "items[1].fate",
    );
    expect(refusal({ items: [item({ tabId: 1.5 })] })).toContain("items[0].tabId");
  });

  test("reason caps depend on fate, at N and N+1", () => {
    const at = (n: number) => "x".repeat(n);
    expect(() =>
      parseDigestReportParams({ items: [item({ fate: "worth-it", reason: at(800) })] }),
    ).not.toThrow();
    expect(refusal({ items: [item({ fate: "worth-it", reason: at(801) })] })).toContain(
      "limit is 800",
    );
    expect(() => parseDigestReportParams({ items: [item({ reason: at(240) })] })).not.toThrow();
    expect(refusal({ items: [item({ reason: at(241) })] })).toContain("limit is 240");
    expect(refusal({ items: [item({ fate: "file", reason: at(241) })] })).toContain("240");
  });

  test("other field caps at N and N+1", () => {
    const cases: Array<[string, number]> = [
      ["title", DIGEST_LIMITS.title],
      ["quote", DIGEST_LIMITS.quote],
      ["interest", DIGEST_LIMITS.interest],
    ];
    for (const [field, max] of cases) {
      expect(() =>
        parseDigestReportParams({ items: [item({ [field]: "y".repeat(max) })] }),
      ).not.toThrow();
      expect(refusal({ items: [item({ [field]: "y".repeat(max + 1) })] })).toContain(
        `items[0].${field}`,
      );
    }
    const longUrl = `https://example.com/${"p".repeat(DIGEST_LIMITS.url)}`;
    expect(refusal({ items: [item({ url: longUrl })] })).toContain("items[0].url");
  });

  test("url and link are http(s) only", () => {
    expect(refusal({ items: [item({ url: "javascript:alert(1)" })] })).toContain("http");
    expect(refusal({ items: [item({ url: "file:///etc/passwd" })] })).toContain("http");
    expect(refusal({ items: [item({ url: "not a url" })] })).toContain("not a URL");
    expect(refusal({ items: [item({ link: "data:text/html,hi" })] })).toContain("items[0].link");
    expect(
      parseDigestReportParams({ items: [item({ link: "http://example.org/x" })] }).items[0]?.link,
    ).toBe("http://example.org/x");
  });

  test("unreadable is required for could-not-read and refused elsewhere", () => {
    expect(refusal({ items: [item({ fate: "could-not-read" })] })).toContain("unreadable");
    expect(refusal({ items: [item({ fate: "could-not-read", unreadable: "nope" })] })).toContain(
      "unreadable",
    );
    expect(refusal({ items: [item({ unreadable: "thin" })] })).toContain(
      "only for fate could-not-read",
    );
    expect(
      parseDigestReportParams({
        items: [item({ fate: "could-not-read", unreadable: "pdf-viewer" })],
      }).items[0]?.unreadable,
    ).toBe("pdf-viewer");
  });

  test("the same page twice is fine; the same tab twice is not", () => {
    const parsed = parseDigestReportParams({
      items: [item({ tabId: 1 }), item({ tabId: 2 })],
    });
    expect(parsed.items).toHaveLength(2);
    expect(
      refusal({ items: [item({ tabId: 7 }), item({ tabId: 7, url: "https://b.test/" })] }),
    ).toContain("items[1].tabId repeats items[0].tabId");
  });

  test("strips controls, bidi characters, and newlines", () => {
    const parsed = parseDigestReportParams({
      items: [
        item({
          title: "  Evil‮gnp.exe\u0007 title ",
          reason: "line one\n\n## heading\r\n---\tend",
          quote: "a⁦b⁩c‏d",
        }),
      ],
    });
    const [only] = parsed.items;
    expect(only?.title).toBe("Evilgnp.exe title");
    expect(only?.reason).toBe("line one ## heading --- end");
    expect(only?.quote).toBe("abcd");
    // NEL is a C1 control, not JS whitespace: removed, not spaced.
    expect(sanitizeDigestText("a\u0085b")).toBe("ab");
    expect(sanitizeDigestText("a b")).toBe("a b");
  });

  test("an empty reason is refused", () => {
    expect(refusal({ items: [item({ reason: " \n " })] })).toContain("must not be empty");
  });

  test("the whole report is capped at 200 KB, with advice not to split", () => {
    const fat = Array.from({ length: 140 }, (_, i) =>
      item({
        tabId: i,
        title: "t".repeat(300),
        quote: "q".repeat(300),
        reason: "r".repeat(240),
        filler: "f".repeat(1000),
      }),
    );
    expect(refusal({ items: fat })).toContain("rather than splitting");
  });

  test("sitting is validated", () => {
    const parsed = parseDigestReportParams({
      items: [item()],
      sitting: { label: "Morning feeds", sources: ["X.com", "reddit.com"] },
    });
    expect(parsed.sitting).toEqual({ label: "Morning feeds", sources: ["x.com", "reddit.com"] });
    expect(refusal({ items: [item()], sitting: { sources: ["https://x.com/"] } })).toContain(
      "sitting.sources[0]",
    );
    expect(
      refusal({ items: [item()], sitting: { sources: Array.from({ length: 9 }, () => "a.b") } }),
    ).toContain("limit is 8");
    expect(refusal({ items: [item()], sitting: { label: "l".repeat(81) } })).toContain("80");
  });

  test("a model-supplied reporter passes through the parser, truncated (Gullet overwrites it)", () => {
    const parsed = parseDigestReportParams({
      items: [item()],
      reporter: { client: "c".repeat(100), gullet: 5, clientVersion: "1.0\n" },
    });
    expect(parsed.reporter).toEqual({ client: "c".repeat(60), clientVersion: "1.0" });
  });
});

describe("parseDigestMirrorParams", () => {
  const id = "0123456789abcdef0123456789abcdef";
  test("accepts the three states", () => {
    expect(parseDigestMirrorParams({ digestId: id, state: "written", file: "/v/D/x.md" })).toEqual({
      digestId: id,
      state: "written",
      file: "/v/D/x.md",
    });
    expect(parseDigestMirrorParams({ digestId: id, state: "failed", reason: "no vault" })).toEqual({
      digestId: id,
      state: "failed",
      reason: "no vault",
    });
    expect(parseDigestMirrorParams({ digestId: id, state: "off" })).toEqual({
      digestId: id,
      state: "off",
    });
  });
  test("refuses malformed input", () => {
    expect(() => parseDigestMirrorParams({ digestId: "x", state: "off" })).toThrow();
    expect(() => parseDigestMirrorParams({ digestId: id, state: "pending" })).toThrow();
    expect(() => parseDigestMirrorParams({ digestId: id, state: "written" })).toThrow();
  });
});
