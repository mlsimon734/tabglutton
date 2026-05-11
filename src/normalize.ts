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

function shouldStripParam(key: string, extras: Set<string>): boolean {
  if (TRACKING_PARAMS.has(key)) return true;
  if (extras.has(key)) return true;
  for (const prefix of TRACKING_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
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
