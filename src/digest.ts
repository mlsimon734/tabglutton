// The digest model: what a stored digest is, how its items find their tabs,
// and what the panel may do with them. Pure, so the identity and exclusion
// rules are unit-testable; `digest-store.ts` owns the storage and the browser.
//
// A digest keeps three kinds of fact apart, because later work extends each
// separately: the agent's claims (`fate`, `reason`, `quote`), what the browser
// observed when the report arrived (`observed`, `anchor`), and what the user
// decided (`userFate`, the recorded actions).

import {
  asRecord,
  DIGEST_FATES,
  DIGEST_UNREADABLE,
  tabDomain,
  type DigestFate,
  type DigestMirrorState,
  type DigestNoteItem,
  type DigestNoteSource,
  type DigestReportParams,
  type DigestReporter,
} from "./bridge-protocol.js";
import { normalizeUrl, type NormalizeOpts } from "./normalize.js";
import type { UndoBatch } from "./undo-log.js";

export const DIGESTS_KEY = "digests";
export const DIGEST_STORE_VERSION = 1;
/**
 * A digest is useful for days, not months; history is the fate ledger's job
 * (#80). At the 200 KB parse cap this bounds the key near 2 MB.
 */
export const DIGEST_RETENTION = 10;
/** The popup's "Digest ready" line stops offering a digest this old. */
export const DIGEST_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** The tab group Keep writes into. Same name in a window means the same group. */
export const DIGEST_GROUP_NAME = "Worth your time";
/** Close batches remembered per digest, newest first. The undo log holds the truth. */
const CLOSE_HISTORY = 5;

/** What the browser saw of the named tab when the report arrived. */
export interface DigestObserved {
  /** The named tab was open, on the item's page. */
  open: boolean;
  lastAccessed?: number;
  discarded?: boolean;
  pinned?: boolean;
}

export interface DigestItemRecord extends DigestNoteItem {
  /** The agent's `tabId`. Trusted only together with the URL. */
  tabIdHint: number;
  /**
   * The window and privacy context of the exact tab the report named, when it
   * was open on the item's URL. A URL-only fallback is confined to this window
   * and context; without an anchor there is no fallback at all.
   */
  anchor?: { windowId: number; incognito: boolean };
  observed: DigestObserved;
  /** The user moved the row. `effectiveFate` is this, else the agent's `fate`. */
  userFate?: DigestFate;
}

/**
 * What one action did to one item. `grouped`/`closed` are successes; the rest
 * say why an item was left alone, and every one of them leaves the tab as it was.
 */
export type DigestItemOutcome =
  | "grouped"
  | "closed"
  | "pinned"
  | "active"
  | "hidden"
  | "gone"
  | "ambiguous"
  | "changed"
  | "failed";

export interface DigestActionRecord {
  /** Written before the browser is touched, so a lost write after it is recoverable. */
  startedAt: number;
  at?: number;
  /** The undo batch a close wrote. Undo state is read from the undo log, not from here. */
  batchId?: string;
  outcomes: Array<{ index: number; outcome: DigestItemOutcome }>;
}

export interface DigestRecord {
  id: string;
  receivedAt: number;
  reporter: DigestReporter;
  sitting: DigestNoteSource["sitting"];
  items: DigestItemRecord[];
  /** First render in the panel; turns the popup's line off. */
  openedAt?: number;
  /** The latest Keep in a group. */
  keep?: DigestActionRecord;
  /** Close actions, newest first. */
  closes: DigestActionRecord[];
  mirror: DigestMirrorState;
}

export interface DigestStore {
  v: typeof DIGEST_STORE_VERSION;
  digests: DigestRecord[];
}

/** The two bulk actions in this slice. File is deferred; could-not-read has none. */
export type DigestAction = "keep" | "close";

export function actionFate(action: DigestAction): DigestFate {
  return action === "keep" ? "worth-it" : "close";
}

export function effectiveFate(item: Pick<DigestItemRecord, "fate" | "userFate">): DigestFate {
  return item.userFate ?? item.fate;
}

