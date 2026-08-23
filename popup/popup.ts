import type {
  ClipFailure,
  ClipSelectedTabsResponse,
  ClosedTabRecord,
  CloseDuplicatesResponse,
  GetScopedTabsResponse,
  PopupTab,
} from "../src/background.js";
import { openOptionsUi } from "../src/open-options.js";
import { CLIP_ORIGINS, DOWNLOADS_GONE, requestOrigins } from "../src/permissions.js";
import { pickRule } from "../src/site-rules.js";
import { clipNeedsPageAccess, hasClipDestination, type Settings } from "../src/storage.js";
import { IS_CHROME } from "../src/target.js";
import {
  clipSummary,
  computeDedupCount,
  extraTabIds,
  hostInitial,
  markdownForTabs,
  prettifyShortcut,
  reasonLabel,
  ruleMark,
  selectedTabsInUiOrder,
  sendMessage,
  type TabGroup,
  trackChromeHeights,
  visibleGroups,
  visibleTabIds,
} from "./lib.js";

interface PopupState {
  scopedTabs: PopupTab[];
  settings: Settings | null;
  filter: string;
  selected: Set<number>;
  dedupCount: number;
  toast: ToastState | null;
  clipping: boolean;
  devourFailures: ClipFailure[];
  stickyOrder: string[] | null;
}

interface ToastState {
  text: string;
  remainingSec: number;
  restorable: ClosedTabRecord[];
  intervalId: ReturnType<typeof setInterval> | null;
}

const TOAST_DURATION_SEC = 6;

const groupsEl = document.getElementById("groups") as HTMLUListElement;
const emptyEl = document.getElementById("empty") as HTMLDivElement;
const emptyTitleEl = document.getElementById("empty-title") as HTMLParagraphElement;
const emptySubEl = document.getElementById("empty-sub") as HTMLParagraphElement;
const warningEl = document.getElementById("warning") as HTMLDivElement;
const filterInput = document.getElementById("filter") as HTMLInputElement;
const selectAllBtn = document.getElementById("select-all") as HTMLButtonElement;
const selectionSummaryEl = document.getElementById("selection-summary") as HTMLSpanElement;
const dedupBtn = document.getElementById("dedup") as HTMLButtonElement;
const dedupCountEl = document.getElementById("dedup-count") as HTMLSpanElement;
const optionsBtn = document.getElementById("open-options") as HTMLButtonElement;
const cockpitBtn = document.getElementById("open-cockpit") as HTMLButtonElement;
const clipCurrentBtn = document.getElementById("clip-current") as HTMLButtonElement;
const copyUrlsBtn = document.getElementById("copy-urls") as HTMLButtonElement;
const closeSelectedBtn = document.getElementById("close-selected") as HTMLButtonElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;
const toastTextEl = document.getElementById("toast-text") as HTMLSpanElement;
const toastUndoBtn = document.getElementById("toast-undo") as HTMLButtonElement;
const shortcutHintEl = document.getElementById("shortcut-hint") as HTMLElement | null;
const logoMarkEl = document.getElementById("logo-mark") as HTMLElement | null;
const devourFailuresEl = document.getElementById("devour-failures") as HTMLElement;
const devourFailuresCountEl = document.getElementById("devour-failures-count") as HTMLSpanElement;
const devourFailuresListEl = document.getElementById("devour-failures-list") as HTMLUListElement;
const devourRetryAllBtn = document.getElementById("devour-retry-all") as HTMLButtonElement;
const devourDismissBtn = document.getElementById("devour-dismiss") as HTMLButtonElement;

const state: PopupState = {
  scopedTabs: [],
  settings: null,
  filter: "",
  selected: new Set(),
  dedupCount: 0,
  toast: null,
  clipping: false,
  devourFailures: [],
  stickyOrder: null,
};

