import { describe, test, expect } from "bun:test";
import { BUILT_IN_RULES, pickRule, type SiteRule } from "../src/site-rules.js";

describe("pickRule - github", () => {
  test("matches a repo root URL", () => {
    expect(pickRule("https://github.com/owner/repo")?.id).toBe("github");
  });

  test("matches deeper paths (issues, PRs, files)", () => {
    expect(pickRule("https://github.com/owner/repo/issues/1")?.id).toBe("github");
    expect(pickRule("https://github.com/owner/repo/pull/42")?.id).toBe("github");
    expect(pickRule("https://github.com/owner/repo/blob/main/README.md")?.id).toBe("github");
  });

  test("matches www.github.com", () => {
    expect(pickRule("https://www.github.com/owner/repo")?.id).toBe("github");
  });

  test("returns the rule with subfolder 'GitHub'", () => {
    expect(pickRule("https://github.com/owner/repo")?.subfolder).toBe("GitHub");
  });
});

describe("pickRule - twitter/x", () => {
  test("matches x.com", () => {
    expect(pickRule("https://x.com/user/status/12345")?.id).toBe("social-x");
  });

  test("matches twitter.com", () => {
    expect(pickRule("https://twitter.com/user/status/12345")?.id).toBe("social-x");
  });

  test("matches www.x.com and www.twitter.com", () => {
    expect(pickRule("https://www.x.com/i/something")?.id).toBe("social-x");
    expect(pickRule("https://www.twitter.com/user")?.id).toBe("social-x");
  });

  test("returns the rule with subfolder 'Social'", () => {
    expect(pickRule("https://x.com/user")?.subfolder).toBe("Social");
  });
});

describe("pickRule - non-matches", () => {
  test("returns null for unmatched hosts", () => {
    expect(pickRule("https://example.com/article")).toBeNull();
    expect(pickRule("https://news.ycombinator.com/item?id=1")).toBeNull();
  });

  test("returns null for subdomains that aren't in the rule list", () => {
    expect(pickRule("https://gist.github.com/owner/abc123")).toBeNull();
    expect(pickRule("https://raw.githubusercontent.com/owner/repo/main/x")).toBeNull();
  });
});

describe("pickRule - edge cases", () => {
  test("is case-insensitive on the hostname", () => {
    expect(pickRule("HTTPS://GitHub.com/owner/repo")?.id).toBe("github");
    expect(pickRule("https://X.COM/user")?.id).toBe("social-x");
  });

  test("returns null for an invalid URL string instead of throwing", () => {
    expect(pickRule("not a url")).toBeNull();
    expect(pickRule("")).toBeNull();
  });

  test("respects a custom rules array", () => {
    const custom: SiteRule[] = [{ id: "blog", hostMatches: ["example.com"], subfolder: "Blogs" }];
    expect(pickRule("https://example.com/x", custom)?.id).toBe("blog");
    expect(pickRule("https://github.com/owner/repo", custom)).toBeNull();
  });
});

describe("BUILT_IN_RULES", () => {
  test("ships with github and social-x rules", () => {
    const ids = BUILT_IN_RULES.map((r) => r.id);
    expect(ids).toContain("github");
    expect(ids).toContain("social-x");
  });
});