export function digestCounts(
  items: ReadonlyArray<{ fate: DigestFate }>,
): Record<DigestFate, number> {
  const counts = { "worth-it": 0, file: 0, close: 0, "could-not-read": 0 };
  for (const item of items) counts[item.fate] += 1;
  return counts;
}

// --- identity ---------------------------------------------------------------

/**
 * The slice of a live tab identity needs. `url` is the **committed** URL only
 * (`tab.url`), never Chrome's `pendingUrl`: a tab still navigating is not yet
 * on any page, so it matches nothing rather than being guessed at.
 */
export interface LiveTab {
  id: number;
  url: string;
  windowId: number;
  incognito: boolean;
  pinned: boolean;
  active: boolean;
  hidden: boolean;
  discarded: boolean;
  lastAccessed?: number;
  favIconUrl?: string;
}

export type DigestResolution =
  | { kind: "exact" | "fallback"; tab: LiveTab }
  | { kind: "gone" }
  | { kind: "ambiguous" };

function urlKey(url: string, opts: NormalizeOpts): string | null {
  return url ? normalizeUrl(url, opts) : null;
}

/**
 * Find each item's tab, or refuse. Never picks by recency, and never lets two
 * items claim one tab.
 *
 * 1. **Exact**: the hinted id is live and its committed URL normalizes to the
 *    item's. Normalized rather than raw because the agent saw Gullet's
 *    shortened URL (tracking params and `www.` dropped), which is the same cut.
 * 2. **Fallback**: otherwise, exactly one live tab on that URL in the anchored
 *    window and privacy context, not already claimed by an exact match — the
 *    Chrome-discard shape, where the tab stayed put and its id changed.
 * 3. **Ambiguous**: more than one such tab, a candidate claimed by another
 *    item, candidates only outside the anchored window, or candidates with no
 *    anchor to confine them. The item is refused and nothing is done to it.
 * 4. **Gone**: no live tab on that URL at all (closed, navigated away, or — on
 *    Zen — in another workspace, which `tabs.query` does not return).
 */
export function resolveDigestItems(
  items: ReadonlyArray<Pick<DigestItemRecord, "url" | "tabIdHint" | "anchor">>,
  live: readonly LiveTab[],
  opts: NormalizeOpts,
): DigestResolution[] {
  const byId = new Map(live.map((tab) => [tab.id, tab] as const));
  const byKey = new Map<string, LiveTab[]>();
  for (const tab of live) {
    const key = urlKey(tab.url, opts);
    if (key === null) continue;
    const list = byKey.get(key);
    if (list) list.push(tab);
    else byKey.set(key, [tab]);
  }

  const keys = items.map((item) => urlKey(item.url, opts));
  const out: Array<DigestResolution | null> = items.map((item, i) => {
    const tab = byId.get(item.tabIdHint);
    const key = keys[i];
    return tab && key !== null && urlKey(tab.url, opts) === key ? { kind: "exact", tab } : null;
  });
  const claimed = new Set<number>();
  for (const r of out) if (r && r.kind === "exact") claimed.add(r.tab.id);

  return items.map((item, i) => {
    const exact = out[i];
    if (exact) return exact;
    const key = keys[i];
    const candidates = key === null ? [] : (byKey.get(key) ?? []);
    if (candidates.length === 0) return { kind: "gone" };
    const anchor = item.anchor;
    if (!anchor) return { kind: "ambiguous" };
    const local = candidates.filter(
      (tab) => tab.windowId === anchor.windowId && tab.incognito === anchor.incognito,
    );
    const only = local.length === 1 ? local[0] : undefined;
    if (!only || claimed.has(only.id)) return { kind: "ambiguous" };
    claimed.add(only.id);
    return { kind: "fallback", tab: only };
  });
}

/**
 * The browser's side of a report, taken as it arrives: which named tabs were
 * really open on their pages, where, and when the user last looked at them.
 * Exact matches only — the agent named a tab, and this records whether that
 * tab was what it said. `unmatched` goes back to the agent as information,
 * never as a refusal.
 */