function renderWarning(): void {
  // Chrome has no workspaces, so the heuristic warning never applies.
  if (IS_CHROME) {
    warningEl.hidden = true;
    return;
  }
  const s = state.settings;
  if (s?.heuristicWarning && s.scope === "hidden-false") {
    warningEl.hidden = false;
    warningEl.textContent =
      "Workspace heuristic looks broken — Zen reports no hidden tabs. Switch scope to ‘Current window only’ in Options if dedup spans workspaces.";
  } else {
    warningEl.hidden = true;
  }
}

function renderEmpty(groups: TabGroup[]): void {
  if (groups.length > 0) {
    emptyEl.hidden = true;
    return;
  }
  emptyEl.hidden = false;
  if (state.filter.trim()) {
    emptyTitleEl.textContent = "No matches.";
    emptySubEl.textContent = `No tabs match “${state.filter}”.`;
  } else {
    emptyTitleEl.textContent = "No tabs in scope.";
    emptySubEl.textContent =
      state.settings?.scope === "current-window"
        ? "Scope: current window only."
        : "Scope: active workspace (visible tabs).";
  }
}

/**
 * What a group's Select button offers. In a duplicate set that is the extras —
 * the keeper is the tab you are choosing to live with, so offering to select it
 * alongside them would be offering to close the lot.
 */
function selectableTabs(group: TabGroup): PopupTab[] {
  if (group.kind !== "duplicate") return group.tabs;
  return group.tabs.filter((t) => t.id !== group.keeperId);
}

/**
 * Read against the whole group, not just what Select offers: a keeper ticked by
 * hand is part of the selection, and a button reading "Select extras" over a
 * group with a checked row in it is describing a state that isn't there.
 */
function groupSelectionState(group: TabGroup): "none" | "partial" | "all" {
  const anySelected = group.tabs.some((t) => state.selected.has(t.id));
  if (!anySelected) return "none";
  return selectableTabs(group).every((t) => state.selected.has(t.id)) ? "all" : "partial";
}

function setGroupSelection(group: TabGroup, select: boolean): void {
  // Deselect clears the whole group — including a keeper the user ticked, which
  // is exactly the selection the button claims to be clearing.
  for (const t of select ? selectableTabs(group) : group.tabs) {
    if (select) state.selected.add(t.id);
    else state.selected.delete(t.id);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

function makePinIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", "12");
  line.setAttribute("y1", "17");
  line.setAttribute("x2", "12");
  line.setAttribute("y2", "22");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z",
  );
  svg.append(line, path);
  return svg;
}

/** The "Duplicates" / "Everything else" rules that separate the two sections. */
function renderSectionHead(title: string, dups: TabGroup[] | null): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "section-head";

  const titleEl = document.createElement("span");
  titleEl.className = "section-title";
  titleEl.textContent = title;
  li.append(titleEl);

  if (!dups) return li;

  const extras = extraTabIds(dups);
  const noteEl = document.createElement("span");
  noteEl.className = "section-note";
  noteEl.textContent = `${extras.length} extra ${extras.length === 1 ? "tab" : "tabs"} · ${dups.length} ${dups.length === 1 ? "set" : "sets"}`;

  const allSelected = extras.every((id) => state.selected.has(id));
  const selectBtn = document.createElement("button");
  selectBtn.className = "select-toggle quiet";
  selectBtn.type = "button";
  selectBtn.textContent = `${allSelected ? "Deselect" : "Select"} all ${extras.length}`;
  selectBtn.title = "Select every copy Dedup would close, across all sets";
  selectBtn.addEventListener("click", () => {
    for (const id of extras) {
      if (allSelected) state.selected.delete(id);
      else state.selected.add(id);
    }
    render();
  });

  li.append(noteEl, selectBtn);
  return li;
}

