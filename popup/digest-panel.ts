// The full view's Digest panel: an agent's verdicts on a sitting, laid out as
// a desk — a list tiered by section beside a preview pane for the focused row
// (below ~880px the pane becomes an expansion under that row), with a hover
// preview card on the compact rows.
//
// Two voices, kept visibly apart. Upright text and images are what the page
// said about itself, recorded by the extension when it read the tab
// (`src/page-facts.ts`); italic text behind a dashed rule, labelled "Agent", is
// the agent's claim. Both are untrusted: every string renders through
// `textContent` and `createElement` only — no `innerHTML`, no
// `insertAdjacentHTML`, no template strings of markup
// (`tests/digest-sinks.test.ts` holds this file to that) — and nothing an agent
// wrote ever becomes an `href`. Images are the extension's own `data:`
// thumbnails, set as a background so no page URL is ever loaded here. A row's
// host is parsed from its URL by the extension, so a title cannot pass itself
// off as a different site.
//
// Nothing here acts on a tab by itself. The section buttons send the
// background a request; the background re-resolves every row against the
// browser at that moment and reports what it did per row.

import type { DigestFate } from "../src/bridge-protocol.js";
import type { DigestActResponse, GetDigestsResponse } from "../src/digest-actions.js";
import type {
  DigestAction,
  DigestActionRecord,
  DigestItemOutcome,
  DigestItemView,
  DigestSummary,
  DigestView,
} from "../src/digest.js";
import { quoteRepeatsDescription, shortPublished } from "../src/page-facts.js";
import { hostInitial, sendMessage } from "./lib.js";

export interface DigestPanelHost {
  /** Show a result, with Undo when `undo` is given. */
  toast: (text: string, undo?: () => void) => void;
  /** The list of stored digests changed (the view switch shows or hides on it). */
  onList: (list: DigestSummary[]) => void;
}

interface SectionSpec {
  fate: DigestFate;
  title: string;
  note: string;
  action?: DigestAction;
}

const SECTIONS: SectionSpec[] = [
  { fate: "worth-it", title: "Worth your time", note: "kept open", action: "top" },
  {
    fate: "file",
    title: "File for reference",
    note: "kept open · file these from Tabs with Devour",
  },
  {
    fate: "close",
    title: "Close",
    note: "one batch, undoable · untick to leave open",
    action: "close",
  },
  { fate: "could-not-read", title: "Could not read / leave open", note: "left open" },
];

/** The keys 1-4 and the section control, in that order. */
const FATES: Array<{ fate: DigestFate; label: string; key: string }> = [
  { fate: "worth-it", label: "Worth it", key: "1" },
  { fate: "file", label: "File", key: "2" },
  { fate: "close", label: "Close", key: "3" },
  { fate: "could-not-read", label: "Leave", key: "4" },
];

const UNREADABLE: Record<NonNullable<DigestItemView["unreadable"]>, string> = {
  thin: "too thin to read",
  "login-wall": "login wall",
  "bot-check": "bot check",
  "no-transcript": "no transcript",
  "pdf-viewer": "PDF viewer",
  discarded: "unloaded",
  other: "could not read",
};

/** What a row's last action outcome says, as a mark. */
const OUTCOME_LABEL: Record<DigestItemOutcome, string> = {
  moved: "moved to top",
  closed: "closed",
  pinned: "pinned — left alone",
  active: "active tab — left alone",
  hidden: "hidden — left alone",
  "in-group": "in a tab group — left alone",
  gone: "not open",
  ambiguous: "ambiguous — left alone",
  changed: "changed — left alone",
  failed: "could not be changed",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, title?: string): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayAndClock(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock(ms)}`;
}

/** host + path of an outbound link, in mono — shown, never linked. */
function shortLink(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname === "/" ? "" : u.pathname;
    const text = `${host}${path}`;
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  } catch {
    return "";
  }
}

/** A CSS `url()` for an image the extension recorded or the browser reported. */
function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`;
}

/**
 * The line a section head carries after an action: what happened, counted by
 * outcome, in the order a reader cares about.
 */