export function observeReport(
  items: DigestReportParams["items"],
  live: readonly LiveTab[],
  opts: NormalizeOpts,
): {
  items: DigestItemRecord[];
  unmatched: number[];
  firstAccessed?: number;
  lastAccessed?: number;
} {
  const byId = new Map(live.map((tab) => [tab.id, tab] as const));
  const unmatched: number[] = [];
  let first: number | undefined;
  let last: number | undefined;
  const records = items.map((item, index): DigestItemRecord => {
    const { tabId, ...claims } = item;
    const tab = byId.get(tabId);
    const key = urlKey(item.url, opts);
    const open = tab !== undefined && key !== null && urlKey(tab.url, opts) === key;
    if (!open || !tab) {
      unmatched.push(index);
      return { ...claims, tabIdHint: tabId, observed: { open: false } };
    }
    const seen = tab.lastAccessed;
    if (seen !== undefined && seen > 0) {
      first = first === undefined ? seen : Math.min(first, seen);
      last = last === undefined ? seen : Math.max(last, seen);
    }
    return {
      ...claims,
      tabIdHint: tabId,
      anchor: { windowId: tab.windowId, incognito: tab.incognito },
      observed: {
        open: true,
        ...(seen !== undefined && seen > 0 ? { lastAccessed: seen } : {}),
        ...(tab.discarded ? { discarded: true } : {}),
        ...(tab.pinned ? { pinned: true } : {}),
      },
    };
  });
  return {
    items: records,
    unmatched,
    ...(first !== undefined ? { firstAccessed: first } : {}),
    ...(last !== undefined ? { lastAccessed: last } : {}),
  };
}

// --- actions ----------------------------------------------------------------

export interface DigestTarget {
  index: number;
  tabId: number;
  windowId: number;
  /** The committed URL at planning time, re-checked right before acting. */
  url: string;
}

export interface DigestPlan {
  targets: DigestTarget[];
  skipped: Array<{ index: number; outcome: DigestItemOutcome }>;
}

/**
 * Why a resolved tab is left alone by this action, or null when it may be
 * acted on. Pinned tabs never (grouping silently unpins them, #33, and the
 * skill never makes them candidates); active tabs are not closed out from under
 * the user; Firefox-hidden tabs are not grouped, which is unmeasured.
 */
export function exclusionFor(tab: LiveTab, action: DigestAction): DigestItemOutcome | null {
  if (tab.pinned) return "pinned";
  if (action === "close" && tab.active) return "active";
  if (action === "keep" && tab.hidden) return "hidden";
  return null;
}

/** Plan one section's action against a fresh listing. The plan is what the button reported. */
export function planDigestAction(
  record: Pick<DigestRecord, "items">,
  action: DigestAction,
  live: readonly LiveTab[],
  opts: NormalizeOpts,
): DigestPlan {
  const fate = actionFate(action);
  const resolutions = resolveDigestItems(record.items, live, opts);
  const plan: DigestPlan = { targets: [], skipped: [] };
  record.items.forEach((item, index) => {
    if (effectiveFate(item) !== fate) return;
    const r = resolutions[index];
    if (!r || r.kind === "gone" || r.kind === "ambiguous") {
      plan.skipped.push({ index, outcome: r?.kind ?? "gone" });
      return;
    }
    const excluded = exclusionFor(r.tab, action);
    if (excluded) {
      plan.skipped.push({ index, outcome: excluded });
      return;
    }
    plan.targets.push({ index, tabId: r.tab.id, windowId: r.tab.windowId, url: r.tab.url });
  });
  return plan;
}

/**
 * The last look before acting. The tab must still be on the page it was
 * planned on and still clear of every exclusion; anything else is `changed`
 * (or the exclusion it now hits), and it is left alone.
 */
export function recheckTarget(
  target: DigestTarget,
  fresh: LiveTab | null,
  action: DigestAction,
  opts: NormalizeOpts,
): DigestItemOutcome | null {
  if (!fresh) return "gone";
  const planned = urlKey(target.url, opts);
  if (planned === null || urlKey(fresh.url, opts) !== planned) return "changed";
  return exclusionFor(fresh, action);
}

// --- close / undo state -------------------------------------------------------

