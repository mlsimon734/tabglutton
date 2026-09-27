// The few site-specific facts the Digest panel's site line can carry beyond
// Defuddle's own metadata: a video's running time and a thread's comment
// count. Pure, so the content script that gathers the raw inputs stays a
// collector and the parsing is unit-tested here.

/** Raw page signals as the content script found them. Every field is page-controlled. */
export interface PageSignals {
  /** Defuddle's `image` (usually og:image), as the page wrote it — maybe relative. */
  image?: string;
  extras?: PageExtras;
}

export interface PageExtras {
  /** A video's running time, already formatted (`2:04:31`). */
  duration?: string;
  /** A discussion's comment count. */
  comments?: number;
}

/** `PT2H4M31S` → `2:04:31`, `PT4M5S` → `4:05`. Anything else is null. */
export function formatIsoDuration(value: string): string | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.\d+)?S)?$/i.exec(value.trim());
  if (!m) return null;
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
  ];
  const h = days * 24 + hours;
  const total = h * 3600 + minutes * 60 + seconds;
  if (total <= 0 || total > 1_000 * 3600) return null;
  const mm = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  const hh = Math.floor(total / 3600);
  return hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

function nodes(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 50)) visit(x, depth + 1);
      return;
    }
    const obj = v as Record<string, unknown>;
    out.push(obj);
    if (obj["@graph"] !== undefined) visit(obj["@graph"], depth + 1);
  };
  visit(value, 0);
  return out;
}

function typed(obj: Record<string, unknown>, names: readonly string[]): boolean {
  const t = obj["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => typeof x === "string" && names.includes(x));
}

function count(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n < 1e9 ? n : null;
}

const VIDEO_TYPES = ["VideoObject"];
const THREAD_TYPES = [
  "DiscussionForumPosting",
  "SocialMediaPosting",
  "Article",
  "NewsArticle",
  "BlogPosting",
];

/**
 * The extras worth a site line, from schema.org data (Defuddle's
 * `schemaOrgData`) and two DOM attributes the content script reads when
 * present: YouTube's `<meta itemprop="duration">` and new Reddit's
 * `<shreddit-post comment-count>`. Cheap by construction — no fetch.
 */
export function pageExtras(input: {
  schemaOrgData?: unknown;
  durationMeta?: string | null;
  commentCountAttr?: string | null;
}): PageExtras {
  const extras: PageExtras = {};
  const all = nodes(input.schemaOrgData);
  const video = all.find((n) => typed(n, VIDEO_TYPES));
  const rawDuration =
    input.durationMeta ?? (typeof video?.duration === "string" ? video.duration : null);
  const duration = rawDuration ? formatIsoDuration(rawDuration) : null;
  if (duration) extras.duration = duration;

  let comments = count(input.commentCountAttr);
  if (comments === null) {
    for (const n of all) {
      if (!typed(n, THREAD_TYPES)) continue;
      comments = count(n.commentCount);
      if (comments !== null) break;
    }
  }
  if (comments !== null) extras.comments = comments;
  return extras;
}
