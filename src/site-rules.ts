import { normalizeUrl } from "./normalize.js";

/**
 * What a rule does to matching tabs, beyond filing them into a subfolder.
 * `devour` is the neutral default: the tab is clipped normally. The other three
 * are standing decisions Devour applies for the user — and every surface that
 * applies one says so, because a rule-driven disposition must never look like
 * the tool acting on its own.
 */
export type RuleDisposition = "devour" | "never-devour" | "auto-close" | "zotero";

/**
 * The colours both engines' `tabGroups.update` accepts (Firefox 139 / Chrome
 * 89 share the set — measured in #33).
 */
export const TAB_GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

export function isTabGroupColor(value: unknown): value is TabGroupColor {
  return TAB_GROUP_COLORS.some((color) => color === value);
}

/** A browser tab-strip group a rule writes its matches into. */
export interface RuleGroup {
  name: string;
  color: TabGroupColor;
}

export interface SiteRule {
  id: string;
  /**
   * Patterns matched against the same canonical key Dedup uses (`normalizeUrl`):
   * a bare host (`github.com`) matches every page on exactly that host, and a
   * host with a path prefix (`reddit.com/r/rust`) matches that subtree. Scheme,
   * case, `www.`, and tracking params are all canonicalized away.
   */
  hostMatches: string[];
  /** Subfolder under the clippings base folder; "" files into the base itself. */
  subfolder: string;
  disposition: RuleDisposition;
  /**
   * Orthogonal to the disposition: grouping tidies the tab strip, devouring
   * empties it, and a never-devour rule can still want its keepers gathered.
   * Absent = this rule does not group.
   */
  group?: RuleGroup;
}

/**
 * The seed, not the law: `loadSettings` hands these out only when nothing is
 * stored, and the options page lets the user edit or delete them like any rule
 * they wrote themselves.
 */
export const BUILT_IN_RULES: readonly SiteRule[] = [
  { id: "github", hostMatches: ["github.com"], subfolder: "GitHub", disposition: "devour" },
  {
    id: "social-x",
    hostMatches: ["twitter.com", "x.com"],
    subfolder: "Social",
    disposition: "devour",
  },
];

/** Fresh deep copies, so an editor can mutate them without touching the seed. */
export function seedRules(): SiteRule[] {
  return BUILT_IN_RULES.map((rule) => ({ ...rule, hostMatches: [...rule.hostMatches] }));
}

export function newRuleId(): string {
  return crypto.randomUUID();
}

export function isRuleDisposition(value: unknown): value is RuleDisposition {
  return (
    value === "devour" || value === "never-devour" || value === "auto-close" || value === "zotero"
  );
}

/**
 * What a rule is called anywhere a user sees it. Editor-written rules carry
 * UUID ids, so the id is an identity, never a label.
 */
export function ruleLabel(rule: SiteRule): string {
  return rule.hostMatches[0] ?? "unnamed rule";
}

/**
 * One pattern in the shape `normalizeUrl` emits: `host/`, or `host/path`.
 * Null when the pattern cannot name an http(s) page. The scheme is optional in
 * what the user types; anything else rides through the canonicalizer so a
 * pattern and the tab URL it is meant to match cannot disagree about case,
 * `www.`, trailing slashes, or tracking params.
 */
export function canonicalPattern(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    return null;
  }
  return normalizeUrl(withScheme);
}

/**
 * Whether one canonical pattern claims one canonical key. A host-only pattern
 * (`github.com/`) matches every page on exactly that host — subdomains are
 * different hosts, the same claim `normalizeUrl` makes for dedup. A path
 * pattern matches on path-segment boundaries, so `reddit.com/r/rust` takes
 * `/r/rust/comments/…` but not `/r/rustjerk`.
 */
function patternMatchesKey(pattern: string, key: string): boolean {
  const patternSlash = pattern.indexOf("/");
  const keySlash = key.indexOf("/");
  if (patternSlash < 0 || keySlash < 0) return false;
  if (pattern.slice(0, patternSlash) !== key.slice(0, keySlash)) return false;
  const patternRest = pattern.slice(patternSlash);
  if (patternRest === "/") return true;
  const keyRest = key.slice(keySlash);
  return (
    keyRest === patternRest ||
    keyRest.startsWith(`${patternRest}/`) ||
    keyRest.startsWith(`${patternRest}?`)
  );
}

/**
 * The first rule claiming `url`, in list order — the order is the precedence,
 * which is why the editor lets rules be reordered. Only http(s) pages match;
 * a rule cannot claim `about:` or extension pages.
 */
export function pickRule(url: string, rules: readonly SiteRule[]): SiteRule | null {
  const key = canonicalKeyFor(url);
  if (!key) return null;
  for (const rule of rules) {
    if (patternsMatchKey(rule.hostMatches, key)) return rule;
  }
  return null;
}

/**
 * Whether `url` is claimed by any of `patterns` — the grouping skip list asks
 * this without a rule in hand, so it shares the matcher rather than growing a
 * second, slightly different one.
 */
export function urlMatchesPatterns(url: string, patterns: readonly string[]): boolean {
  const key = canonicalKeyFor(url);
  return key !== null && patternsMatchKey(patterns, key);
}

function canonicalKeyFor(url: string): string | null {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return null;
  }
  if (protocol !== "http:" && protocol !== "https:") return null;
  return normalizeUrl(url);
}

function patternsMatchKey(patterns: readonly string[], key: string): boolean {
  for (const raw of patterns) {
    const pattern = canonicalPattern(raw);
    if (pattern && patternMatchesKey(pattern, key)) return true;
  }
  return false;
}

/**
 * Stored rules back into the declared shape. Absent or non-array storage gets
 * the seed; a present-but-empty list is a user who deleted every rule and
 * stays empty. Fields a future version adds (a group, say) default rather than
 * invalidate the entry, so the schema can grow without a migration.
 */
export function sanitizeSiteRules(raw: unknown): SiteRule[] {
  if (!Array.isArray(raw)) return seedRules();
  const rules: SiteRule[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || seen.has(record.id)) continue;
    seen.add(record.id);
    const hostMatches = Array.isArray(record.hostMatches)
      ? record.hostMatches
          .filter((h): h is string => typeof h === "string")
          .map((h) => h.trim())
          .filter(Boolean)
      : [];
    const rule: SiteRule = {
      id: record.id,
      hostMatches,
      subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
      disposition: isRuleDisposition(record.disposition) ? record.disposition : "devour",
    };
    const group = sanitizeRuleGroup(record.group);
    if (group) rule.group = group;
    rules.push(rule);
  }
  return rules;
}

/** A group needs a name; a missing or unknown colour defaults rather than drops. */
function sanitizeRuleGroup(raw: unknown): RuleGroup | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return undefined;
  return { name, color: isTabGroupColor(record.color) ? record.color : "grey" };
}