/**
 * The undo batch a close wrote, found in the undo log. By id when the digest
 * recorded one; otherwise — the write after the close was lost — by shape: the
 * earliest batch written after the close started whose every entry is one of
 * this digest's pages. The undo log is the only authority on what is still
 * restorable.
 */
export function findCloseBatch(
  record: Pick<DigestRecord, "items">,
  close: DigestActionRecord,
  log: readonly UndoBatch[],
  opts: NormalizeOpts,
): UndoBatch | null {
  if (close.batchId !== undefined) return log.find((b) => b.id === close.batchId) ?? null;
  const pages = new Set(
    record.items.map((item) => urlKey(item.url, opts)).filter((k) => k !== null),
  );
  const matches = log.filter(
    (b) =>
      b.closedAt >= close.startedAt &&
      b.entries.length > 0 &&
      b.entries.every((e) => pages.has(urlKey(e.url, opts) ?? "")),
  );
  return matches.reduce<UndoBatch | null>(
    (best, b) => (best === null || b.closedAt < best.closedAt ? b : best),
    null,
  );
}

export interface DigestUndoState {
  batchId: string;
  /** Entries of the batch the undo log still holds, so Undo can still reopen. */
  restorable: number;
  closedAt: number;
}

/** The newest close batch that still has anything to reopen, or null. */
export function digestUndoState(
  record: Pick<DigestRecord, "items" | "closes">,
  log: readonly UndoBatch[],
  opts: NormalizeOpts,
): DigestUndoState | null {
  for (const close of record.closes) {
    const batch = findCloseBatch(record, close, log, opts);
    if (batch && batch.entries.length > 0) {
      return { batchId: batch.id, restorable: batch.entries.length, closedAt: batch.closedAt };
    }
  }
  return null;
}

/** Record an action, keeping the close history short. */
export function withAction(
  record: DigestRecord,
  action: DigestAction,
  entry: DigestActionRecord,
): DigestRecord {
  if (action === "keep") return { ...record, keep: entry };
  const rest = record.closes.filter((c) => c.startedAt !== entry.startedAt);
  return { ...record, closes: [entry, ...rest].slice(0, CLOSE_HISTORY) };
}

// --- ids, retention, parsing ---------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const obj = asRecord(value);
  if (!obj) return value;
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, canonical(obj[k])]),
  );
}

/**
 * A content hash of the report, less the reporter. A report re-sent after a
 * timeout is the same digest, so it is stored once and mirrored once.
 */
export async function digestId(params: DigestReportParams): Promise<string> {
  const { reporter: _reporter, ...content } = params;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(content)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Newest first, capped. */
export function retainDigests(
  list: readonly DigestRecord[],
  max: number = DIGEST_RETENTION,
): DigestRecord[] {
  return [...list].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, Math.max(0, max));
}

export function noteSourceFor(record: DigestRecord): DigestNoteSource {
  return {
    id: record.id,
    receivedAt: record.receivedAt,
    reporter: record.reporter,
    sitting: record.sitting,
    items: record.items.map(
      ({ tabIdHint: _t, anchor: _a, observed: _o, userFate: _u, ...claims }) => claims,
    ),
  };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown): boolean => v === undefined || isStr(v);
const optNum = (v: unknown): boolean => v === undefined || isNum(v);
const isFate = (v: unknown): v is DigestFate =>
  isStr(v) && (DIGEST_FATES as readonly string[]).includes(v);
const OUTCOMES: ReadonlySet<string> = new Set([
  "grouped",
  "closed",
  "pinned",
  "active",
  "hidden",
  "gone",
  "ambiguous",
  "changed",
  "failed",
]);

function isItem(value: unknown): value is DigestItemRecord {
  const o = asRecord(value);
  if (!o) return false;
  const observed = asRecord(o.observed);
  const anchor = o.anchor === undefined ? null : asRecord(o.anchor);
  return (
    isStr(o.url) &&
    isStr(o.title) &&
    isFate(o.fate) &&
    isStr(o.reason) &&
    optStr(o.quote) &&
    optStr(o.interest) &&
    optStr(o.link) &&
    (o.unreadable === undefined ||
      (isStr(o.unreadable) && (DIGEST_UNREADABLE as readonly string[]).includes(o.unreadable))) &&
    isNum(o.tabIdHint) &&
    (o.userFate === undefined || isFate(o.userFate)) &&
    observed !== null &&
    typeof observed.open === "boolean" &&
    optNum(observed.lastAccessed) &&
    (o.anchor === undefined ||
      (anchor !== null && isNum(anchor.windowId) && typeof anchor.incognito === "boolean"))
  );
}

