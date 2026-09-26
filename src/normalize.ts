export interface NormalizeOpts {
  stripFragment?: boolean;
  extraStripParams?: string[];
}

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "ysclid",
  "msclkid",
  "ref",
  "ref_src",
  "ref_url",
  "mc_cid",
  "mc_eid",
  "_ga",
  "igshid",
  "si",
]);

const TRACKING_PREFIXES = ["utm_"];

/**
 * A query parameter that identifies the click, not the page. Exported because
 * the bridge's listing view trims the same params for a different purpose — it
 * needs a shorter *displayable* URL, where `normalizeUrl` produces a
 * scheme-less dedup key — and one list of tracking params is enough.
 */
export function isTrackingParam(key: string): boolean {
  if (TRACKING_PARAMS.has(key)) return true;
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function shouldStripParam(key: string, extras: Set<string>): boolean {
  return isTrackingParam(key) || extras.has(key);
}

export function normalizeUrl(rawUrl: string | undefined, opts: NormalizeOpts = {}): string | null {
  const { stripFragment = true, extraStripParams = [] } = opts;
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    return rawUrl;
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  let pathname = url.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  const extras = new Set(extraStripParams);
  const params: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    if (shouldStripParam(key, extras)) continue;
    params.push([key, value]);
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  let key = `${host}${pathname}`;
  if (search) key += `?${search}`;
  if (!stripFragment && url.hash) key += url.hash;

  return key;
}

// --- the listing's display form (Gullet renders it; digests read it back) ------

/**
 * URLs are trimmed structurally first (see `displayUrl`) and only clipped as a
 * backstop, which is why this is generous. A URL cut mid-string stops being a
 * URL: it cannot be copied, and two distinct tabs can clip to the same prefix
 * and read as duplicates. Losing a data: URI's payload is the case this exists
 * for, and there the prefix really is all the information there is.
 */
export const TAB_URL_MAX = 200;

/** Trailing ellipsis, so a clipped value can never be read as a complete one. */
const ELLIPSIS = "…";

/**
 * Tolerates a non-string because the tabs reaching here came off a socket. The
 * extension guarantees `title` and `url`, but a version-skewed or malformed one
 * does not, and one field missing from one tab must not throw away a listing of
 * eight hundred — the same reason `tabs_list` keeps a failing browser's partner.
 */
export function clipText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length <= max ? text : text.slice(0, max - 1) + ELLIPSIS;
}

/**
 * A shorter URL that is still a URL. Drops the click-tracking params, the `www.`
 * and the trailing slash — which is where long URLs get long — while keeping the
 * scheme, the parameter order the page actually used, and the fragment.
 *
 * Keeping the scheme costs ~8 bytes a tab and buys a string an agent can hand
 * back to the user verbatim; keeping the fragment is not optional, because for
 * an SPA the fragment is the whole page identity. Params keep their original
 * order rather than being sorted: `normalizeUrl` sorts because it is building a
 * comparison key, and this is not one.
 */
export function displayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Also the path for a missing or non-string url; see `clip`.
    return clipText(raw, TAB_URL_MAX);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return clipText(raw, TAB_URL_MAX);

  const host = url.host.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : "";
  const kept = [...url.searchParams].filter(([key]) => !isTrackingParam(key));
  const search = kept.length
    ? "?" + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  return clipText(`${url.protocol}//${host}${path}${search}${url.hash}`, TAB_URL_MAX);
}
