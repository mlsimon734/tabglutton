// The full view's Digest panel: an agent's verdicts on a sitting, laid out for
// the user to act on.
//
// Every string in a digest is web-derived text relayed by a model that read
// untrusted pages. It is rendered with `textContent` and `createElement` only —
// no `innerHTML`, no `insertAdjacentHTML`, no template strings of markup
// (`tests/digest-sinks.test.ts` holds this file to that) — and nothing an agent
// wrote ever becomes an `href`. A row's host is parsed from its URL by the
// extension and printed beside the agent's title, so a title cannot pass
// itself off as a different site.
//
// Nothing here acts on a tab by itself. The two section buttons send the
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
  { fate: "worth-it", title: "Worth your time", note: "kept open", action: "keep" },
  {
    fate: "file",
    title: "File for reference",
    note: "kept open · file these from Tabs with Devour",
  },
  { fate: "close", title: "Close", note: "", action: "close" },
  { fate: "could-not-read", title: "Could not read", note: "left open" },
];

/** The keys 1-4 and the row control, in that order. */
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
  grouped: "grouped",
  closed: "closed",
  pinned: "pinned — left alone",
  active: "active tab — left alone",
  hidden: "hidden — left alone",
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

/**
 * The line a section head carries after an action: what happened, counted by
 * outcome, in the order a reader cares about.
 */
export function actionSummary(action: DigestAction, record: DigestActionRecord): string {
  const counts = new Map<DigestItemOutcome, number>();
  for (const { outcome } of record.outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const parts: string[] = [];
  const done = counts.get(action === "keep" ? "grouped" : "closed") ?? 0;
  parts.push(action === "keep" ? `${done} kept in “Worth your time”` : `Closed ${done}`);
  const pinned = counts.get("pinned") ?? 0;
  if (pinned) parts.push(`${pinned} pinned, left in place`);
  const active = counts.get("active") ?? 0;
  if (active) parts.push(`${active} active, left open`);
  const hidden = counts.get("hidden") ?? 0;
  if (hidden) parts.push(`${hidden} hidden, left out`);
  const gone = counts.get("gone") ?? 0;
  if (gone) parts.push(`${gone} no longer open`);
  const unsure = (counts.get("ambiguous") ?? 0) + (counts.get("changed") ?? 0);
  if (unsure) parts.push(`${unsure} changed or ambiguous, left alone`);
  const failed = counts.get("failed") ?? 0;
  if (failed) parts.push(`${failed} could not be ${action === "keep" ? "grouped" : "closed"}`);
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
      !(action === "keep" && i.hidden),
  );
}

export class DigestPanel {
  private readonly root: HTMLElement;
  private readonly host: DigestPanelHost;
  private list: DigestSummary[] = [];
  private view: DigestView | null = null;
  private selectedId: string | null = null;
  private focusedIndex: number | null = null;
  private busy = false;
  private active = false;