export function actionSummary(action: DigestAction, record: DigestActionRecord): string {
  const counts = new Map<DigestItemOutcome, number>();
  for (const { outcome } of record.outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const parts: string[] = [];
  const done = counts.get(action === "top" ? "moved" : "closed") ?? 0;
  parts.push(action === "top" ? `Moved ${done} to the top` : `Closed ${done}`);
  const pinned = counts.get("pinned") ?? 0;
  if (pinned) parts.push(`${pinned} pinned, left in place`);
  const active = counts.get("active") ?? 0;
  if (active) parts.push(`${active} active, left open`);
  const hidden = counts.get("hidden") ?? 0;
  if (hidden) parts.push(`${hidden} hidden, left out`);
  const inGroup = counts.get("in-group") ?? 0;
  if (inGroup) parts.push(`${inGroup} in a tab group, left in it`);
  const gone = counts.get("gone") ?? 0;
  if (gone) parts.push(`${gone} no longer open`);
  const unsure = (counts.get("ambiguous") ?? 0) + (counts.get("changed") ?? 0);
  if (unsure) parts.push(`${unsure} changed or ambiguous, left alone`);
  const failed = counts.get("failed") ?? 0;
  if (failed) parts.push(`${failed} could not be ${action === "top" ? "moved" : "closed"}`);
  return parts.join(" · ");
}

/**
 * Rows the section's button would act on right now, by the view's live state —
 * the same exclusions `planDigestAction` applies, so the count on the button is
 * the count the background will attempt.
 */
function actionable(items: DigestItemView[], action: DigestAction): DigestItemView[] {
  return items.filter(
    (i) =>
      i.live === "open" &&
      !i.pinned &&
      !(action === "close" && i.active) &&
      !(action === "top" && (i.hidden || i.grouped)),
  );
}

/** A close row the user unticked: it sits in could-not-read, and ticking it returns it. */
function isUnticked(row: DigestItemView): boolean {
  return row.fate === "close" && row.effectiveFate === "could-not-read";
}

/** A closed row with no tab open on its page: folded after Close. */
function isClosed(row: DigestItemView): boolean {
  return row.outcome === "closed" && row.live === "gone";
}

/** The row's state, as one short mark: what happened, else why it was left alone. */
function stateFor(
  row: DigestItemView,
): { text: string; tone: "" | "is-done" | "is-refused" } | null {
  if (row.outcome === "moved" && row.live === "open")
    return { text: "moved to top", tone: "is-done" };
  if (isClosed(row)) return { text: "closed", tone: "is-done" };
  const refused =
    row.outcome !== undefined &&
    row.outcome !== "moved" &&
    row.outcome !== "closed" &&
    row.outcome !== "gone";
  if (refused && row.outcome) return { text: OUTCOME_LABEL[row.outcome], tone: "is-refused" };
  if (row.live === "gone") return { text: "not open in this workspace", tone: "" };
  if (row.live === "ambiguous") return { text: "ambiguous — left alone", tone: "is-refused" };
  if (row.pinned) return { text: "pinned — left alone", tone: "" };
  if (isUnticked(row)) return { text: "unticked", tone: "" };
  if (row.fate !== row.effectiveFate) return { text: "you moved it", tone: "" };
  if (row.effectiveFate === "could-not-read" && row.unreadable) {
    return { text: UNREADABLE[row.unreadable], tone: "" };
  }
  return null;
}

function renderState(row: DigestItemView): HTMLElement {
  const state = stateFor(row);
  const span = el("span", `digest-state ${state?.tone ?? ""}`.trim(), state?.text ?? "");
  if (row.unmatchedAtReport && row.live !== "open") {
    span.title = "The tab had changed by the time the agent reported it.";
  }
  return span;
}

function renderFavicon(row: DigestItemView, size: "sm" | "md" | "lg" = "sm"): HTMLElement {
  const fav = el("span", `favicon dk-fav is-${size}`);
  fav.setAttribute("aria-hidden", "true");
  if (row.favIconUrl) {
    fav.style.backgroundImage = cssUrl(row.favIconUrl);
  } else {
    fav.classList.add("fallback");
    fav.textContent = hostInitial(row.page?.site ?? row.host);
  }
  return fav;
}

/**
 * The page image, or the favicon tile standing in for it. `tagged` adds the
 * corner label that says which one it is.
 */
function renderArt(row: DigestItemView, tagged = false): HTMLElement {
  const art = el("div", "dk-art");
  const image = row.page?.image;
  if (image) {
    art.classList.add("has-image");
    art.style.backgroundImage = cssUrl(image);
    art.setAttribute("role", "img");
    art.setAttribute("aria-label", "Page image");
  } else {
    art.classList.add("is-fallback");
    art.setAttribute("aria-hidden", "true");
    const inner = el("div", "dk-art-fallback");
    inner.append(renderFavicon(row, "lg"), el("span", "dk-art-name", row.page?.site ?? row.host));
    art.append(inner);
  }
  if (tagged) art.append(el("span", "dk-art-tag", image ? "Page image" : "No page image"));
  return art;
}

/** The page's own site line: favicon, site, author, date, and the cheap extras. */
function renderSiteLine(row: DigestItemView, withFavicon = true): HTMLElement {
  const line = el("div", "dk-site");
  if (withFavicon) line.append(renderFavicon(row));
  const page = row.page;
  const parts: Array<[string, string]> = [["dk-site-name", page?.site ?? row.host]];
  if (page?.author && page.author !== page.site) parts.push(["", page.author]);
  const published = shortPublished(page?.published, Date.now());
  if (published) parts.push(["dk-num", published]);
  if (page?.extras?.duration) parts.push(["dk-num", page.extras.duration]);
  if (page?.extras?.comments !== undefined) {
    parts.push(["dk-num", plural(page.extras.comments, "comment")]);
  }
  parts.forEach(([cls, text], i) => {
    if (i > 0) line.append(el("span", "dk-sep", "·"));
    line.append(el("span", cls || undefined, text));
  });
  return line;
}

/** The agent's voice: labelled, italic, behind a dashed rule. */
function renderAgent(row: DigestItemView, clamp?: "clamp2"): HTMLElement {
  const box = el("div", "dk-agent");
  box.append(el("span", "dk-agent-label", "Agent"));
  const reason = el("p", clamp ? `dk-agent-reason ${clamp}` : "dk-agent-reason", row.reason);
  box.append(reason);
  if (clamp) return box;
  if (row.quote && !quoteRepeatsDescription(row.quote, row.page?.description)) {
    box.append(el("p", "dk-agent-quote", `“${row.quote}”`));
  }
  const tags: string[] = [];
  if (row.unreadable) tags.push(UNREADABLE[row.unreadable]);
  if (row.interest) tags.push(row.interest);
  if (tags.length > 0 || row.link) {
    const meta = el("div", "dk-agent-meta");
    for (const t of tags) meta.append(el("span", "dk-tag", t));
    if (row.link) {
      const link = el("span", "dk-tag");
      link.append("links to ", el("span", "mono", shortLink(row.link)));
      meta.append(link);
    }
    box.append(meta);
  }
  return box;
}

function renderDestination(view: DigestView): HTMLElement | null {
  if (!view.fileTo) return null;
  const chip = el("span", "dk-dest", view.fileTo.kind === "file" ? "Markdown file" : "Obsidian");
  chip.title = view.fileTo.zotero
    ? "Where Devour files it; papers the Zotero Connector recognises go to Zotero"
    : "Where Devour files it, by your setting";
  return chip;
}

export class DigestPanel {
  private readonly root: HTMLElement;
  private readonly host: DigestPanelHost;
  private list: DigestSummary[] = [];
  private view: DigestView | null = null;
  private selectedId: string | null = null;
  private focusedIndex: number | null = null;
  private showClosed = false;
  private busy = false;
  private active = false;
  private pane: HTMLElement | null = null;
  private tabsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement, host: DigestPanelHost) {
    this.root = root;
    this.host = host;
    this.watchTabs();
  }

  /**
   * Every row's state is read from the browser, so the panel follows the tabs:
   * a restored tab commits its URL after Undo has answered (Gecko reports
   * `about:blank` until then), and a tab closed elsewhere should read "not
   * open" without a reload. Debounced, and only while the panel shows.
   */
  /**
   * A refresh for changes the panel did not cause (tabs moving, a page read
   * recording its facts): debounced, and never while an action runs or under a
   * pressed pointer (#94). The list is only fetched while the panel shows.
   */
  refreshSoon(): void {
    if (this.tabsTimer !== null) clearTimeout(this.tabsTimer);
    this.tabsTimer = setTimeout(() => {
      this.tabsTimer = null;
      if (this.root.matches(":active") || this.busy) this.refreshSoon();
      else void this.refresh();
    }, 400);
  }

  private watchTabs(): void {
    const soon = (): void => {
      if (this.active) this.refreshSoon();
    };
    browser.tabs.onCreated.addListener(soon);
    browser.tabs.onRemoved.addListener(soon);
    browser.tabs.onAttached.addListener(soon);
    browser.tabs.onDetached.addListener(soon);
    browser.tabs.onUpdated.addListener((_id, change) => {
      if (
        change.url !== undefined ||
        change.status === "complete" ||
        change.pinned !== undefined ||
        change.discarded !== undefined
      ) {
        soon();
      }
    });
  }

  get hasDigests(): boolean {
    return this.list.length > 0;
  }

  /** The newest digest nobody has opened yet, for the view switch's badge. */
  get unseen(): number {
    return this.list.filter((d) => d.openedAt === undefined).length;
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) void this.refresh();
  }

  /** Fetch the list, and the selected digest's live view when the panel shows. */
  async refresh(): Promise<void> {
    const res = await sendMessage<GetDigestsResponse>({
      type: "get-digests",
      view: this.active,
      ...(this.selectedId ? { digestId: this.selectedId } : {}),
    });
    if (!res) return;
    this.list = res.list;
    this.host.onList(this.list);
    if (!this.active) return;
    this.view = res.view ?? null;
    if (this.view) {
      this.selectedId = this.view.id;
      if (this.view.openedAt === undefined && !document.hidden) {
        // First render: the popup's "Digest ready" line has done its job.
        void sendMessage({ type: "digest-seen", digestId: this.view.id }).then(() => {
          const summary = this.list.find((d) => d.id === this.view?.id);
          if (summary) summary.openedAt = Date.now();
          this.host.onList(this.list);
        });
      }
    }
    this.render();
  }

  private render(): void {
    const view = this.view;
    if (!view) {
      this.pane = null;
      this.root.replaceChildren(this.renderEmpty());
      return;
    }
    const order = this.orderedIndices();
    if (this.focusedIndex === null || !order.includes(this.focusedIndex)) {
      this.focusedIndex = order[0] ?? null;
    }
    const doc = el("article", "digest-doc");
    doc.append(this.renderHead(view));
    const desk = el("div", "desk");
    const list = el("div", "desk-list");
    for (const spec of SECTIONS) {
      const section = this.renderSection(view, spec);
      if (section) list.append(section);
    }
    const pane = el("aside", "desk-pane");
    pane.setAttribute("aria-label", "Preview");
    this.pane = pane;
    desk.append(list, pane);
    doc.append(desk);
    this.root.replaceChildren(doc);
    this.renderFocus();
  }

  private renderEmpty(): HTMLElement {
    const box = el("div", "empty digest-empty");
    box.append(
      el("p", undefined, "No digests yet."),
      el("p", "muted", "Run /digest in your agent session; its verdicts land here."),
    );
    return box;
  }

  private renderHead(view: DigestView): HTMLElement {
    const head = el("header", "digest-head");
    const bar = el("div", "digest-titlebar");
    const sources = view.sitting.sources;
    const title = el(
      "h2",
      "digest-title",
      sources.length > 0 ? sources.join(" · ") : view.sitting.label || "Digest",
    );
    const meta: string[] = [plural(view.items.length, "tab")];
    const { firstAccessed, lastAccessed } = view.sitting;
    if (firstAccessed !== undefined && lastAccessed !== undefined) {
      const [from, to] = [clock(firstAccessed), clock(lastAccessed)];
      meta.push(from === to ? from : `${from}–${to}`);
    }
    if (sources.length > 0 && view.sitting.label) meta.unshift(view.sitting.label);
    bar.append(title, el("span", "digest-meta", meta.join(" · ")));

    if (this.list.length > 1) {
      const label = el("label", "digest-earlier");
      label.append(el("span", undefined, "Earlier"));
      const select = el("select");
      select.setAttribute("aria-label", "Show an earlier digest");
      for (const d of this.list) {
        const option = el(
          "option",
          undefined,
          `${dayAndClock(d.receivedAt)} · ${d.label} (${d.items})`,
        );
        option.value = d.id;
        option.selected = d.id === view.id;
        select.append(option);
      }
      select.addEventListener("change", () => {
        this.selectedId = select.value;
        this.focusedIndex = null;
        this.showClosed = false;
        void this.refresh();
      });
      label.append(select);
      bar.append(label);
    }
    head.append(bar);

    const provenance = el("p", "digest-provenance");
    const client = [view.reporter.client, view.reporter.clientVersion].filter(Boolean).join(" ");
    if (client) {
      provenance.append("Reported by ", el("strong", undefined, client), " (self-reported)");
    } else {
      provenance.append("Written by an agent");
    }
    if (view.reporter.gullet) provenance.append(` via Gullet ${view.reporter.gullet}`);
    provenance.append(
      ` · ${dayAndClock(view.receivedAt)} · `,
      el(
        "span",
        "digest-caution",
        "An agent’s reading of web pages. Check a verdict before trusting it.",
      ),
    );
    head.append(provenance);

    const mirror = el("p", "digest-mirror");
    switch (view.mirror.state) {
      case "written":
        mirror.append("Note: ", el("span", "mono", view.mirror.file), " — written by Gullet");
        break;
      case "failed":
        mirror.classList.add("is-failed");
        mirror.append("Note not written: ", view.mirror.reason);
        break;
      case "off":
        mirror.append("Note: off in Gullet’s config");
        break;
      case "pending":
        mirror.append("Note: waiting on Gullet");
        break;
    }
    head.append(mirror);
    head.append(this.renderStrip(view));
    return head;
  }

  /** One bar per fate, proportional, with a legend that jumps to its section. */
  private renderStrip(view: DigestView): HTMLElement {
    const wrap = el("div", "digest-strip-wrap");
    const strip = el("div", "digest-strip");
    strip.setAttribute("aria-hidden", "true");
    const legend = el("div", "digest-strip-legend");
    for (const spec of SECTIONS) {
      const n = view.items.filter((i) => i.effectiveFate === spec.fate).length;
      if (n === 0) continue;
      const seg = el("span", `f-${spec.fate}`);
      seg.style.flexGrow = String(n);
      strip.append(seg);
      const jump = button(`f-${spec.fate}`, "", `Go to ${spec.title}`);
      jump.append(el("i"), el("b", undefined, String(n)), ` ${spec.title.toLowerCase()}`);
      jump.addEventListener("click", () => {
        this.root
          .querySelector<HTMLElement>(`.digest-section[data-fate="${spec.fate}"]`)
          ?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      legend.append(jump);
    }
    wrap.append(strip, legend);
    return wrap;
  }

  private renderSection(view: DigestView, spec: SectionSpec): HTMLElement | null {
    const rows = view.items.filter((i) => i.effectiveFate === spec.fate);
    if (rows.length === 0) return null;
    const section = el("section", "digest-section");
    section.dataset.fate = spec.fate;

    const head = el("div", "section-head");
    head.append(
      el("h3", "section-title", spec.title),
      el("span", "count-badge", String(rows.length)),
    );

    const record =
      spec.action === "top"
        ? view.top?.undoneAt === undefined
          ? view.top
          : undefined
        : spec.action === "close"
          ? view.lastClose
          : undefined;
    const note = el(
      "span",
      "section-note",
      spec.action && record ? actionSummary(spec.action, record) : spec.note,
    );
    head.append(note);

    if (spec.action) {
      const targets = actionable(rows, spec.action);
      const acts = el("span", "section-acts");
      if (spec.action === "top" && view.moveUndo !== null) {
        const undo = button("quiet digest-undo", "Undo", "Put these tabs back where they were");
        undo.disabled = this.busy;
        undo.addEventListener("click", () => void this.undoMove());
        acts.append(undo);
      }
      if (spec.action === "close" && view.undo) {
        const undo = button(
          "quiet digest-undo",
          `Undo ${view.undo.restorable}`,
          "Reopen the tabs this close took",
        );
        undo.disabled = this.busy;
        undo.addEventListener("click", () => void this.undo());
        acts.append(undo);
      }
      const act =
        spec.action === "top"
          ? button(
              "primary digest-act",
              "Move to top",
              "Move these tabs to the top of their window, after the pinned tabs. Undo puts them back.",
            )
          : button(
              "danger digest-act",
              "Close",
              "Close these tabs as one batch — Undo brings them back",
            );
      act.append(el("span", "count-badge", String(targets.length)));
      act.disabled = this.busy || targets.length === 0;
      if (targets.length === 0 && rows.every((r) => r.live !== "open")) {
        note.textContent = "none of these are open in this workspace";
      }
      act.addEventListener("click", () => void this.act(spec.action as DigestAction));
      // Once an action has run and left nothing to do, its result line and its
      // Undo say what happened; a disabled "Close 0" only adds noise. A move
      // that can still be undone hides its button for the same reason.
      const spent =
        (spec.action === "close" && record && targets.length === 0) ||
        (spec.action === "top" && view.moveUndo !== null);
      if (!spent) acts.append(act);
      head.append(acts);
    }
    section.append(head);

    const list = el("ul", "digest-rows");
    const folded = spec.fate === "close" && !this.showClosed ? rows.filter(isClosed) : [];
    for (const row of rows) {
      if (folded.includes(row)) continue;
      list.append(this.renderRow(view, row));
    }
    const closedCount = spec.fate === "close" ? rows.filter(isClosed).length : 0;
    if (closedCount > 0) list.append(this.renderFold(view, rows.filter(isClosed)));
    section.append(list);
    return section;
  }

  /** "N closed · in one undo batch · Show them", or the line that folds them again. */
  private renderFold(view: DigestView, closed: DigestItemView[]): HTMLLIElement {
    const li = el("li", "dk-fold");
    if (this.showClosed) {
      li.append(el("span", "dk-fold-text", ""));
    } else {
      const favs = el("span", "dk-fold-favs");
      for (const row of closed.slice(0, 8)) favs.append(renderFavicon(row));
      const text = el("span", "dk-fold-text");
      text.append(el("b", undefined, `${closed.length} closed`));
      if (view.undo) text.append(" · in one undo batch");
      li.append(favs, text);
    }
    const toggle = button("quiet", this.showClosed ? "Fold closed rows" : "Show them");
    toggle.addEventListener("click", () => {
      this.showClosed = !this.showClosed;
      this.render();
    });
    li.append(toggle);
    return li;
  }

  private renderRow(view: DigestView, row: DigestItemView): HTMLLIElement {
    const fate = row.effectiveFate;
    const tier = fate === "worth-it" ? "is-rich" : fate === "file" ? "is-file" : "is-brief";
    const li = el("li", `dk-row ${tier} digest-row`);
    li.dataset.index = String(row.index);
    li.tabIndex = 0;
    if (row.index === this.focusedIndex) li.classList.add("focused");
    if (row.live !== "open") li.classList.add("is-gone");
    if (isClosed(row)) li.classList.add("is-closed");

    const title = el("span", "dk-title", row.page?.title || row.title || row.host);
    title.title = row.title;

    if (fate === "worth-it") {
      const tx = el("div", "dk-tx");
      tx.append(title, renderSiteLine(row), renderAgent(row, "clamp2"));
      li.append(renderArt(row), tx, renderState(row));
    } else if (fate === "file") {
      const tx = el("div", "dk-tx");
      const reason = el("p", "dk-say one", row.reason);
      reason.title = row.reason;
      tx.append(title, reason);
      const rt = el("div", "dk-rt");
      const dest = renderDestination(view);
      if (dest) rt.append(dest);
      rt.append(renderState(row));
      li.append(renderFavicon(row, "md"), tx, rt);
    } else {
      const tick = this.renderTick(row);
      const l1 = el("div", "dk-l1");
      l1.append(title, el("span", "dk-host", row.host));
      li.append(tick, renderFavicon(row), l1, renderState(row));
    }
    if (fate !== "worth-it") li.append(this.renderPeek(row));

    li.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("input, button")) return;
      this.focus(row.index);
    });
    return li;
  }

  /**
   * A close row's checkbox. Unticking moves the row to could-not-read (a user
   * fate, no new state); an unticked row keeps an empty box there, and ticking
   * it returns the row to the agent's Close.
   */
  private renderTick(row: DigestItemView): HTMLElement {
    const inClose = row.effectiveFate === "close";
    if (!inClose && !isUnticked(row)) return el("span", "dk-tick-slot");
    const box = el("input", "dk-tick");
    box.type = "checkbox";
    box.checked = inClose;
    box.disabled = this.busy || row.locked;
    box.setAttribute(
      "aria-label",
      inClose ? "Included in Close — untick to leave it open" : "Left open — tick to close it",
    );
    box.addEventListener("change", () => {
      if (!this.view) return;
      // The row whose box was clicked becomes the focused row, so the keys
      // that follow act on it and not on whichever row was focused before.
      this.focus(row.index);
      void this.setFate(this.view.id, row.index, box.checked ? null : "could-not-read");
    });
    return box;
  }

  /** B's hover card: the page's own image, site line, and description. */
  private renderPeek(row: DigestItemView): HTMLElement {
    const peek = el("div", "dk-peek");
    peek.setAttribute("aria-hidden", "true");
    peek.append(renderArt(row), renderSiteLine(row));
    const description = row.page?.description;
    peek.append(
      el(
        "p",
        description ? "dk-excerpt" : "dk-excerpt is-missing",
        description ?? (row.page ? "The page gave no description." : "Not read by Tabglutton."),
      ),
    );
    return peek;
  }

  /** The focused row, whole: the pane at wide widths and the inline expansion below ~880px. */
  private renderDetail(view: DigestView, row: DigestItemView): HTMLElement {
    const body = el("div", "dk-detail");
    body.append(renderArt(row, true), renderSiteLine(row));
    body.append(el("h3", "dk-detail-title", row.page?.title || row.title || row.host));
    const description = row.page?.description;
    if (description) {
      body.append(el("p", "dk-excerpt", description));
    } else {
      body.append(
        el(
          "p",
          "dk-excerpt is-missing",
          row.page
            ? "The page gave no description of itself."
            : "Tabglutton has no read of this page, so there is nothing from it to show.",
        ),
      );
    }
    body.append(renderAgent(row));
    if (row.effectiveFate === "file") {
      const dest = renderDestination(view);
      if (dest) body.append(dest);
    }
    body.append(el("p", "dk-url mono", row.url));

    const bar = el("div", "dk-bar");
    const show = button(
      "quiet dk-show",
      "Show",
      row.live === "open" ? "Bring this tab forward (↵)" : "Open this page again (↵)",
    );
    show.addEventListener("click", () => void this.show(row.index));
    const seg = el("div", "seg digest-fate");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Move to section");
    for (const f of FATES) {
      const b = button("seg-btn", "", `${f.label} (${f.key})`);
      b.append(f.label, el("kbd", undefined, f.key));
      const on = f.fate === row.effectiveFate;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
      b.disabled = row.locked || this.busy;
      b.addEventListener("click", () => void this.setFate(view.id, row.index, f.fate));
      seg.append(b);
    }
    bar.append(show, seg, renderState(row));
    body.append(bar);
    return body;
  }

  /** Show the focused row in the pane and under its row, without rebuilding the list. */
  private renderFocus(): void {
    const view = this.view;
    if (!view) return;
    const row = this.focusedIndex === null ? undefined : view.items[this.focusedIndex];
    for (const li of this.root.querySelectorAll<HTMLElement>(".dk-row")) {
      li.classList.toggle("focused", Number(li.dataset.index) === this.focusedIndex);
    }
    this.root.querySelector(".dk-expand")?.remove();
    if (!row) {
      this.pane?.replaceChildren();
      return;
    }
    const label = el("span", "desk-pane-label", "Preview");
    this.pane?.replaceChildren(label, this.renderDetail(view, row));
    const at = this.root.querySelector<HTMLElement>(`.dk-row[data-index="${row.index}"]`);
    if (at) {
      const expand = el("li", "dk-expand");
      expand.append(this.renderDetail(view, row));
      at.after(expand);
    }
  }

  private focus(index: number): void {
    this.focusedIndex = index;
    this.renderFocus();
  }

  private async setFate(id: string, index: number, fate: DigestFate | null): Promise<void> {
    const row = this.view?.items[index];
    if (!row || row.locked) return;
    await sendMessage({ type: "digest-set-fate", digestId: id, index, fate });
    await this.refresh();
  }

  private async show(index: number): Promise<void> {
    if (!this.view) return;
    await sendMessage({ type: "digest-show", digestId: this.view.id, index });
  }

  private async act(action: DigestAction): Promise<void> {
    if (!this.view || this.busy) return;
    this.busy = true;
    this.render();
    const id = this.view.id;
    const res = await sendMessage<DigestActResponse>({ type: "digest-act", digestId: id, action });
    this.busy = false;
    await this.refresh();
    if (!res) {
      this.host.toast("Nothing happened — the background page did not answer.");
      return;
    }
    if (!res.ok) {
      this.host.toast(res.error);
      return;
    }
    const summary = actionSummary(action, { startedAt: 0, outcomes: res.outcomes });
    const undo =
      res.done === 0
        ? undefined
        : action === "close"
          ? () => void this.undo()
          : () => void this.undoMove();
    this.host.toast(summary, undo);
  }

  private async undo(): Promise<void> {
    if (!this.view || this.busy) return;
    this.busy = true;
    const res = await sendMessage<{ ok: boolean; restored: number; failed: number }>({
      type: "digest-undo",
      digestId: this.view.id,
    });
    this.busy = false;
    await this.refresh();
    if (res?.ok) {
      this.host.toast(
        res.failed > 0
          ? `Reopened ${res.restored} · ${res.failed} could not be reopened`
          : `Reopened ${res.restored}`,
      );
    }
  }

  private async undoMove(): Promise<void> {
    if (!this.view || this.busy) return;
    this.busy = true;
    const res = await sendMessage<{ ok: boolean; restored: number; skipped: number }>({
      type: "digest-undo-move",
      digestId: this.view.id,
    });
    this.busy = false;
    await this.refresh();
    if (res?.ok) {
      this.host.toast(
        res.skipped > 0
          ? `Put ${res.restored} back · ${res.skipped} had moved or closed, left where they are`
          : `Put ${res.restored} back where they were`,
      );
    }
  }

  /** Rows in reading order, for j/k — folded closed rows are skipped. */
  private orderedIndices(): number[] {
    const view = this.view;
    if (!view) return [];
    return SECTIONS.flatMap((s) =>
      view.items
        .filter((i) => i.effectiveFate === s.fate && (this.showClosed || !isClosed(i)))
        .map((i) => i.index),
    );
  }

  /**
   * Digest-mode keys: j/k move, 1-4 move the focused row to a section, x ticks
   * a close row in or out, Enter shows it. `d` is deliberately not bound, and
   * no key here closes anything. Returns whether the key was handled.
   */
  handleKey(key: string): boolean {
    const order = this.orderedIndices();
    if (order.length === 0) return false;
    if (key === "j" || key === "ArrowDown" || key === "k" || key === "ArrowUp") {
      const step = key === "j" || key === "ArrowDown" ? 1 : -1;
      const at = this.focusedIndex === null ? -1 : order.indexOf(this.focusedIndex);
      const next =
        at === -1 ? (step > 0 ? 0 : order.length - 1) : (at + step + order.length) % order.length;
      const index = order[next];
      if (index === undefined) return false;
      this.focus(index);
      this.root
        .querySelector<HTMLElement>(`.dk-row[data-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return true;
    }
    // A row (or its checkbox) holding DOM focus is the one the key is for.
    const active = document.activeElement?.closest<HTMLElement>(".dk-row");
    if (
      active &&
      this.root.contains(active) &&
      Number(active.dataset.index) !== this.focusedIndex
    ) {
      this.focus(Number(active.dataset.index));
    }
    if (this.focusedIndex === null || !this.view) return false;
    const row = this.view.items[this.focusedIndex];
    const fate = FATES.find((f) => f.key === key)?.fate;
    if (fate) {
      void this.setFate(this.view.id, this.focusedIndex, fate);
      return true;
    }
    if (key === "x" && row && (row.effectiveFate === "close" || isUnticked(row))) {
      void this.setFate(
        this.view.id,
        row.index,
        row.effectiveFate === "close" ? "could-not-read" : null,
      );
      return true;
    }
    if (key === "Enter") {
      void this.show(this.focusedIndex);
      return true;
    }
    return false;
  }
}
