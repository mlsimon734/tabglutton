// Page facts: what a page said about itself when the extension read it — its
// image, description, site, author, date, favicon, and a couple of extras —
// recorded so the Digest panel can show the page's own voice beside the
// agent's claim about it. Pure; `page-facts-store.ts` is the browser half.
//
// These are browser-observed, never agent-supplied: they are recorded from the
// extension's own Defuddle read (`tab_read`), and `digest_report` has no field
// that reaches them. They are keyed by tab id plus URL, the digest's identity
// rule, so a report's item finds the read of that very tab on that very page.
// The page itself is still untrusted: every string is sanitized to one inert
// line and rendered with `textContent`, and the only image kept is a small
// `data:` thumbnail made at read time, so the panel never loads a remote image.

import { asRecord, sanitizeDigestText } from "./bridge-protocol.js";
import type { PageExtras, PageSignals } from "./page-extras.js";
import { normalizeUrl, type NormalizeOpts } from "./normalize.js";

export const PAGE_FACTS_KEY = "pageFacts";
export const PAGE_FACTS_VERSION = 1;
/** Reads remembered, newest first. A digest sitting reads a few dozen. */
export const PAGE_FACTS_RETENTION = 300;
/**
 * The ceiling for one thumbnail, as `data:` URL characters: about 40 KB of
 * image bytes once base64 is taken off. Measured thumbnails land well under it.
 */
export const PAGE_IMAGE_MAX_CHARS = 56_000;
/**
 * Every stored thumbnail together, in characters. `storage.local` on Chrome
 * holds 10 MB without `unlimitedStorage`, which this extension does not ask
 * for; past this budget the oldest reads lose their image first and keep
 * their text.
 */
export const PAGE_IMAGE_BUDGET_CHARS = 3_000_000;
/** The longest edge a thumbnail is drawn at, in pixels (the pane shows ~380 CSS px). */
export const PAGE_IMAGE_EDGE = 640;

const CAP = { description: 400, title: 300, short: 120, favicon: 8_000 } as const;

export interface PageFacts {
  tabId: number;
  /** The page's committed URL at read time. */
  url: string;
  readAt: number;
  title?: string;
  description?: string;
  site?: string;
  author?: string;
  published?: string;
  /** http(s) or a small `data:image/…`; the tab's own when it had one. */
  favicon?: string;
  /** A `data:image/…;base64` thumbnail of the page's og:image, made at read time. */
  image?: string;
  extras?: PageExtras;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = sanitizeDigestText(value);
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const DATA_IMAGE =
  /^data:image\/(png|jpeg|webp|gif|avif|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i;

/** A thumbnail this module will store: base64 raster `data:` only, under the cap. */
export function isStorableImage(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= PAGE_IMAGE_MAX_CHARS && DATA_IMAGE.test(value)
  );
}

/** A favicon the panel may point an `<img>`-less background at: http(s), or a small raster `data:`. */
export function safeFavicon(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > CAP.favicon) return undefined;
  if (DATA_IMAGE.test(value)) return value;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The absolute http(s) address of a page-relative resource (og:image), or
 * null. Only what a page could have loaded itself is fetched.
 */
export function resolvePageResource(raw: string | undefined, pageUrl: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), pageUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Whether the background may fetch this og:image for a thumbnail. The fetch
 * carries host permission, so neither CORS nor Chrome's private-network rules
 * stand in its way; a page must not be able to aim it at the user's router or
 * a loopback service. An image on the page's own host is always fine (the
 * page loaded from there); otherwise a literal loopback, private, link-local,
 * or `.local` host is refused. Hostnames are not resolved.
 */
export function imageSourceAllowed(imageUrl: string, pageUrl: string): boolean {
  let image: URL;
  let page: URL;
  try {
    image = new URL(imageUrl);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (image.protocol !== "http:" && image.protocol !== "https:") return false;
  if (image.hostname === page.hostname) return true;
  const host = image.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(":")) {
    return !(
      host === "::1" ||
      host === "::" ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("::ffff:")
    );
  }
  return true;
}

/** Pixels a thumbnail source may decode to: a 1-2 MB PNG can declare far more. */
export const IMAGE_SOURCE_MAX_PIXELS = 40_000_000;