  constructor(root: HTMLElement, host: DigestPanelHost) {
    this.root = root;
    this.host = host;
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
      this.root.replaceChildren(this.renderEmpty());
      return;
    }
    const doc = el("article", "digest-doc");
    doc.append(this.renderHead(view));
    for (const spec of SECTIONS) {
      const section = this.renderSection(view, spec);
      if (section) doc.append(section);
    }
    this.root.replaceChildren(doc);
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
    return head;
  }

  private renderSection(view: DigestView, spec: SectionSpec): HTMLElement | null {
    const rows = view.items.filter((i) => i.effectiveFate === spec.fate);
    if (rows.length === 0) return null;
    const section = el("section", "digest-section");
    section.dataset.fate = spec.fate;

    const head = el("div", "section-head");
    head.append(
      el("span", "section-title", spec.title),
      el("span", "count-badge", String(rows.length)),
    );

    const record =
      spec.action === "keep" ? view.keep : spec.action === "close" ? view.lastClose : undefined;
    const note = el(
      "span",
      "section-note",
      spec.action && record ? actionSummary(spec.action, record) : spec.note,
    );
    head.append(note);

    if (spec.action) {
      const targets = actionable(rows, spec.action);
      if (spec.action === "close" && view.undo) {
        const undo = el("button", "quiet digest-undo", `Undo ${view.undo.restorable}`);
        undo.type = "button";
        undo.title = "Reopen the tabs this close took";
        undo.disabled = this.busy;
        undo.addEventListener("click", () => void this.undo());
        head.append(undo);
      }
      const label = spec.action === "keep" ? "Keep in a group" : `Close ${targets.length}`;
      const button = el("button", spec.action === "keep" ? "primary" : "danger", label);
      button.type = "button";
      if (spec.action === "keep") {
        button.append(el("span", "count-badge", String(targets.length)));
        button.title = "Put these tabs in a “Worth your time” tab group in their window";
      } else {
        button.title = "Close these tabs as one batch — Undo brings them back";
      }
      button.disabled = this.busy || targets.length === 0;
      if (targets.length === 0 && rows.every((r) => r.live !== "open")) {
        note.textContent = "none of these are open in this workspace";
      }
      button.addEventListener("click", () => void this.act(spec.action as DigestAction));
      // Once an action has run and left nothing to do, its result line says
      // what happened; a disabled "Close 0" beside "Undo 5" only adds noise.
      if (!(record && targets.length === 0)) head.append(button);
    }
    section.append(head);

    const list = el("ul", "digest-rows");
    for (const row of rows) list.append(this.renderRow(view, row));
    section.append(list);
    return section;
  }

  private renderRow(view: DigestView, row: DigestItemView): HTMLLIElement {
    const li = el("li", "tab digest-row");
    li.dataset.index = String(row.index);
    if (row.index === this.focusedIndex) li.classList.add("focused");
    if (row.live !== "open") li.classList.add("is-gone");

    const fav = el("span", "favicon");
    if (row.favIconUrl) {
      fav.style.backgroundImage = `url("${row.favIconUrl.replace(/"/g, "%22")}")`;
    } else {
      fav.classList.add("fallback");
      fav.textContent = hostInitial(row.host);
    }

    const body = el("div", "digest-body");
    const line = el("div", "digest-line");
    const title = el("span", "tab-title", row.title || row.host);
    title.title = row.title;
    line.append(title, el("span", "digest-host", row.host));
    body.append(line);

    const reason =
      row.effectiveFate === "could-not-read" && row.unreadable
        ? `${UNREADABLE[row.unreadable]} · ${row.reason}`
        : row.reason;
    const reasonEl = el(
      "p",
      row.effectiveFate === "worth-it" ? "digest-reason is-long" : "digest-reason",
      reason,
    );
    reasonEl.title = reason;
    body.append(reasonEl);

    const extras = el("p", "digest-extras");
    if (row.quote) {
      extras.append("from the page: ", el("q", undefined, row.quote));
    }
    if (row.interest) {
      if (extras.childNodes.length) extras.append(" · ");
      extras.append(`matches: ${row.interest}`);
    }
    if (row.link) {
      if (extras.childNodes.length) extras.append(" · ");
      extras.append("links to ", el("span", "mono", shortLink(row.link)));
    }
    if (extras.childNodes.length) body.append(extras);

    const marks = el("span", "tab-marks digest-marks");
    const mark = (text: string, tone = ""): void => {
      marks.append(el("span", `digest-status ${tone}`.trim(), text));
    };
    // The last action's refusal outranks the live state: "ambiguous, left
    // alone" stays the reason once the tabs that made it so are gone. "closed"
    // shows only while the tab is; after an Undo the row is simply open again.
    const refused =
      row.outcome !== undefined &&
      row.outcome !== "grouped" &&
      row.outcome !== "closed" &&
      row.outcome !== "gone";
    if (row.outcome === "grouped" || (row.outcome === "closed" && row.live !== "open")) {
      mark(OUTCOME_LABEL[row.outcome], "is-done");
    } else if (refused && row.outcome) {
      mark(OUTCOME_LABEL[row.outcome]);
    } else if (row.live === "gone") {
      mark("not open in this workspace");
    } else if (row.live === "ambiguous") {
      mark("ambiguous — left alone");
    } else if (row.pinned) {
      mark("pinned — left alone");
    }
    if (row.unmatchedAtReport && row.live !== "open") {
      marks.title = "The tab had changed by the time the agent reported it.";
    }
    if (row.fate !== row.effectiveFate) mark("moved", "is-moved");

    const actions = el("div", "tab-actions digest-actions");
    const seg = el("div", "seg digest-fate");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Move to section");
    for (const f of FATES) {
      const b = el("button", "seg-btn", f.label);
      b.type = "button";
      b.title = `${f.label} (${f.key})`;
      const on = f.fate === row.effectiveFate;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
      b.disabled = row.locked || this.busy;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.setFate(view.id, row.index, f.fate);
      });
      seg.append(b);
    }
    const show = el("button", "quiet digest-show", "Show");
    show.type = "button";
    show.title = row.live === "open" ? "Bring this tab forward" : "Open this page again";
    show.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.show(row.index);
    });
    actions.append(seg, show);

    li.append(fav, body, marks, actions);
    li.addEventListener("click", () => this.focus(row.index));
    return li;
  }

  private focus(index: number): void {
    this.focusedIndex = index;
    for (const row of this.root.querySelectorAll<HTMLElement>(".digest-row")) {
      row.classList.toggle("focused", Number(row.dataset.index) === index);
    }
  }

  private async setFate(id: string, index: number, fate: DigestFate): Promise<void> {
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
    if (res.unsupported) {
      this.host.toast(res.unsupported);
      return;
    }
    const summary = actionSummary(action, { startedAt: 0, outcomes: res.outcomes });
    this.host.toast(
      summary,
      action === "close" && res.done > 0 ? () => void this.undo() : undefined,
    );
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

  /** Rows in reading order, for j/k. */
  private orderedIndices(): number[] {
    const view = this.view;
    if (!view) return [];
    return SECTIONS.flatMap((s) =>
      view.items.filter((i) => i.effectiveFate === s.fate).map((i) => i.index),
    );
  }

  /**
   * Digest-mode keys: j/k move, 1-4 move the focused row to a section, Enter
   * shows it. `d` and `x` are deliberately not bound here, so a stray key can
   * never close a section. Returns whether the key was handled.
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
        .querySelector<HTMLElement>(`.digest-row[data-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return true;
    }
    if (this.focusedIndex === null || !this.view) return false;
    const fate = FATES.find((f) => f.key === key)?.fate;
    if (fate) {
      void this.setFate(this.view.id, this.focusedIndex, fate);
      return true;
    }
    if (key === "Enter") {
      void this.show(this.focusedIndex);
      return true;
    }
    return false;
  }
}
