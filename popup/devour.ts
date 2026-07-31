import type {
  ClipFailure,
  ClipFailureReason,
  ClipSelectedTabsResponse,
  ClosedTabRecord,
  CloseDuplicatesResponse,
  GetScopedTabsResponse,
  PopupTab,
} from "../src/background.js";
import { pickRule, type SiteRule } from "../src/site-rules.js";
import type { Settings } from "../src/storage.js";
import {
  computeDedupCount,
  type DomainGroup,
  hostInitial,
  hostOf,
  markdownForTabs,
  selectedTabsInUiOrder,
  sendMessage,
  visibleGroups,
  visibleTabIds,
} from "./lib.js";

interface CockpitState {
  scopedTabs: PopupTab[];
  settings: Settings | null;
  filter: string;
  selected: Set<number>;
  dedupCount: number;
  toast: ToastState | null;
  clipping: boolean;
  devourFailures: ClipFailure[];
  focusedTabId: number | null;
  stickyHostOrder: string[] | null;
}

interface ToastState {
  text: string;
  remainingSec: number;
  restorable: ClosedTabRecord[];
  intervalId: ReturnType<typeof setInterval> | null;
}

const TOAST_DURATION_SEC = 6;
const CLIPPER_PATH = "Clippings";

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
const clipCurrentBtn = document.getElementById("clip-current") as HTMLButtonElement;
const clipCountEl = document.getElementById("clip-count") as HTMLSpanElement;
const copyUrlsBtn = document.getElementById("copy-urls") as HTMLButtonElement;
const closeSelectedBtn = document.getElementById("close-selected") as HTMLButtonElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;
const toastTextEl = document.getElementById("toast-text") as HTMLSpanElement;
const toastUndoBtn = document.getElementById("toast-undo") as HTMLButtonElement;
const logoMarkEl = document.getElementById("logo-mark") as HTMLElement | null;
const inspectorEl = document.getElementById("inspector-content") as HTMLElement;
const devourFailuresEl = document.getElementById("devour-failures") as HTMLElement;
const devourFailuresCountEl = document.getElementById("devour-failures-count") as HTMLSpanElement;
const devourFailuresListEl = document.getElementById("devour-failures-list") as HTMLUListElement;
const devourRetryAllBtn = document.getElementById("devour-retry-all") as HTMLButtonElement;
const devourDismissBtn = document.getElementById("devour-dismiss") as HTMLButtonElement;

const state: CockpitState = {
  scopedTabs: [],
  settings: null,
  filter: "",
  selected: new Set(),
  dedupCount: 0,
  toast: null,
  clipping: false,
  devourFailures: [],
  focusedTabId: null,
  stickyHostOrder: null,
};

function renderWarning(): void {
  const s = state.settings;
  if (s?.heuristicWarning && s.scope === "hidden-false") {
    warningEl.hidden = false;
    warningEl.textContent =
      "Workspace heuristic looks broken — Zen reports no hidden tabs. Switch scope to ‘Current window only’ in Options if dedup spans workspaces.";
  } else {
    warningEl.hidden = true;
  }
}