function renderGroup(group: TabGroup): HTMLLIElement {
  const dup = group.kind === "duplicate";
  const li = document.createElement("li");
  li.className = dup ? "group group-dup" : "group";

  const header = document.createElement("div");
  header.className = "group-header";

  const hostEl = document.createElement("span");
  hostEl.className = dup ? "group-host group-key" : "group-host";
  hostEl.textContent = group.label;
  if (dup) hostEl.title = group.label;

  const countEl = document.createElement("span");
  countEl.className = "group-count";
  countEl.textContent = dup ? `×${group.tabs.length}` : `${group.tabs.length}`;

  const sel = groupSelectionState(group);
  const selectBtn = document.createElement("button");
  selectBtn.className = `select-toggle quiet ${sel}`;
  selectBtn.type = "button";
  selectBtn.textContent =
    sel === "all"
      ? "Deselect"
      : sel === "partial"
        ? "Select rest"
        : dup
          ? "Select extras"
          : "Select";
  selectBtn.title =
    sel === "all"
      ? "Deselect these tabs"
      : dup
        ? "Select every copy but the one Dedup keeps"
        : "Select all tabs in this group";
  selectBtn.addEventListener("click", () => {
    setGroupSelection(group, sel !== "all");
    render();
  });

  header.append(hostEl, countEl, selectBtn);
  li.append(header);

  const tabsEl = document.createElement("div");
  tabsEl.className = "tabs";
  for (const tab of group.tabs) {
    tabsEl.append(renderTab(tab, group));
  }
  li.append(tabsEl);
  return li;
}

/**
 * The trailing markers share one cell. `.tab` is a five-column grid and a sixth
 * child wraps onto a second row, which a duplicate keeper that is also pinned
 * would otherwise do.
 */
function renderMarks(tab: PopupTab, group: TabGroup): HTMLSpanElement | null {
  const marks: HTMLElement[] = [];

  // Disposition pills come first: a rule about to keep, close, or reroute a
  // tab has to be readable before Devour runs, not discovered in its report.
  const rule = state.settings && tab.url ? pickRule(tab.url, state.settings.siteRules) : null;
  if (rule && rule.disposition !== "devour") {
    const mark = ruleMark(rule.disposition);
    const pill = document.createElement("span");
    pill.className = `rule-pill rule-${rule.disposition}`;
    pill.textContent = mark.label;
    pill.title = mark.title;
    marks.push(pill);
  }

  if (group.kind === "duplicate" && tab.id === group.keeperId) {
    const keep = document.createElement("span");
    keep.className = "keep-pill";
    keep.textContent = "keep";
    keep.title = "Dedup keeps this copy — the most recently used one";
    marks.push(keep);
  }

  if (tab.pinned) {
    const pin = document.createElement("span");
    pin.className = "pin-icon";
    pin.title = "Pinned tab";
    pin.setAttribute("aria-label", "Pinned");
    pin.append(makePinIcon());
    marks.push(pin);
  }

  if (!marks.length) return null;
  const wrap = document.createElement("span");
  wrap.className = "tab-marks";
  wrap.append(...marks);
  return wrap;
}

function renderTab(tab: PopupTab, group: TabGroup): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "tab";
  row.dataset.tabId = String(tab.id);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selected.has(tab.id);
  checkbox.title = "Select this tab";
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selected.add(tab.id);
    else state.selected.delete(tab.id);
    render();
  });

  const fav = document.createElement("span");
  fav.className = "favicon";
  if (tab.favIconUrl) {
    fav.style.backgroundImage = `url("${tab.favIconUrl}")`;
  } else {
    fav.classList.add("fallback");
    fav.textContent = hostInitial(group.host);
  }

  const body = document.createElement("div");
  body.className = "tab-body";
  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = tab.title ?? tab.url ?? "(untitled)";
  const meta = document.createElement("span");
  meta.className = "tab-meta";
  meta.textContent = tab.url ?? "";
  body.append(title, meta);
  body.title = "Click to focus this tab";
  body.addEventListener("click", () => {
    void focusTab(tab.id);
  });

  row.append(checkbox, fav, body);

  const marks = renderMarks(tab, group);
  if (marks) row.append(marks);

  const actions = document.createElement("div");
  actions.className = "tab-actions";
  const closeBtn = document.createElement("button");
  closeBtn.className = "icon danger";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close this tab";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeTabs([tab.id]);
  });
  actions.append(closeBtn);
  row.append(actions);

  return row;
}

