import type {
  ApplyGroupingResponse,
  ClipFailure,
  ClipSelectedTabsResponse,
  ClosedTabRecord,
  CloseDuplicatesResponse,
  GetScopedTabsResponse,
  PopupTab,
} from "../src/background.js";
import { planGrouping, plannedTabCount, type GroupingPlan } from "../src/grouping.js";
import { openOptionsUi } from "../src/open-options.js";
import { CLIP_ORIGINS, DOWNLOADS_GONE, requestOrigins } from "../src/permissions.js";
import { pickRule, ruleLabel, type SiteRule } from "../src/site-rules.js";
import {
  clipNeedsPageAccess,
  clipsToFile,
  hasClipDestination,
  type Settings,
} from "../src/storage.js";
import {
  clipSummary,
  computeDedupCount,
  extraTabIds,
  hostInitial,
  hostOf,
  markdownForTabs,
  reasonLabel,
  ruleMark,
  selectedTabsInUiOrder,
  sendMessage,
  type TabGroup,
  trackChromeHeights,
  trackScrollLift,
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
  stickyOrder: string[] | null;
  /** The grouping plan on preview. Apply sends exactly this; Cancel drops it. */
  groupPlan: GroupingPlan | null;
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
const groupTabsBtn = document.getElementById("group-tabs") as HTMLButtonElement;
const groupPreviewEl = document.getElementById("group-preview") as HTMLElement;
const groupPreviewCountEl = document.getElementById("group-preview-count") as HTMLSpanElement;
const groupPreviewListEl = document.getElementById("group-preview-list") as HTMLUListElement;
const groupPreviewNoteEl = document.getElementById("group-preview-note") as HTMLParagraphElement;
const groupApplyBtn = document.getElementById("group-apply") as HTMLButtonElement;
const groupCancelBtn = document.getElementById("group-cancel") as HTMLButtonElement;

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
  stickyOrder: null,
  groupPlan: null,
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
    sel === "all" ? "Deselect these tabs" : dup ? "Select every copy but the one Dedup keeps" : "";
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

  const marks = renderMarks(tab, group);
  if (marks) row.append(marks);

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

/* ---------- rule grouping ---------- */

/**
 * The preview is the whole contract with the user: silently reordering a few
 * hundred tabs is alarming even though it is non-destructive, so nothing is
 * grouped until this panel has shown exactly what will move — and Apply sends
 * the previewed plan itself, not a fresh computation that could have drifted.
 */
function previewGrouping(): void {
  if (!state.settings) return;
  state.groupPlan = planGrouping(
    state.scopedTabs,
    state.settings.siteRules,
    state.settings.groupingSkipList,
  );
  renderGroupPreview();
}

function discardGroupPreview(): void {
  state.groupPlan = null;
  renderGroupPreview();
}

function windowLabelsNeeded(plan: GroupingPlan): boolean {
  return new Set(plan.groups.map((g) => g.windowId)).size > 1;
}

function renderGroupPreview(): void {
  const plan = state.groupPlan;
  if (!plan) {
    groupPreviewEl.hidden = true;
    groupPreviewListEl.replaceChildren();
    return;
  }
  groupPreviewEl.hidden = false;

  const moved = plannedTabCount(plan);
  groupPreviewCountEl.hidden = moved === 0;
  groupPreviewCountEl.textContent = String(moved);
  groupApplyBtn.disabled = moved === 0;

  const multiWindow = windowLabelsNeeded(plan);
  const rows = plan.groups.map((g) => {
    const li = document.createElement("li");
    li.className = "group-preview-row";
    const swatch = document.createElement("span");
    swatch.className = `group-swatch swatch-${g.color}`;
    const name = document.createElement("span");
    name.className = "group-preview-name";
    name.textContent = g.name;
    const count = document.createElement("span");
    count.className = "group-preview-tabs";
    count.textContent =
      `${g.tabIds.length} ${g.tabIds.length === 1 ? "tab" : "tabs"}` +
      (multiWindow ? ` · window ${g.windowId}` : "");
    li.append(swatch, name, count);
    return li;
  });
  groupPreviewListEl.replaceChildren(...rows);

  const notes: string[] = [];
  if (moved === 0) {
    notes.push(
      "Nothing to group — no rule with a group matches this scope. Give a rule a group in Settings.",
    );
  }
  if (plan.pinnedExcluded > 0) {
    notes.push(
      `${plan.pinnedExcluded} pinned ${plan.pinnedExcluded === 1 ? "tab" : "tabs"} excluded — grouping would unpin them.`,
    );
  }
  if (plan.skippedBySkipList > 0) {
    notes.push(`${plan.skippedBySkipList} parked by the skip list.`);
  }
  if (plan.unmatched > 0 && moved > 0) {
    notes.push(
      `${plan.unmatched} unmatched ${plan.unmatched === 1 ? "tab stays" : "tabs stay"} put.`,
    );
  }
  groupPreviewNoteEl.textContent = notes.join(" ");
  groupPreviewNoteEl.hidden = notes.length === 0;
}

async function applyGroupPreview(): Promise<void> {
  const plan = state.groupPlan;
  if (!plan || plannedTabCount(plan) === 0) return;
  groupApplyBtn.disabled = true;
  const res = await sendMessage<ApplyGroupingResponse>({
    type: "apply-grouping",
    groups: plan.groups,
  });
  if (!res) {
    groupPreviewNoteEl.textContent = "Grouping failed — the background page did not answer.";
    groupApplyBtn.disabled = false;
    return;
  }
  if (res.unsupported) {
    // A stated fact, in the panel that asked: nothing moved.
    groupPreviewNoteEl.textContent = res.unsupported;
    groupApplyBtn.disabled = false;
    return;
  }
  discardGroupPreview();
  const original = groupTabsBtn.textContent;
  groupTabsBtn.textContent = `Grouped ${res.grouped}`;
  setTimeout(() => {
    groupTabsBtn.textContent = original;
  }, 1600);
  await refresh();
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
  // What a clip's path is rooted at. File mode writes into the browser's
  // download folder, which needs no setting up, so the setup prompt below
  // belongs only to an Obsidian destination that has no vault yet.
  const root = clipsToFile(state.settings)
    ? "Downloads"
    : (state.settings?.obsidianVault.trim() ?? "");

  // The pane only exists when it has something to say. With a destination set and
  // no tab focused it held nothing but a restatement of the footer's keyboard
  // legend, and reserved ~40% of the window to do it — the queue takes that
  // width instead.
  document.body.classList.toggle("inspecting", !root || tab !== null);

  if (!root) {
    inspectorEl.append(renderInspectorSetup());
    return;
  }
  if (!tab) return;
  inspectorEl.append(renderInspectorPreview(tab, root));
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
  btn.addEventListener("click", () => void openOptionsUi());
  div.append(h, p, btn);
  return div;
}

function renderInspectorPreview(tab: PopupTab, root: string): HTMLElement {
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

  const rule = tab.url && state.settings ? pickRule(tab.url, state.settings.siteRules) : null;
  const folder = targetFolder(rule);
  const fileName = sanitizeFileName(tab.title || tab.url || "Untitled");
  const disposition = rule?.disposition ?? "devour";

  const pathSection = document.createElement("section");
  pathSection.className = "inspector-section";
  const pathLabel = document.createElement("span");
  pathLabel.className = "inspector-section-label";
  pathLabel.textContent = disposition === "devour" ? "Will save to" : "On devour";
  const path = document.createElement("div");
  path.className = "inspector-path";
  if (disposition === "devour") {
    const rootEl = document.createElement("strong");
    rootEl.textContent = root;
    path.append(rootEl, ` / ${folder} / ${fileName}.md`);
  } else {
    // A rule that keeps, closes, or reroutes the tab means the save path above
    // would describe something that will not happen — say what will instead.
    path.textContent =
      disposition === "never-devour"
        ? "Kept open — a site rule keeps this site out of Devour."
        : disposition === "auto-close"
          ? "Closed without saving — a site rule."
          : "Saved to Zotero through its Connector — a site rule.";
  }
  pathSection.append(pathLabel, path);
  wrap.append(pathSection);

  // Only a tab that will actually become a note gets a frontmatter preview —
  // under "Kept open" or "Closed without saving" it would preview a note the
  // rule just said will not exist.
  if (disposition === "devour") {
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
  }

  const metaSection = document.createElement("section");
  metaSection.className = "inspector-section";
  const metaLabel = document.createElement("span");
  metaLabel.className = "inspector-section-label";
  metaLabel.textContent = "Routing";
  const dl = document.createElement("dl");
  dl.className = "inspector-meta";
  addDef(dl, "Host", hostOf(tab.url));
  addDef(dl, "Rule", rule ? ruleLabel(rule) : "default");
  if (disposition === "devour") {
    // A folder row under a disposition that files nothing would name a place
    // nothing will go.
    addDef(dl, "Folder", folder);
  } else {
    addDef(dl, "Disposition", ruleMark(disposition).label);
  }
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
  items.forEach((li, idx) => li.style.setProperty("--i", String(Math.min(idx, 12))));
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
  // Captured rather than cleared: the button carries a static tooltip from
  // devour.html, and blanking it would cost every later hover of the session to
  // explain one refusal.
  const originalTitle = clipCurrentBtn.title;
  const restore = (text: string, ms: number) => {
    if (label) label.textContent = text;
    setTimeout(() => {
      if (label) label.textContent = "Devour";
      clipCurrentBtn.title = originalTitle;
      clearDevourProgress();
      state.clipping = false;
      render();
    }, ms);
  };

  if (!hasClipDestination(state.settings)) {
    if (label) label.textContent = "Set vault first";
    state.clipping = true;
    clipCurrentBtn.disabled = true;
    restore("Devour", 2200);
    return;
  }

  // The first await in this handler, deliberately: Chrome gates
  // permissions.request on the click's transient activation, so any earlier
  // await would spend it and the request would reject as gesture-less. Held
  // already (always, on Firefox) this resolves true without showing anything.
  // `clipNeedsPageAccess` guards it because a Zotero-only run never injects
  // Defuddle — it has to stay synchronous for the same reason.
  if (clipNeedsPageAccess(state.settings) && !(await requestOrigins(CLIP_ORIGINS))) {
    state.clipping = true;
    clipCurrentBtn.disabled = true;
    restore("Needs site access", 2600);
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
  if (res.blocked === "downloads-revoked") {
    clipCurrentBtn.title = DOWNLOADS_GONE;
    restore("Needs downloads", 2600);
    return;
  }
  if (res.blocked) {
    restore("Set vault first", 2200);
    return;
  }
  mergeClipFailures(tabIds, res.failures);
  await refresh();
  // Rule-driven closes get the same undo the dedup button offers — a rule the
  // user wrote is still a close they may want back.
  if (res.ruleClosed > 0) showUndoToast(res.ruleClosed, res.ruleClosedRestorable);
  restore(clipSummary(res), res.failed === 0 ? 1400 : 2400);
}

/**
 * Say something on the primary button without owning the clipping state the way
 * `clipSelected`'s own `restore` does. Nothing else writes that label, so the
 * flash survives the re-render `refresh()` triggers underneath it.
 */
function flashPrimary(text: string, title: string, ms: number): void {
  const label = clipCurrentBtn.querySelector(".primary-label") as HTMLElement | null;
  const originalTitle = clipCurrentBtn.title;
  if (label) label.textContent = text;
  clipCurrentBtn.title = title;
  setTimeout(() => {
    if (label) label.textContent = "Devour";
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
  // A blocked run attempted nothing, so there are no fresh outcomes to merge —
  // and saying nothing would leave the old failures on screen looking retried.
  // Reachable only since `downloads-revoked`: with no destination at all there
  // are no failures to retry in the first place.
  if (res?.blocked === "downloads-revoked") flashPrimary("Needs downloads", DOWNLOADS_GONE, 2600);
  else if (res && !res.blocked) mergeClipFailures(tabIds, res.failures);
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
  const groups = visibleGroups(state.scopedTabs, state.filter, state.settings, state.stickyOrder);
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
groupTabsBtn.addEventListener("click", () => previewGrouping());
groupApplyBtn.addEventListener("click", () => void applyGroupPreview());
groupCancelBtn.addEventListener("click", () => discardGroupPreview());
optionsBtn.addEventListener("click", () => void openOptionsUi());
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
trackChromeHeights(
  document.body,
  document.getElementById("chrome-top"),
  document.getElementById("chrome-bottom"),
);
trackScrollLift(document.body, [
  document.querySelector<HTMLElement>(".queue"),
  document.querySelector<HTMLElement>(".cockpit-main"),
]);
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