/**
 * A raster image's declared width and height, read from its header without
 * decoding it (PNG, GIF, JPEG, WebP), or null when the format is not one of
 * those or the header is malformed. Decoding is what costs memory, and the
 * page chooses the image, so the size is checked before anything decodes it.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const at = (i: number) => bytes[i] ?? 0;
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const le24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  const be32 = (i: number) =>
    ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  const ascii = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  if (bytes.length >= 24 && at(0) === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return { width: be32(16), height: be32(20) };
  }
  if (bytes.length >= 10 && ascii(0, 4) === "GIF8") return { width: le16(6), height: le16(8) };
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (kind === "VP8L") {
      const b = (i: number) => at(21 + i);
      return {
        width: 1 + (b(0) | ((b(1) & 0x3f) << 8)),
        height: 1 + ((b(1) >> 6) | (b(2) << 2) | ((b(3) & 0x0f) << 10)),
      };
    }
    if (kind === "VP8X") return { width: 1 + le24(24), height: 1 + le24(27) };
    return null;
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i++;
        continue;
      }
      // SOF0-SOF15, less DHT (C4), JPG (C8), and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: be16(i + 7), height: be16(i + 5) };
      }
      i += 2 + be16(i + 2);
    }
    return null;
  }
  return null;
}

/** Scale `w×h` to fit `edge` on its longer side, never up. */
export function fitWithin(w: number, h: number, edge: number): { width: number; height: number } {
  if (!(w > 0 && h > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, edge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Encoding attempts for a thumbnail, best first: stop at the first that fits
 * `PAGE_IMAGE_MAX_CHARS`. WebP where the engine encodes it; JPEG otherwise.
 */
export const THUMBNAIL_LADDER: ReadonlyArray<{ edge: number; quality: number }> = [
  { edge: PAGE_IMAGE_EDGE, quality: 0.72 },
  { edge: PAGE_IMAGE_EDGE, quality: 0.5 },
  { edge: 400, quality: 0.5 },
];

function extras(value: unknown): PageExtras | undefined {
  const o = asRecord(value);
  if (!o) return undefined;
  const out: PageExtras = {};
  const duration = text(o.duration, 16);
  if (duration && /^\d{1,4}(:\d\d){1,2}$/.test(duration)) out.duration = duration;
  if (typeof o.comments === "number" && Number.isInteger(o.comments) && o.comments >= 0) {
    out.comments = o.comments;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The facts to store for one read. `payload` is the extraction; `tabFavicon`
 * is the browser's own favicon for the tab — the one it actually loaded and
 * shows in the tab strip. Defuddle's `favicon` is not used: with no
 * `<link rel=icon>` it guesses `/favicon.ico`, and a guess that 404s would
 * draw an empty tile where the letter fallback belongs.
 */
export function pageFactsFrom(input: {
  tabId: number;
  url: string;
  readAt: number;
  payload: {
    title?: string;
    description?: string;
    site?: string;
    author?: string;
    published?: string;
    page?: PageSignals;
  };
  tabFavicon?: string;
  image?: string | null;
}): PageFacts {
  const p = input.payload;
  const favicon = safeFavicon(input.tabFavicon);
  const fields: Omit<PageFacts, "tabId" | "url" | "readAt"> = {
    title: text(p.title, CAP.title),
    description: text(p.description, CAP.description),
    site: text(p.site, CAP.short),
    author: text(p.author, CAP.short),
    published: text(p.published, CAP.short),
    favicon,
    image: isStorableImage(input.image) ? input.image : undefined,
    extras: extras(p.page?.extras),
  };
  const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return { tabId: input.tabId, url: input.url, readAt: input.readAt, ...kept };
}

/**
 * Add a read, newest first: a re-read of the same tab on the same URL replaces
 * the old one, the list is capped, and past the image budget the oldest reads
 * give up their thumbnails before anything else goes.
 */
export function rememberFacts(
  list: readonly PageFacts[],
  entry: PageFacts,
  retention: number = PAGE_FACTS_RETENTION,
  budget: number = PAGE_IMAGE_BUDGET_CHARS,
): PageFacts[] {
  const rest = list.filter((f) => !(f.tabId === entry.tabId && f.url === entry.url));
  const next = [entry, ...rest].slice(0, Math.max(0, retention));
  let used = 0;
  return next.map((f) => {
    if (!f.image) return f;
    used += f.image.length;
    if (used <= budget) return f;
    const { image: _dropped, ...kept } = f;
    return kept;
  });
}

/** The read of this tab on this page, by tab id and normalized URL together. */
export function factsFor(
  list: readonly PageFacts[],
  tabId: number,
  url: string,
  opts: NormalizeOpts,
): PageFacts | undefined {
  if (!url) return undefined;
  const key = normalizeUrl(url, opts);
  return list.find((f) => f.tabId === tabId && normalizeUrl(f.url, opts) === key);
}

function isFacts(value: unknown): value is PageFacts {
  const o = asRecord(value);
  if (!o) return false;
  const optStr = (v: unknown) => v === undefined || typeof v === "string";
  return (
    typeof o.tabId === "number" &&
    typeof o.url === "string" &&
    typeof o.readAt === "number" &&
    optStr(o.title) &&
    optStr(o.description) &&
    optStr(o.site) &&
    optStr(o.author) &&
    optStr(o.published) &&
    (o.favicon === undefined || safeFavicon(o.favicon) !== undefined) &&
    (o.image === undefined || isStorableImage(o.image)) &&
    (o.extras === undefined || asRecord(o.extras) !== null)
  );
}

/** Storage is user-editable: anything that fails a check is dropped whole. */
export function parsePageFacts(raw: unknown): PageFacts[] {
  const o = asRecord(raw);
  if (!o || o.v !== PAGE_FACTS_VERSION || !Array.isArray(o.facts)) return [];
  return o.facts.filter(isFacts).map((f) => {
    const clean = extras(f.extras);
    const { extras: _raw, ...rest } = f;
    return clean ? { ...rest, extras: clean } : rest;
  });
}

// --- panel helpers -------------------------------------------------------------

function comparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”"'‘’…]|\.{3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the agent's quote only repeats the page's own description, in which
 * case the panel shows the description once, in the page's voice. An agent
 * usually quotes the opening of a description, sometimes cut short with an
 * ellipsis, so containment either way counts; a short quote never does.
 */
export function quoteRepeatsDescription(quote: string | undefined, description?: string): boolean {
  if (!quote || !description) return false;
  const q = comparable(quote);
  const d = comparable(description);
  if (q.length < 24 || d.length < 24) return q === d && q.length > 0;
  return d.includes(q) || q.includes(d);
}

/** A page's published date as a short day, or its own words when it is not a date. */
export function shortPublished(value: string | undefined, now: number): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return value.length <= 24 ? value : undefined;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