function renderSelectionSummary(visibleIds: number[]): void {
  const total = state.scopedTabs.length;
  const selected = state.selected.size;
  selectionSummaryEl.textContent =
    selected === 0 ? `0 of ${total} chosen` : `${selected} of ${total} chosen`;

  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
  selectAllBtn.textContent = allVisibleSelected ? "Deselect all" : "Select all";
  selectAllBtn.disabled = visibleIds.length === 0;

  const hasSelection = selected > 0;
  copyUrlsBtn.disabled = !hasSelection;
  clipCurrentBtn.disabled = !hasSelection || state.clipping;
  closeSelectedBtn.disabled = !hasSelection;
}

function renderDedupBadge(): void {
  state.dedupCount = computeDedupCount(state.scopedTabs, state.settings);
  dedupBtn.disabled = state.dedupCount === 0;
  if (state.dedupCount > 0) {
    dedupCountEl.hidden = false;
    dedupCountEl.textContent = String(state.dedupCount);
  } else {
    dedupCountEl.hidden = true;
  }
}

function renderToast(): void {
  if (!state.toast) {
    toastEl.hidden = true;
    return;
  }
  toastEl.hidden = false;
  toastTextEl.textContent = `${state.toast.text} · Undo (${state.toast.remainingSec})`;
}

function reasonTooltip(f: ClipFailure): string {
  return f.detail?.trim() ?? "";
}

function renderFailureRow(f: ClipFailure): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "devour-failures-row";

  const title = document.createElement("span");
  title.className = "devour-failures-title-text";
  title.textContent = f.title.trim() || f.url.trim() || `Tab ${f.tabId}`;
  if (f.url) title.title = f.url;

  const pill = document.createElement("span");
  pill.className = "reason-pill";
  pill.textContent = reasonLabel(f.reason);
  const tooltip = reasonTooltip(f);
  if (tooltip) pill.title = tooltip;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry";
  retry.textContent = "Retry";
  retry.disabled = state.clipping;
  retry.addEventListener("click", () => void retryFailures([f.tabId]));

  li.append(title, pill, retry);
  return li;
}

function renderDevourFailures(): void {
  const failures = state.devourFailures;
  if (!failures.length) {
    devourFailuresEl.hidden = true;
    devourFailuresListEl.replaceChildren();
    return;
  }
  devourFailuresEl.hidden = false;
  devourFailuresCountEl.textContent = String(failures.length);
  devourRetryAllBtn.disabled = state.clipping;
  devourDismissBtn.disabled = state.clipping;
  devourFailuresListEl.replaceChildren(...failures.map(renderFailureRow));
}

/** Duplicates first under their own rule, then the domain groups under theirs. */
function renderList(groups: TabGroup[]): HTMLLIElement[] {
  const dups = groups.filter((g) => g.kind === "duplicate");
  const rest = groups.filter((g) => g.kind !== "duplicate");
  const items: HTMLLIElement[] = [];
  if (dups.length) {
    items.push(renderSectionHead("Duplicates", dups));
    for (const g of dups) items.push(renderGroup(g));
    if (rest.length) items.push(renderSectionHead("Everything else", null));
  }
  for (const g of rest) items.push(renderGroup(g));
  items.forEach((li, idx) => li.style.setProperty("--i", String(Math.min(idx, 10))));
  return items;
}

function render(): void {
  renderWarning();
  const groups = visibleGroups(state.scopedTabs, state.filter, state.settings, state.stickyOrder);
  if (state.stickyOrder === null) {
    state.stickyOrder = groups.map((g) => g.key);
  }
  renderEmpty(groups);
  groupsEl.replaceChildren(...renderList(groups));
  renderSelectionSummary(visibleTabIds(groups));
  renderDedupBadge();
  renderToast();
  renderDevourFailures();
}

