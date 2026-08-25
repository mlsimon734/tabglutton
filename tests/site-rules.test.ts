import { describe, test, expect } from "bun:test";
import {
  BUILT_IN_RULES,
  canonicalPattern,
  pickRule,
  ruleLabel,
  sanitizeSiteRules,
  seedRules,
  type SiteRule,
} from "../src/site-rules.js";

function rule(partial: Partial<SiteRule> & Pick<SiteRule, "id" | "hostMatches">): SiteRule {
  return { subfolder: "", disposition: "devour", ...partial };
}

describe("pickRule - github", () => {
  test("matches a repo root URL", () => {
    expect(pickRule("https://github.com/owner/repo", BUILT_IN_RULES)?.id).toBe("github");
  });

  test("matches deeper paths (issues, PRs, files)", () => {
    expect(pickRule("https://github.com/owner/repo/issues/1", BUILT_IN_RULES)?.id).toBe("github");
    expect(pickRule("https://github.com/owner/repo/pull/42", BUILT_IN_RULES)?.id).toBe("github");
    expect(pickRule("https://github.com/owner/repo/blob/main/README.md", BUILT_IN_RULES)?.id).toBe(
      "github",
    );
  });

  test("matches www.github.com", () => {
    expect(pickRule("https://www.github.com/owner/repo", BUILT_IN_RULES)?.id).toBe("github");
  });

  test("returns the rule with subfolder 'GitHub'", () => {
    expect(pickRule("https://github.com/owner/repo", BUILT_IN_RULES)?.subfolder).toBe("GitHub");
  });
});

describe("pickRule - twitter/x", () => {
  test("matches x.com and twitter.com, with and without www", () => {
    expect(pickRule("https://x.com/user/status/12345", BUILT_IN_RULES)?.id).toBe("social-x");
    expect(pickRule("https://twitter.com/user/status/12345", BUILT_IN_RULES)?.id).toBe("social-x");
    expect(pickRule("https://www.x.com/i/something", BUILT_IN_RULES)?.id).toBe("social-x");
    expect(pickRule("https://www.twitter.com/user", BUILT_IN_RULES)?.id).toBe("social-x");
  });

  test("returns the rule with subfolder 'Social'", () => {
    expect(pickRule("https://x.com/user", BUILT_IN_RULES)?.subfolder).toBe("Social");
  });
});

describe("pickRule - non-matches", () => {
  test("returns null for unmatched hosts", () => {
    expect(pickRule("https://example.com/article", BUILT_IN_RULES)).toBeNull();
    expect(pickRule("https://news.ycombinator.com/item?id=1", BUILT_IN_RULES)).toBeNull();
  });

  test("returns null for subdomains that aren't in the rule list", () => {
    expect(pickRule("https://gist.github.com/owner/abc123", BUILT_IN_RULES)).toBeNull();
    expect(
      pickRule("https://raw.githubusercontent.com/owner/repo/main/x", BUILT_IN_RULES),
    ).toBeNull();
  });

  test("returns null for non-http schemes", () => {
    expect(pickRule("about:blank", BUILT_IN_RULES)).toBeNull();
    expect(pickRule("ftp://github.com/thing", BUILT_IN_RULES)).toBeNull();
  });
});

describe("pickRule - edge cases", () => {
  test("is case-insensitive on the hostname", () => {
    expect(pickRule("HTTPS://GitHub.com/owner/repo", BUILT_IN_RULES)?.id).toBe("github");
    expect(pickRule("https://X.COM/user", BUILT_IN_RULES)?.id).toBe("social-x");
  });

  test("returns null for an invalid URL string instead of throwing", () => {
    expect(pickRule("not a url", BUILT_IN_RULES)).toBeNull();
    expect(pickRule("", BUILT_IN_RULES)).toBeNull();
  });

  test("respects a custom rules array", () => {
    const custom = [rule({ id: "blog", hostMatches: ["example.com"], subfolder: "Blogs" })];
    expect(pickRule("https://example.com/x", custom)?.id).toBe("blog");
    expect(pickRule("https://github.com/owner/repo", custom)).toBeNull();
  });
});

describe("pickRule - ordering", () => {
  test("first match wins, in list order", () => {
    const first = rule({ id: "first", hostMatches: ["example.com"], disposition: "never-devour" });
    const second = rule({ id: "second", hostMatches: ["example.com"], subfolder: "Second" });
    expect(pickRule("https://example.com/x", [first, second])?.id).toBe("first");
    expect(pickRule("https://example.com/x", [second, first])?.id).toBe("second");
  });

  test("a later, more specific path rule loses to an earlier host rule", () => {
    const host = rule({ id: "host", hostMatches: ["reddit.com"] });
    const path = rule({ id: "path", hostMatches: ["reddit.com/r/rust"] });
    expect(pickRule("https://reddit.com/r/rust/comments/1", [host, path])?.id).toBe("host");
    expect(pickRule("https://reddit.com/r/rust/comments/1", [path, host])?.id).toBe("path");
  });
});