function renderEmpty(groups: DomainGroup[]): void {
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

function groupSelectionState(group: DomainGroup): "none" | "partial" | "all" {
  let selected = 0;
  for (const t of group.tabs) {
    if (state.selected.has(t.id)) selected += 1;
  }
  if (selected === 0) return "none";
  if (selected === group.tabs.length) return "all";
  return "partial";
}

function setGroupSelection(group: DomainGroup, select: boolean): void {
  for (const t of group.tabs) {
    if (select) state.selected.add(t.id);
    else state.selected.delete(t.id);
  }
}

function setFocusedTab(tabId: number | null): void {
  state.focusedTabId = tabId;
  renderInspector();
  updateFocusedRowVisuals();
}

function updateFocusedRowVisuals(): void {
  for (const row of groupsEl.querySelectorAll<HTMLDivElement>(".tab")) {
    const id = Number(row.dataset.tabId);
    row.classList.toggle("focused", id === state.focusedTabId);
  }
}

function renderGroup(group: DomainGroup): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "group";

  const header = document.createElement("div");
  header.className = "group-header";

  const hostEl = document.createElement("span");
  hostEl.className = "group-host";
  hostEl.textContent = group.host;

  const countEl = document.createElement("span");
  countEl.className = "group-count";
  countEl.textContent = `${group.tabs.length}`;

  const sel = groupSelectionState(group);
  const selectBtn = document.createElement("button");
  selectBtn.className = `select-toggle quiet ${sel}`;
  selectBtn.type = "button";
  selectBtn.textContent = sel === "all" ? "Deselect" : sel === "partial" ? "Select rest" : "Select";
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

function renderTab(tab: PopupTab, group: DomainGroup): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "tab";
  row.dataset.tabId = String(tab.id);
  if (tab.id === state.focusedTabId) row.classList.add("focused");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selected.has(tab.id);
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
  body.title = "Click to inspect this tab";
  body.addEventListener("click", () => setFocusedTab(tab.id));

  row.append(checkbox, fav, body);

  if (tab.pinned) {
    const pin = document.createElement("span");
    pin.className = "pin-icon";
    pin.title = "Pinned tab";
    pin.setAttribute("aria-label", "Pinned");
    pin.append(makePinIcon());
    row.append(pin);
  }

  const actions = document.createElement("div");
  actions.className = "tab-actions";

  const openBtn = document.createElement("button");
  openBtn.className = "icon";
  openBtn.title = "Focus this tab in its window";
  openBtn.append(makeOpenIcon());
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void sendMessage({ type: "focus-tab", tabId: tab.id });
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "icon danger";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close this tab";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeTabs([tab.id]);
  });
  actions.append(openBtn, closeBtn);
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

  if (selected > 0) {
    clipCountEl.hidden = false;
    clipCountEl.textContent = String(selected);
  } else {
    clipCountEl.hidden = true;
  }
}