async function refresh(): Promise<void> {
  const res = await sendMessage<GetScopedTabsResponse>({ type: "get-scoped-tabs" });
  if (!res) return;
  state.scopedTabs = res.tabs;
  state.settings = res.settings;
  const live = new Set(state.scopedTabs.map((t) => t.id));
  for (const id of state.selected) {
    if (!live.has(id)) state.selected.delete(id);
  }
  render();
}

async function focusTab(tabId: number): Promise<void> {
  await sendMessage({ type: "focus-tab", tabId });
  window.close();
}

async function closeTabs(tabIds: number[]): Promise<void> {
  if (!tabIds.length) return;
  await sendMessage({ type: "close-tabs", tabIds });
  for (const id of tabIds) state.selected.delete(id);
  await refresh();
}

function selectedForOps(): PopupTab[] {
  const groups = visibleGroups(state.scopedTabs, state.filter, state.settings, state.stickyOrder);
  return selectedTabsInUiOrder(groups, state.selected);
}

async function copyUrls(): Promise<void> {
  const tabs = selectedForOps();
  if (!tabs.length) return;
  const original = copyUrlsBtn.textContent;
  copyUrlsBtn.disabled = true;
  copyUrlsBtn.textContent = "Copying…";
  try {
    await navigator.clipboard.writeText(markdownForTabs(tabs));
    copyUrlsBtn.textContent = `Copied ${tabs.length}`;
    setTimeout(() => {
      copyUrlsBtn.textContent = original;
      copyUrlsBtn.disabled = state.selected.size === 0;
    }, 1200);
  } catch (err) {
    console.warn("[tabglutton] clipboard failed", err);
    copyUrlsBtn.textContent = "Copy failed";
    setTimeout(() => {
      copyUrlsBtn.textContent = original;
      copyUrlsBtn.disabled = state.selected.size === 0;
    }, 1500);
  }
}

function mergeClipFailures(retriedTabIds: number[], newFailures: ClipFailure[]): void {
  const retried = new Set(retriedTabIds);
  state.devourFailures = state.devourFailures.filter((f) => !retried.has(f.tabId));
  state.devourFailures.push(...newFailures);
}

function setDevourProgress(completed: number, total: number): void {
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  clipCurrentBtn.style.setProperty("--devour-progress", `${pct}%`);
  clipCurrentBtn.textContent = total > 1 ? `Clipping ${completed}/${total}…` : "Clipping…";
}

function clearDevourProgress(): void {
  clipCurrentBtn.style.removeProperty("--devour-progress");
}