describe("pickRule - path patterns", () => {
  const rules = [rule({ id: "rust", hostMatches: ["reddit.com/r/rust"], subfolder: "Rust" })];

  test("matches the subtree on path-segment boundaries", () => {
    expect(pickRule("https://reddit.com/r/rust", rules)?.id).toBe("rust");
    expect(pickRule("https://www.reddit.com/r/rust/comments/1/x", rules)?.id).toBe("rust");
    expect(pickRule("https://reddit.com/r/rust?sort=new", rules)?.id).toBe("rust");
  });

  test("does not match sibling paths sharing the prefix", () => {
    expect(pickRule("https://reddit.com/r/rustjerk", rules)).toBeNull();
    expect(pickRule("https://reddit.com/", rules)).toBeNull();
  });
});

describe("pickRule - canonicalization of patterns", () => {
  test("patterns tolerate scheme, case, www, and trailing slash", () => {
    const rules = [rule({ id: "gh", hostMatches: ["https://WWW.GitHub.com/"] })];
    expect(pickRule("https://github.com/owner/repo", rules)?.id).toBe("gh");
  });

  test("an unparseable pattern matches nothing and breaks nothing", () => {
    const rules = [rule({ id: "junk", hostMatches: ["http://", "   "] })];
    expect(pickRule("https://example.com/x", rules)).toBeNull();
  });
});

describe("canonicalPattern", () => {
  test("bare hosts canonicalize to host/", () => {
    expect(canonicalPattern("GitHub.com")).toBe("github.com/");
    expect(canonicalPattern("www.github.com/")).toBe("github.com/");
  });

  test("paths keep their prefix, tracking params are stripped", () => {
    expect(canonicalPattern("reddit.com/r/rust/")).toBe("reddit.com/r/rust");
    expect(canonicalPattern("example.com/a?utm_source=x")).toBe("example.com/a");
  });

  test("non-http and empty patterns are null", () => {
    expect(canonicalPattern("")).toBeNull();
    expect(canonicalPattern("ftp://example.com")).toBeNull();
    expect(canonicalPattern("about:blank")).toBeNull();
  });
});

describe("sanitizeSiteRules", () => {
  test("absent or non-array storage gets the seed", () => {
    expect(sanitizeSiteRules(undefined)).toEqual(seedRules());
    expect(sanitizeSiteRules("nonsense")).toEqual(seedRules());
  });

  test("an empty stored list stays empty — the user deleted every rule", () => {
    expect(sanitizeSiteRules([])).toEqual([]);
  });

  test("missing disposition defaults to devour (pre-disposition storage)", () => {
    const stored = [{ id: "github", hostMatches: ["github.com"], subfolder: "GitHub" }];
    expect(sanitizeSiteRules(stored)).toEqual([
      { id: "github", hostMatches: ["github.com"], subfolder: "GitHub", disposition: "devour" },
    ]);
  });

  test("group fields survive, default their colour, and drop with an empty name", () => {
    const stored = [
      { id: "a", hostMatches: ["a.com"], group: { name: "Alpha", color: "cyan" } },
      { id: "b", hostMatches: ["b.com"], group: { name: "Beta", color: "chartreuse" } },
      { id: "c", hostMatches: ["c.com"], group: { name: "   " } },
      { id: "d", hostMatches: ["d.com"], group: "nonsense" },
    ];
    const rules = sanitizeSiteRules(stored);
    expect(rules[0]!.group).toEqual({ name: "Alpha", color: "cyan" });
    expect(rules[1]!.group).toEqual({ name: "Beta", color: "grey" });
    expect(rules[2]!.group).toBeUndefined();
    expect(rules[3]!.group).toBeUndefined();
  });

  test("malformed entries are dropped, malformed fields default", () => {
    const stored = [
      null,
      "junk",
      { hostMatches: ["no-id.com"] },
      { id: "ok", hostMatches: ["  a.com  ", 7, ""], subfolder: 3, disposition: "explode" },
      { id: "ok", hostMatches: ["dup.com"] },
    ];
    expect(sanitizeSiteRules(stored)).toEqual([
      { id: "ok", hostMatches: ["a.com"], subfolder: "", disposition: "devour" },
    ]);
  });
});

describe("ruleLabel", () => {
  test("names a rule by its first pattern, never its id", () => {
    expect(ruleLabel(rule({ id: "b2c8", hostMatches: ["arxiv.org", "openreview.net"] }))).toBe(
      "arxiv.org",
    );
    expect(ruleLabel(rule({ id: "b2c8", hostMatches: [] }))).toBe("unnamed rule");
  });
});

describe("BUILT_IN_RULES", () => {
  test("ships with github and social-x rules, disposition devour", () => {
    const ids = BUILT_IN_RULES.map((r) => r.id);
    expect(ids).toContain("github");
    expect(ids).toContain("social-x");
    expect(BUILT_IN_RULES.every((r) => r.disposition === "devour")).toBe(true);
  });

  test("seedRules copies are independent of the seed", () => {
    const copy = seedRules();
    copy[0]!.hostMatches.push("mutated.example");
    expect(BUILT_IN_RULES[0]!.hostMatches).not.toContain("mutated.example");
  });
});