function renderDedupBadge(): void {
  state.dedupCount = computeDedupCount(state.scopedTabs, state.settings);
  dedupBtn.disabled = state.dedupCount === 0 || state.clipping;
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

function reasonLabel(reason: ClipFailureReason): string {
  switch (reason) {
    case "extract-failed":
      return "extract failed";
    case "trigger-failed":
      return "open failed";
  }
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
  if (f.detail?.trim()) pill.title = f.detail;

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

/* ---------- inspector ---------- */

function sanitizeFileName(name: string): string {
  let s = Array.from(name)
    .filter((c) => c.charCodeAt(0) >= 32)
    .join("")
    .replace(/[#[\]|^]/g, "")
    .replace(/[/:]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 245);
  if (!s) s = "Untitled";
  return s;
}

function targetFolder(rule: SiteRule | null): string {
  return rule ? `${CLIPPER_PATH}/${rule.subfolder}` : CLIPPER_PATH;
}

function focusedTab(): PopupTab | null {
  if (state.focusedTabId === null) return null;
  return state.scopedTabs.find((t) => t.id === state.focusedTabId) ?? null;
}

function renderInspector(): void {
  inspectorEl.replaceChildren();
  const tab = focusedTab();
  const vault = state.settings?.obsidianVault.trim() ?? "";

  // The pane only exists when it has something to say. With a vault set and no tab
  // focused it held nothing but a restatement of the footer's keyboard legend, and
  // reserved ~40% of the window to do it — the queue takes that width instead.
  document.body.classList.toggle("inspecting", !vault || tab !== null);

  if (!vault) {
    inspectorEl.append(renderInspectorSetup());
    return;
  }
  if (!tab) return;
  inspectorEl.append(renderInspectorPreview(tab, vault));
}

const SVG_NS = "http://www.w3.org/2000/svg";

function makeOpenIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", "M6 3H3v3M3 13l10-10M10 3h3v3");
  svg.append(path);
  return svg;
}

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

function renderInspectorSetup(): HTMLElement {
  const div = document.createElement("div");
  div.className = "inspector-setup";
  const h = document.createElement("h3");
  h.textContent = "Set an Obsidian vault first";

  const code = document.createElement("code");
  code.textContent = "Clippings/";
  const p = document.createElement("p");
  p.append(
    "Tabglutton routes devoured pages into your Obsidian vault under ",
    code,
    ". Open settings to point it at the vault name as it appears in Obsidian's switcher.",
  );

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary";
  btn.textContent = "Open settings";
  btn.addEventListener("click", () => void browser.runtime.openOptionsPage());
  div.append(h, p, btn);
  return div;
}

function renderInspectorPreview(tab: PopupTab, vault: string): HTMLElement {
  const wrap = document.createElement("div");

  const head = document.createElement("section");
  head.className = "inspector-section inspector-head";
  const fav = document.createElement("span");
  fav.className = "favicon";
  if (tab.favIconUrl) {
    fav.style.backgroundImage = `url("${tab.favIconUrl}")`;
  } else {
    fav.classList.add("fallback");
    fav.textContent = hostInitial(hostOf(tab.url));
  }
  const headText = document.createElement("div");
  headText.style.minWidth = "0";
  const t = document.createElement("div");
  t.className = "inspector-title";
  t.textContent = tab.title || tab.url || "(untitled)";
  const u = document.createElement("div");
  u.className = "inspector-url";
  u.textContent = tab.url ?? "";
  headText.append(t, u);
  head.append(fav, headText);
  wrap.append(head);

  const rule = tab.url ? pickRule(tab.url) : null;
  const folder = targetFolder(rule);
  const fileName = sanitizeFileName(tab.title || tab.url || "Untitled");

  const pathSection = document.createElement("section");
  pathSection.className = "inspector-section";
  const pathLabel = document.createElement("span");
  pathLabel.className = "inspector-section-label";
  pathLabel.textContent = "Will save to";
  const path = document.createElement("div");
  path.className = "inspector-path";
  const vaultEl = document.createElement("strong");
  vaultEl.textContent = vault;
  path.append(vaultEl, ` / ${folder} / ${fileName}.md`);
  pathSection.append(pathLabel, path);
  wrap.append(pathSection);

  const fmSection = document.createElement("section");
  fmSection.className = "inspector-section";
  const fmLabel = document.createElement("span");
  fmLabel.className = "inspector-section-label";
  fmLabel.textContent = "Frontmatter preview";
  const fm = document.createElement("pre");
  fm.className = "inspector-frontmatter";
  fm.append(buildFrontmatterPreview(tab));
  fmSection.append(fmLabel, fm);
  wrap.append(fmSection);

  const metaSection = document.createElement("section");
  metaSection.className = "inspector-section";
  const metaLabel = document.createElement("span");
  metaLabel.className = "inspector-section-label";
  metaLabel.textContent = "Routing";
  const dl = document.createElement("dl");
  dl.className = "inspector-meta";
  addDef(dl, "Host", hostOf(tab.url));
  addDef(dl, "Rule", rule ? rule.id : "default");
  addDef(dl, "Folder", folder);
  metaSection.append(metaLabel, dl);
  wrap.append(metaSection);

  return wrap;
}

function buildFrontmatterPreview(tab: PopupTab): DocumentFragment {
  const frag = document.createDocumentFragment();
  const created = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const lines: Array<[label: string, value: string, deferred: boolean]> = [
    ["title", `"${(tab.title ?? "").replace(/"/g, '\\"')}"`, false],
    ["source", `"${tab.url ?? ""}"`, false],
    ["author", "(filled on devour)", true],
    ["published", "(filled on devour)", true],
    ["created", created, false],
    ["description", "(filled on devour)", true],
    ["tags", '\n  - "clippings"', false],
  ];
  frag.append(document.createTextNode("---\n"));
  for (const [k, v, deferred] of lines) {
    const key = document.createElement("span");
    key.className = "fm-key";
    key.textContent = `${k}:`;
    frag.append(key);
    if (deferred) {
      const span = document.createElement("span");
      span.className = "fm-deferred";
      span.textContent = ` ${v}`;
      frag.append(span);
    } else {
      frag.append(document.createTextNode(v.startsWith("\n") ? v : ` ${v}`));
    }
    frag.append(document.createTextNode("\n"));
  }
  frag.append(document.createTextNode("---"));
  return frag;
}

function addDef(dl: HTMLElement, term: string, definition: string): void {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = definition;
  dl.append(dt, dd);
}

/* ---------- render ---------- */

function render(): void {
  renderWarning();
  const groups = visibleGroups(state.scopedTabs, state.filter, state.stickyHostOrder);
  if (state.stickyHostOrder === null) {
    state.stickyHostOrder = groups.map((g) => g.host);
  }
  renderEmpty(groups);
  groupsEl.replaceChildren();
  groups.forEach((g, idx) => {
    const li = renderGroup(g);
    li.style.setProperty("--i", String(Math.min(idx, 12)));
    groupsEl.append(li);
  });
  renderSelectionSummary(visibleTabIds(groups));
  renderDedupBadge();
  renderToast();
  renderDevourFailures();
  renderInspector();
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
  if (state.focusedTabId !== null && !live.has(state.focusedTabId)) {
    state.focusedTabId = null;
  }
  render();
}

async function closeTabs(tabIds: number[]): Promise<void> {
  if (!tabIds.length) return;
  await sendMessage({ type: "close-tabs", tabIds });
  for (const id of tabIds) state.selected.delete(id);
  if (state.focusedTabId !== null && tabIds.includes(state.focusedTabId)) {
    state.focusedTabId = null;
  }
  await refresh();
}

function selectedForOps(): PopupTab[] {
  const groups = visibleGroups(state.scopedTabs, state.filter, state.stickyHostOrder);
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
  const label = clipCurrentBtn.querySelector(".primary-label") as HTMLElement | null;
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  clipCurrentBtn.style.setProperty("--devour-progress", `${pct}%`);
  if (label) {
    label.textContent = total > 1 ? `Devouring ${completed}/${total}…` : "Devouring…";
  }
}

function clearDevourProgress(): void {
  clipCurrentBtn.style.removeProperty("--devour-progress");
}

async function clipSelected(): Promise<void> {
  const queue = selectedForOps();
  if (!queue.length) return;
  const label = clipCurrentBtn.querySelector(".primary-label") as HTMLElement | null;
  const restore = (text: string, ms: number) => {
    if (label) label.textContent = text;
    setTimeout(() => {
      if (label) label.textContent = "Devour";
      clearDevourProgress();
      state.clipping = false;
      render();
    }, ms);
  };

  if (!state.settings?.obsidianVault.trim()) {
    if (label) label.textContent = "Set vault first";
    state.clipping = true;
    clipCurrentBtn.disabled = true;
    restore("Devour", 2200);
    return;
  }

  state.clipping = true;
  clipCurrentBtn.disabled = true;
  setDevourProgress(0, queue.length);

  const tabIds = queue.map((t) => t.id);
  const res = await sendMessage<ClipSelectedTabsResponse>({
    type: "clip-selected-tabs",
    tabIds,
  });

  if (!res) {
    restore("Devour failed", 1800);
    return;
  }
  if (res.vaultMissing) {
    restore("Set vault first", 2200);
    return;
  }
  mergeClipFailures(tabIds, res.failures);
  await refresh();
  const summary =
    res.failed === 0
      ? `Devoured ${res.succeeded}`
      : `Devoured ${res.succeeded}, ${res.failed} failed`;
  restore(summary, res.failed === 0 ? 1400 : 2400);
}

async function retryFailures(tabIds: number[]): Promise<void> {
  if (state.clipping || !tabIds.length) return;
  if (!state.settings?.obsidianVault.trim()) return;
  state.clipping = true;
  render();
  const res = await sendMessage<ClipSelectedTabsResponse>({
    type: "clip-selected-tabs",
    tabIds,
  });
  if (res && !res.vaultMissing) {
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
  const original = dedupBtn.textContent ?? "Dedup";
  dedupBtn.textContent = "Closing…";
  try {
    const res = await sendMessage<CloseDuplicatesResponse>({ type: "close-duplicates" });
    await refresh();
    if (res && res.closed > 0) {
      showUndoToast(res.closed, res.restorable);
    }
  } finally {
    dedupBtn.textContent = original;
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

/* ---------- keyboard ---------- */

function focusableTabIds(): number[] {
  const groups = visibleGroups(state.scopedTabs, state.filter, state.stickyHostOrder);
  return visibleTabIds(groups);
}

function moveFocus(delta: number): void {
  const ids = focusableTabIds();
  if (!ids.length) return;
  if (state.focusedTabId === null) {
    setFocusedTab(ids[delta >= 0 ? 0 : ids.length - 1]!);
    return;
  }
  const idx = ids.indexOf(state.focusedTabId);
  if (idx === -1) {
    setFocusedTab(ids[0]!);
    return;
  }
  const next = (idx + delta + ids.length) % ids.length;
  setFocusedTab(ids[next]!);
  const row = groupsEl.querySelector<HTMLDivElement>(`.tab[data-tab-id="${ids[next]}"]`);
  row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function toggleFocusedSelection(): void {
  if (state.focusedTabId === null) return;
  if (state.selected.has(state.focusedTabId)) {
    state.selected.delete(state.focusedTabId);
  } else {
    state.selected.add(state.focusedTabId);
  }
  render();
}

document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  const inField = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;

  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (inField) return;
    e.preventDefault();
    filterInput.focus();
    filterInput.select();
    return;
  }
  if (e.key === "Escape" && inField) {
    filterInput.blur();
    return;
  }
  if (inField) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case "j":
    case "ArrowDown":
      e.preventDefault();
      moveFocus(1);
      break;
    case "k":
    case "ArrowUp":
      e.preventDefault();
      moveFocus(-1);
      break;
    case " ":
    case "Enter":
      e.preventDefault();
      toggleFocusedSelection();
      break;
    case "d":
    case "D":
      e.preventDefault();
      if (!clipCurrentBtn.disabled) void clipSelected();
      break;
    case "x":
    case "X":
      e.preventDefault();
      if (!closeSelectedBtn.disabled) void closeSelected();
      break;
  }
});

dedupBtn.addEventListener("click", () => void runDedup());
optionsBtn.addEventListener("click", () => void browser.runtime.openOptionsPage());
filterInput.addEventListener("input", () => {
  state.filter = filterInput.value;
  state.stickyHostOrder = null;
  render();
});
selectAllBtn.addEventListener("click", () => {
  const groups = visibleGroups(state.scopedTabs, state.filter, state.stickyHostOrder);
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

// Keep this listener synchronous. An async listener returns a Promise for every
// message, including messages it does not handle, which can claim the response
// before the background page answers requests such as `get-scoped-tabs`.
browser.runtime.onMessage.addListener((raw: unknown): void => {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as { type?: string; completed?: number; total?: number };
  if (msg.type === "refresh-cockpit") {
    void refresh();
  } else if (
    msg.type === "clip-progress" &&
    typeof msg.completed === "number" &&
    typeof msg.total === "number"
  ) {
    setDevourProgress(msg.completed, msg.total);
  }
});

void loadLogoMark();
document.body.classList.add("initial-load");
void refresh().then(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove("initial-load");
    });
  });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