async function clipSelected(): Promise<void> {
  const queue = selectedForOps();
  if (!queue.length) return;
  const original = clipCurrentBtn.textContent;
  const originalTitle = clipCurrentBtn.title;
  const restore = (text: string, ms: number) => {
    clipCurrentBtn.textContent = text;
    setTimeout(() => {
      clipCurrentBtn.textContent = original;
      clipCurrentBtn.title = originalTitle;
      clearDevourProgress();
      state.clipping = false;
      render();
    }, ms);
  };

  if (!hasClipDestination(state.settings)) {
    clipCurrentBtn.title = "Set Obsidian vault in Options first.";
    state.clipping = true;
    clipCurrentBtn.disabled = true;
    restore("Set vault", 2200);
    return;
  }

  // The first await in this handler, deliberately: Chrome gates
  // permissions.request on the click's transient activation, so any earlier
  // await would spend it and the request would reject as gesture-less. Held
  // already (always, on Firefox) this resolves true without showing anything.
  // `clipNeedsPageAccess` guards it because a Zotero-only run never injects
  // Defuddle — it has to stay synchronous for the same reason.
  if (clipNeedsPageAccess(state.settings) && !(await requestOrigins(CLIP_ORIGINS))) {
    clipCurrentBtn.title = "Tabglutton needs access to the pages it clips.";
    state.clipping = true;
    clipCurrentBtn.disabled = true;
    restore("Needs site access", 2600);
    return;
  }

  state.clipping = true;
  clipCurrentBtn.disabled = true;
  clipCurrentBtn.title = "";
  setDevourProgress(0, queue.length);

  const tabIds = queue.map((t) => t.id);
  const res = await sendMessage<ClipSelectedTabsResponse>({
    type: "clip-selected-tabs",
    tabIds,
  });

  if (!res) {
    restore("Clip failed", 1800);
    return;
  }
  if (res.blocked === "downloads-revoked") {
    clipCurrentBtn.title = DOWNLOADS_GONE;
    restore("Needs downloads", 2600);
    return;
  }
  if (res.blocked) {
    restore("Set vault", 2200);
    return;
  }
  mergeClipFailures(tabIds, res.failures);
  await refresh();
  // Rule-driven closes get the same undo the dedup button offers — a rule the
  // user wrote is still a close they may want back.
  if (res.ruleClosed > 0) showUndoToast(res.ruleClosed, res.ruleClosedRestorable);
  restore(clipSummary(res), res.failed === 0 ? 1400 : 2200);
}

/**
 * Say something on the primary button without owning the clipping state the way
 * `clipSelected`'s own `restore` does. Nothing else writes that label, so the
 * flash survives the re-render `refresh()` triggers underneath it.
 */
function flashPrimary(text: string, title: string, ms: number): void {
  const originalLabel = clipCurrentBtn.textContent;
  const originalTitle = clipCurrentBtn.title;
  clipCurrentBtn.textContent = text;
  clipCurrentBtn.title = title;
  setTimeout(() => {
    clipCurrentBtn.textContent = originalLabel;
    clipCurrentBtn.title = originalTitle;
  }, ms);
}

async function retryFailures(tabIds: number[]): Promise<void> {
  if (state.clipping || !tabIds.length) return;
  if (!hasClipDestination(state.settings)) return;
  state.clipping = true;
  render();
  const res = await sendMessage<ClipSelectedTabsResponse>({
    type: "clip-selected-tabs",
    tabIds,
  });
  // A blocked run attempted nothing, so there is nothing to merge — and saying
  // nothing would leave the old failures on screen looking retried. Reachable
  // only since `downloads-revoked`: with no destination at all there are no
  // failures to retry in the first place.
  if (res?.blocked === "downloads-revoked") flashPrimary("Needs downloads", DOWNLOADS_GONE, 2600);
  else if (res && !res.blocked) {
    mergeClipFailures(tabIds, res.failures);
  }
  clearDevourProgress();
  state.clipping = false;
  await refresh();
}

function dismissDevourFailures(): void {
  if (state.clipping) return;
  state.devourFailures = [];
  render();
}

async function closeSelected(): Promise<void> {
  const ids = [...state.selected];
  if (!ids.length) return;
  await closeTabs(ids);
}

function clearToast(): void {
  if (state.toast?.intervalId) clearInterval(state.toast.intervalId);
  state.toast = null;
  renderToast();
}

function showUndoToast(closed: number, restorable: ClosedTabRecord[]): void {
  if (!restorable.length) return;
  clearToast();
  const toast: ToastState = {
    text: `${closed} closed`,
    remainingSec: TOAST_DURATION_SEC,
    restorable,
    intervalId: null,
  };
  state.toast = toast;
  renderToast();
  toast.intervalId = setInterval(() => {
    toast.remainingSec -= 1;
    if (toast.remainingSec <= 0) {
      clearToast();
      return;
    }
    renderToast();
  }, 1000);
}

