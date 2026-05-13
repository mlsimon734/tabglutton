import { describe, test, expect } from "bun:test";
import { normalizeUrl } from "../src/normalize.js";

describe("normalizeUrl - invalid input", () => {
  test("returns null for undefined", () => {
    expect(normalizeUrl(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(normalizeUrl("")).toBeNull();
  });

  test("returns null for malformed URL", () => {
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("http://")).toBeNull();
    expect(normalizeUrl("://no-scheme.example")).toBeNull();
  });
});

describe("normalizeUrl - non-http(s) protocols are passed through", () => {
  test("file: URL returns the raw input unchanged", () => {
    expect(normalizeUrl("file:///Users/me/notes.txt")).toBe("file:///Users/me/notes.txt");
  });

  test("about:blank returns the raw input unchanged", () => {
    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });

  test("chrome:// URL returns the raw input unchanged", () => {
    expect(normalizeUrl("chrome://extensions/")).toBe("chrome://extensions/");
  });
});

describe("normalizeUrl - host canonicalization", () => {
  test("lowercases host", () => {
    expect(normalizeUrl("https://Example.COM/Foo")).toBe("example.com/Foo");
  });

  test("strips a single leading www.", () => {
    expect(normalizeUrl("https://www.example.com/foo")).toBe("example.com/foo");
  });

  test("does not strip www inside the host", () => {
    expect(normalizeUrl("https://api.www.example.com/foo")).toBe("api.www.example.com/foo");
  });

  test("does not strip www2", () => {
    expect(normalizeUrl("https://www2.example.com/foo")).toBe("www2.example.com/foo");
  });

  test("preserves path casing", () => {
    expect(normalizeUrl("https://example.com/CamelCase")).toBe("example.com/CamelCase");
  });
});

describe("normalizeUrl - path canonicalization", () => {
  test("trailing slash is stripped on non-root paths", () => {
    expect(normalizeUrl("https://example.com/foo/")).toBe("example.com/foo");
  });

  test("root slash is preserved", () => {
    expect(normalizeUrl("https://example.com/")).toBe("example.com/");
  });

  test("URL with no explicit path normalizes to host + /", () => {
    expect(normalizeUrl("https://example.com")).toBe("example.com/");
  });

  test("nested trailing slash is stripped once", () => {
    expect(normalizeUrl("https://example.com/foo/bar/")).toBe("example.com/foo/bar");
  });
});

describe("normalizeUrl - tracking parameter filtering", () => {
  test("strips utm_* params", () => {
    expect(
      normalizeUrl("https://example.com/x?utm_source=newsletter&utm_medium=email&q=keep"),
    ).toBe("example.com/x?q=keep");
  });

  test("strips fbclid, gclid, msclkid, ysclid", () => {
    const url = "https://example.com/p?fbclid=a&gclid=b&msclkid=c&ysclid=d&keep=yes";
    expect(normalizeUrl(url)).toBe("example.com/p?keep=yes");
  });

  test("strips ref, ref_src, ref_url", () => {
    expect(
      normalizeUrl("https://example.com/p?ref=hn&ref_src=twsrc&ref_url=https%3A%2F%2Fx&q=1"),
    ).toBe("example.com/p?q=1");
  });

  test("strips mc_cid, mc_eid, _ga, igshid, si", () => {
    expect(normalizeUrl("https://example.com/p?mc_cid=1&mc_eid=2&_ga=3&igshid=4&si=5&q=keep")).toBe(
      "example.com/p?q=keep",
    );
  });

  test("respects extraStripParams", () => {
    const url = "https://example.com/p?campaign=spring&keep=yes";
    expect(normalizeUrl(url, { extraStripParams: ["campaign"] })).toBe("example.com/p?keep=yes");
  });

  test("removing all params leaves no query string", () => {
    expect(normalizeUrl("https://example.com/p?utm_source=x&fbclid=y")).toBe("example.com/p");
  });

  test("tracking-param stripping is case-sensitive (UTM_SOURCE kept)", () => {
    expect(normalizeUrl("https://example.com/p?UTM_SOURCE=keep")).toBe(
      "example.com/p?UTM_SOURCE=keep",
    );
  });
});

describe("normalizeUrl - query ordering and encoding", () => {
  test("params are sorted alphabetically", () => {
    expect(normalizeUrl("https://example.com/p?b=2&a=1&c=3")).toBe("example.com/p?a=1&b=2&c=3");
  });

  test("two URLs with different param order produce the same key", () => {
    const a = normalizeUrl("https://example.com/p?b=2&a=1");
    const b = normalizeUrl("https://example.com/p?a=1&b=2");
    expect(a).toBe(b!);
  });

  test("keys and values are percent-encoded deterministically", () => {
    expect(normalizeUrl("https://example.com/p?q=hello world&x=a+b")).toBe(
      "example.com/p?q=hello%20world&x=a%20b",
    );
  });

  test("preserves empty-value params", () => {
    expect(normalizeUrl("https://example.com/p?empty=&q=1")).toBe("example.com/p?empty=&q=1");
  });

  test("preserves repeated query keys", () => {
    const out = normalizeUrl("https://example.com/p?tag=a&tag=b");
    expect(out).toBe("example.com/p?tag=a&tag=b");
  });
});

describe("normalizeUrl - fragment handling", () => {
  test("stripFragment defaults to true: drops #hash", () => {
    expect(normalizeUrl("https://example.com/p#section")).toBe("example.com/p");
  });

  test("stripFragment: false preserves #hash", () => {
    expect(normalizeUrl("https://example.com/p#section", { stripFragment: false })).toBe(
      "example.com/p#section",
    );
  });

  test("stripFragment: false on URL without hash does not append empty hash", () => {
    expect(normalizeUrl("https://example.com/p", { stripFragment: false })).toBe("example.com/p");
  });
});

describe("normalizeUrl - robustness", () => {
  test("strips explicit port from the canonical key (URL.hostname excludes port)", () => {
    expect(normalizeUrl("https://example.com:8443/p")).toBe("example.com/p");
  });

  test("userinfo in URL is dropped (URL parses, not included in host)", () => {
    expect(normalizeUrl("https://user:pass@example.com/p")).toBe("example.com/p");
  });

  test("IDN host is canonicalized to punycode by URL parser", () => {
    const out = normalizeUrl("https://münchen.example/p");
    expect(out).not.toBeNull();
    expect(out!.startsWith("xn--")).toBe(true);
  });

  test("very long URL is normalized without throwing", () => {
    const long = "https://example.com/p?q=" + "x".repeat(5000);
    expect(typeof normalizeUrl(long)).toBe("string");
  });

  test("URL with only stripped params yields no '?' separator", () => {
    expect(normalizeUrl("https://example.com/p?utm_source=x")?.includes("?")).toBe(false);
  });
});