function isAction(value: unknown): value is DigestActionRecord {
  const o = asRecord(value);
  return (
    o !== null &&
    isNum(o.startedAt) &&
    optNum(o.at) &&
    optStr(o.batchId) &&
    Array.isArray(o.outcomes) &&
    o.outcomes.every((x) => {
      const r = asRecord(x);
      return r !== null && isNum(r.index) && isStr(r.outcome) && OUTCOMES.has(r.outcome);
    })
  );
}

function isMirror(value: unknown): value is DigestMirrorState {
  const o = asRecord(value);
  if (!o) return false;
  switch (o.state) {
    case "pending":
      return true;
    case "written":
      return isStr(o.file) && isNum(o.at);
    case "failed":
      return isStr(o.reason) && isNum(o.at);
    case "off":
      return isNum(o.at);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is DigestRecord {
  const o = asRecord(value);
  if (!o) return false;
  const sitting = asRecord(o.sitting);
  const reporter = asRecord(o.reporter);
  return (
    isStr(o.id) &&
    isNum(o.receivedAt) &&
    reporter !== null &&
    optStr(reporter.client) &&
    optStr(reporter.clientVersion) &&
    optStr(reporter.gullet) &&
    sitting !== null &&
    optStr(sitting.label) &&
    Array.isArray(sitting.sources) &&
    sitting.sources.every(isStr) &&
    optNum(sitting.firstAccessed) &&
    optNum(sitting.lastAccessed) &&
    Array.isArray(o.items) &&
    o.items.length > 0 &&
    o.items.every(isItem) &&
    optNum(o.openedAt) &&
    (o.keep === undefined || isAction(o.keep)) &&
    Array.isArray(o.closes) &&
    o.closes.every(isAction) &&
    isMirror(o.mirror)
  );
}

/**
 * Storage is user-editable and survives upgrades, so every field is checked.
 * A record that fails is dropped whole rather than half-trusted. An unknown
 * version yields nothing, and says which version it was — never what was in it.
 */
export function parseDigestStore(raw: unknown): {
  digests: DigestRecord[];
  unknownVersion?: unknown;
} {
  if (raw === undefined) return { digests: [] };
  const obj = asRecord(raw);
  if (!obj || obj.v !== DIGEST_STORE_VERSION) {
    return { digests: [], unknownVersion: obj ? obj.v : typeof raw };
  }
  const list = Array.isArray(obj.digests) ? obj.digests.filter(isRecord) : [];
  return { digests: retainDigests(list) };
}

// --- views ------------------------------------------------------------------------

/** One row as the panel renders it. Every string here is agent text: textContent only. */
export interface DigestItemView {
  index: number;
  title: string;
  url: string;
  host: string;
  fate: DigestFate;
  effectiveFate: DigestFate;
  reason: string;
  quote?: string;
  interest?: string;
  link?: string;
  unreadable?: DigestItemRecord["unreadable"];
  /** Where the item's tab is now: found (exactly or by a unique URL), gone, or refused. */
  live: "open" | "gone" | "ambiguous";
  /** Set only when open. */
  tabId?: number;
  pinned: boolean;
  active: boolean;
  hidden: boolean;
  discarded: boolean;
  favIconUrl?: string;
  /** The named tab was not open on this page when the report arrived. */
  unmatchedAtReport: boolean;
  /** What the latest action for this item's section did to it. */
  outcome?: DigestItemOutcome;
}

export interface DigestSummary {
  id: string;
  receivedAt: number;
  label: string;
  items: number;
  worthIt: number;
  openedAt?: number;
}

export interface DigestView {
  id: string;
  receivedAt: number;
  reporter: DigestReporter;
  sitting: DigestRecord["sitting"];
  mirror: DigestMirrorState;
  items: DigestItemView[];
  keep?: DigestActionRecord;
  lastClose?: DigestActionRecord;
  undo: DigestUndoState | null;
}

/** What the digest is called: its feeds, else the agent's label, else "tabs". */
export function digestLabel(record: Pick<DigestRecord, "sitting">): string {
  if (record.sitting.sources.length > 0) return record.sitting.sources.join(" · ");
  return record.sitting.label || "tabs";
}

export function summarizeDigest(record: DigestRecord): DigestSummary {
  return {
    id: record.id,
    receivedAt: record.receivedAt,
    label: digestLabel(record),
    items: record.items.length,
    worthIt: record.items.filter((i) => effectiveFate(i) === "worth-it").length,
    ...(record.openedAt !== undefined ? { openedAt: record.openedAt } : {}),
  };
}

/** The popup's line: the newest digest, unopened and under a week old. */
export function freshDigest(list: readonly DigestSummary[], now: number): DigestSummary | null {
  const newest = list[0];
  if (!newest || newest.openedAt !== undefined) return null;
  return now - newest.receivedAt < DIGEST_FRESH_MS ? newest : null;
}

export function buildDigestView(
  record: DigestRecord,
  live: readonly LiveTab[],
  log: readonly UndoBatch[],
  opts: NormalizeOpts,
): DigestView {
  const resolutions = resolveDigestItems(record.items, live, opts);
  const lastClose = record.closes[0];
  const outcomeFor = (index: number, fate: DigestFate): DigestItemOutcome | undefined => {
    const action = fate === "worth-it" ? record.keep : fate === "close" ? lastClose : undefined;
    return action?.outcomes.find((o) => o.index === index)?.outcome;
  };
  const items = record.items.map((item, index): DigestItemView => {
    const r = resolutions[index] ?? { kind: "gone" };
    const tab = r.kind === "exact" || r.kind === "fallback" ? r.tab : null;
    const fate = effectiveFate(item);
    const outcome = outcomeFor(index, fate);
    return {
      index,
      title: item.title,
      url: item.url,
      host: tabDomain(item.url),
      fate: item.fate,
      effectiveFate: fate,
      reason: item.reason,
      ...(item.quote ? { quote: item.quote } : {}),
      ...(item.interest ? { interest: item.interest } : {}),
      ...(item.link ? { link: item.link } : {}),
      ...(item.unreadable ? { unreadable: item.unreadable } : {}),
      live: tab ? "open" : r.kind === "ambiguous" ? "ambiguous" : "gone",
      ...(tab ? { tabId: tab.id } : {}),
      pinned: tab?.pinned ?? false,
      active: tab?.active ?? false,
      hidden: tab?.hidden ?? false,
      discarded: tab?.discarded ?? false,
      ...(tab?.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
      unmatchedAtReport: !item.observed.open,
      ...(outcome ? { outcome } : {}),
    };
  });
  return {
    id: record.id,
    receivedAt: record.receivedAt,
    reporter: record.reporter,
    sitting: record.sitting,
    mirror: record.mirror,
    items,
    ...(record.keep ? { keep: record.keep } : {}),
    ...(lastClose ? { lastClose } : {}),
    undo: digestUndoState(record, log, opts),
  };
}

// --- message access -------------------------------------------------------------

/**
 * Whether a runtime message came from exactly this extension page. Origin and
 * pathname are compared whole, never by prefix: `notice/dup-notice.html` is
 * web-accessible and so a message sender that any site can embed, and a
 * prefix check is one path segment away from admitting it.
 *
 * Scheme and host rather than `origin`: WHATWG gives a non-special scheme the
 * opaque origin `"null"`, so two different `moz-extension://` hosts would
 * compare equal by origin in any runtime that follows the spec literally.
 */
export function isSenderPage(senderUrl: string | undefined, pageUrl: string): boolean {
  if (!senderUrl) return false;
  try {
    const sender = new URL(senderUrl);
    const page = new URL(pageUrl);
    return (
      page.host !== "" &&
      sender.protocol === page.protocol &&
      sender.host === page.host &&
      sender.pathname === page.pathname
    );
  } catch {
    return false;
  }
}