async function runDedup(): Promise<void> {
  dedupBtn.disabled = true;
  const original = dedupBtn.querySelector(".primary-label")?.textContent ?? "Dedup";
  const labelEl = dedupBtn.querySelector(".primary-label") as HTMLElement | null;
  if (labelEl) labelEl.textContent = "Closing…";
  try {
    const res = await sendMessage<CloseDuplicatesResponse>({ type: "close-duplicates" });
    await refresh();
    if (res && res.closed > 0) {
      showUndoToast(res.closed, res.restorable);
    }
  } finally {
    if (labelEl) labelEl.textContent = original;
    renderDedupBadge();
  }
}

async function undoDedup(): Promise<void> {
  if (!state.toast) return;
  const records = state.toast.restorable;
  clearToast();
  await sendMessage({ type: "reopen-tabs", records });
  await refresh();
}

async function openCockpit(): Promise<void> {
  await sendMessage({ type: "open-cockpit" });
  window.close();
}

dedupBtn.addEventListener("click", () => void runDedup());
optionsBtn.addEventListener("click", () => {
  // Awaited, not fired-and-forgotten: closing the popup tears down this script,
  // and openOptionsUi has to read a setting before it can open anything.
  void (async () => {
    await openOptionsUi();
    window.close();
  })();
});
cockpitBtn.addEventListener("click", () => void openCockpit());
filterInput.addEventListener("input", () => {
  state.filter = filterInput.value;
  state.stickyOrder = null;
  render();
});
selectAllBtn.addEventListener("click", () => {
  const groups = visibleGroups(state.scopedTabs, state.filter, state.settings, state.stickyOrder);
  const ids = visibleTabIds(groups);
  const allSelected = ids.length > 0 && ids.every((id) => state.selected.has(id));
  if (allSelected) {
    for (const id of ids) state.selected.delete(id);
  } else {
    for (const id of ids) state.selected.add(id);
  }
  render();
});
clipCurrentBtn.addEventListener("click", () => void clipSelected());
copyUrlsBtn.addEventListener("click", () => void copyUrls());
closeSelectedBtn.addEventListener("click", () => void closeSelected());
toastUndoBtn.addEventListener("click", () => void undoDedup());
devourRetryAllBtn.addEventListener("click", () => {
  const ids = state.devourFailures.map((f) => f.tabId);
  void retryFailures(ids);
});
devourDismissBtn.addEventListener("click", () => dismissDevourFailures());

browser.runtime.onMessage.addListener((raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as { type?: string; completed?: number; total?: number };
  if (
    msg.type === "clip-progress" &&
    typeof msg.completed === "number" &&
    typeof msg.total === "number"
  ) {
    setDevourProgress(msg.completed, msg.total);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
    return;
  }
  e.preventDefault();
  filterInput.focus();
  filterInput.select();
});

async function renderShortcutHint(): Promise<void> {
  if (!shortcutHintEl) return;
  const fallback = prettifyShortcut("Alt+Shift+G");
  try {
    const commands = await browser.commands.getAll();
    const action = commands.find((c) => c.name === "_execute_action");
    const shortcut = action?.shortcut;
    shortcutHintEl.textContent = shortcut ? prettifyShortcut(shortcut) : fallback;
  } catch {
    shortcutHintEl.textContent = fallback;
  }
}

async function loadLogoMark(): Promise<void> {
  if (!logoMarkEl) return;
  try {
    const res = await fetch(browser.runtime.getURL("icons/logo-mark.svg"));
    if (!res.ok) return;
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.documentElement;
    if (svg && svg.nodeName.toLowerCase() === "svg") {
      logoMarkEl.replaceChildren(document.importNode(svg, true));
    }
  } catch (err) {
    console.warn("[tabglutton] logo load failed", err);
  }
}

void renderShortcutHint();
void loadLogoMark();
trackChromeHeights(
  document.body,
  document.getElementById("chrome-top"),
  document.getElementById("chrome-bottom"),
);
document.body.classList.add("initial-load");
void refresh().then(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove("initial-load");
    });
  });
});
