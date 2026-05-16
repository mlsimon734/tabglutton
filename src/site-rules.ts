export interface SiteRule {
  id: string;
  hostMatches: string[];
  subfolder: string;
}

export const BUILT_IN_RULES: SiteRule[] = [
  { id: "github", hostMatches: ["github.com"], subfolder: "GitHub" },
  { id: "social-x", hostMatches: ["twitter.com", "x.com"], subfolder: "Social" },
];

function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

export function pickRule(url: string, rules: SiteRule[] = BUILT_IN_RULES): SiteRule | null {
  let host: string;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
  if (!host) return null;
  for (const rule of rules) {
    for (const candidate of rule.hostMatches) {
      if (normalizeHost(candidate) === host) return rule;
    }
  }
  return null;
}
