import type {
  ClipFailure,
  ClipFailureReason,
  ClipSelectedTabsResponse,
  ClosedTabRecord,
  CloseDuplicatesResponse,
  GetScopedTabsResponse,
  PopupTab,
} from "../src/background.js";
import { normalizeUrl } from "../src/normalize.js";
import { normalizeOptsFrom, type Settings } from "../src/storage.js";

interface PopupState {
  scopedTabs: PopupTab[];
  settings: Settings | null;
  filter: string;
  selected: Set<number>;
  dedupCount: number;
  toast: ToastState | null;
  clipping: boolean;
  devourFailures: ClipFailure[];
}

interface ToastState {
  text: string;
  remainingSec: number;
  restorable: ClosedTabRecord[];
  intervalId: ReturnType<typeof setInterval> | null;
}

interface DomainGroup {
  host: string;
  tabs: PopupTab[];
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
const clipCurrentBtn = document.getElementById("clip-current") as HTMLButtonElement;
const copyUrlsBtn = document.getElementById("copy-urls") as HTMLButtonElement;
const closeSelectedBtn = document.getElementById("close-selected") as HTMLButtonElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;
const toastTextEl = document.getElementById("toast-text") as HTMLSpanElement;
const toastUndoBtn = document.getElementById("toast-undo") as HTMLButtonElement;
const shortcutHintEl = document.getElementById("shortcut-hint") as HTMLElement | null;
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
};

function hostOf(url: string | undefined): string {
  if (!url) return "(no url)";
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.hostname.replace(/^www\./, "");
    }
    return u.protocol.replace(/:$/, "");
  } catch {
    return "(invalid url)";
  }
}

function tokens(s: string): string[] {
  return s.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

function matchTokens(haystack: string, ts: string[]): boolean {
  if (ts.length === 0) return true;
  const lower = haystack.toLowerCase();
  return ts.every((t) => lower.includes(t));
}

function tabMatches(tab: PopupTab, ts: string[]): boolean {
  if (ts.length === 0) return true;
  return matchTokens(`${tab.url ?? ""}\n${tab.title ?? ""}`, ts);
}

function visibleGroups(): DomainGroup[] {
  const ts = tokens(state.filter);
  const byHost = new Map<string, PopupTab[]>();
  for (const tab of state.scopedTabs) {
    if (!tabMatches(tab, ts)) continue;
    const host = hostOf(tab.url);
    let bucket = byHost.get(host);
    if (!bucket) {
      bucket = [];
      byHost.set(host, bucket);
    }
    bucket.push(tab);
  }
  const groups: DomainGroup[] = [];
  for (const [host, tabs] of byHost) {
    tabs.sort((a, b) => (a.windowId ?? 0) - (b.windowId ?? 0) || a.index - b.index);
    groups.push({ host, tabs });
  }
  groups.sort((a, b) => b.tabs.length - a.tabs.length || a.host.localeCompare(b.host));
  return groups;
}

function visibleTabIds(groups: DomainGroup[]): number[] {
  const ids: number[] = [];
  for (const g of groups) {
    for (const t of g.tabs) ids.push(t.id);
  }
  return ids;
}

function escapeMarkdownText(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

function markdownForTabs(tabs: PopupTab[]): string {
  return tabs
    .filter((tab) => tab.url)
    .map((tab) => {
      const url = tab.url!;
      const title = escapeMarkdownText(tab.title?.trim() || url);
      return `- [${title}](${url})`;
    })
    .join("\n");
}

function computeDedupCount(): number {
  if (!state.settings) return 0;
  const opts = normalizeOptsFrom(state.settings);
  const counts = new Map<string, number>();
  for (const tab of state.scopedTabs) {
    const key = normalizeUrl(tab.url, opts);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let dups = 0;
  for (const n of counts.values()) {
    if (n > 1) dups += n - 1;
  }
  return dups;
}

function renderWarning(): void {
  const s = state.settings;
  if (s?.heuristicWarning && s.scope === "hidden-false") {
    warningEl.hidden = false;
    warningEl.textContent =
      "Workspace heuristic looks broken — Zen reports no hidden tabs. Switch scope to 'Current window only' in Options if dedup spans workspaces.";
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
    emptySubEl.textContent = `No tabs match "${state.filter}".`;
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

function renderGroup(group: DomainGroup): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "group";

  const header = document.createElement("div");
  header.className = "group-header";

  const sel = groupSelectionState(group);
  const selectBtn = document.createElement("button");
  selectBtn.className = `select-toggle ${sel}`;
  selectBtn.type = "button";
  selectBtn.textContent = sel === "all" ? "Deselect" : sel === "partial" ? "Select rest" : "Select";
  selectBtn.title =
    sel === "all" ? "Deselect all tabs in this group" : "Select all tabs in this group";
  selectBtn.addEventListener("click", () => {
    setGroupSelection(group, sel !== "all");
    render();
  });

  const hostEl = document.createElement("span");
  hostEl.className = "group-host";
  hostEl.textContent = group.host;

  const countEl = document.createElement("span");
  countEl.className = "group-count";
  countEl.textContent = `${group.tabs.length}`;

  header.append(selectBtn, hostEl, countEl);
  li.append(header);

  const tabsEl = document.createElement("div");
  tabsEl.className = "tabs";
  for (const tab of group.tabs) {
    tabsEl.append(renderTab(tab));
  }
  li.append(tabsEl);
  return li;
}

function renderTab(tab: PopupTab): HTMLDivElement {
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
  if (tab.favIconUrl) fav.style.backgroundImage = `url("${tab.favIconUrl}")`;

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

  if (tab.pinned) {
    const pinTag = document.createElement("span");
    pinTag.className = "pin-tag";
    pinTag.textContent = "pinned";
    row.append(pinTag);
  }

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
  selectionSummaryEl.textContent = `${selected} selected · ${total} total`;

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
  state.dedupCount = computeDedupCount();
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

function reasonLabel(reason: ClipFailureReason): string {
  switch (reason) {
    case "extract-failed":
      return "extract failed";
    case "trigger-failed":
      return "open failed";
    case "content-too-large":
      return "too large";
  }
}

function reasonTooltip(f: ClipFailure): string {
  if (f.reason === "content-too-large" && f.byteSize !== undefined) {
    return `${Math.round(f.byteSize / 1024)} KB exceeds obsidian:// URL limit`;
  }
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

function render(): void {
  renderWarning();
  const groups = visibleGroups();
  renderEmpty(groups);
  groupsEl.replaceChildren();
  groups.forEach((g, idx) => {
    const li = renderGroup(g);
    li.style.setProperty("--i", String(Math.min(idx, 10)));
    groupsEl.append(li);
  });
  renderSelectionSummary(visibleTabIds(groups));
  renderDedupBadge();
  renderToast();
  renderDevourFailures();
}

async function refresh(): Promise<void> {
  const res = (await browser.runtime.sendMessage({
    type: "get-scoped-tabs",
  })) as GetScopedTabsResponse | undefined;
  if (!res) return;
  state.scopedTabs = res.tabs;
  state.settings = res.settings;
  const live = new Set(state.scopedTabs.map((t) => t.id));
  for (const id of [...state.selected]) {
    if (!live.has(id)) state.selected.delete(id);
  }
  render();
}

async function focusTab(tabId: number): Promise<void> {
  await browser.runtime.sendMessage({ type: "focus-tab", tabId });
  window.close();
}

async function closeTabs(tabIds: number[]): Promise<void> {
  if (!tabIds.length) return;
  await browser.runtime.sendMessage({ type: "close-tabs", tabIds });
  for (const id of tabIds) state.selected.delete(id);
  await refresh();
}

function selectedTabsInUiOrder(): PopupTab[] {
  const groups = visibleGroups();
  const out: PopupTab[] = [];
  for (const g of groups) {
    for (const t of g.tabs) {
      if (state.selected.has(t.id)) out.push(t);
    }
  }
  return out;
}

async function copyUrls(): Promise<void> {
  const tabs = selectedTabsInUiOrder();
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
    console.warn("[tab-triage] clipboard failed", err);
    copyUrlsBtn.textContent = "Copy failed";
    setTimeout(() => {
      copyUrlsBtn.textContent = original;
      copyUrlsBtn.disabled = state.selected.size === 0;
    }, 1500);
  }
}

async function dispatchClipSelected(
  tabIds: number[],
): Promise<ClipSelectedTabsResponse | undefined> {
  try {
    return (await browser.runtime.sendMessage({
      type: "clip-selected-tabs",
      tabIds,
    })) as ClipSelectedTabsResponse | undefined;
  } catch (err) {
    console.warn("[tab-triage] clip dispatch failed", err);
    return undefined;
  }
}

function mergeClipFailures(retriedTabIds: number[], newFailures: ClipFailure[]): void {
  const retried = new Set(retriedTabIds);
  state.devourFailures = state.devourFailures.filter((f) => !retried.has(f.tabId));
  state.devourFailures.push(...newFailures);
}

async function clipSelected(): Promise<void> {
  const queue = selectedTabsInUiOrder();
  if (!queue.length) return;
  const original = clipCurrentBtn.textContent;
  const originalTitle = clipCurrentBtn.title;
  const restore = (text: string, ms: number) => {
    clipCurrentBtn.textContent = text;
    setTimeout(() => {
      clipCurrentBtn.textContent = original;
      clipCurrentBtn.title = originalTitle;
      state.clipping = false;
      render();
    }, ms);
  };

  if (!state.settings?.obsidianVault.trim()) {
    clipCurrentBtn.title = "Set Obsidian vault in Options first.";
    state.clipping = true;
    clipCurrentBtn.disabled = true;
    restore("Set vault", 2200);
    return;
  }

  state.clipping = true;
  clipCurrentBtn.disabled = true;
  clipCurrentBtn.title = "";
  clipCurrentBtn.textContent = `Clipping ${queue.length}…`;

  const tabIds = queue.map((t) => t.id);
  const res = await dispatchClipSelected(tabIds);

  if (!res) {
    restore("Clip failed", 1800);
    return;
  }
  if (res.vaultMissing) {
    restore("Set vault", 2200);
    return;
  }
  mergeClipFailures(tabIds, res.failures);
  await refresh();
  const summary =
    res.failed === 0
      ? `Clipped ${res.succeeded}`
      : `Clipped ${res.succeeded}, ${res.failed} failed`;
  restore(summary, res.failed === 0 ? 1400 : 2200);
}

async function retryFailures(tabIds: number[]): Promise<void> {
  if (state.clipping || !tabIds.length) return;
  if (!state.settings?.obsidianVault.trim()) return;
  state.clipping = true;
  render();
  const res = await dispatchClipSelected(tabIds);
  if (res && !res.vaultMissing) {
    mergeClipFailures(tabIds, res.failures);
  }
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
  const original = dedupBtn.textContent;
  dedupBtn.textContent = "Closing…";
  try {
    const res = (await browser.runtime.sendMessage({
      type: "close-duplicates",
    })) as CloseDuplicatesResponse | undefined;
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
  await browser.runtime.sendMessage({ type: "reopen-tabs", records });
  await refresh();
}

dedupBtn.addEventListener("click", () => void runDedup());
optionsBtn.addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
  window.close();
});
filterInput.addEventListener("input", () => {
  state.filter = filterInput.value;
  render();
});
selectAllBtn.addEventListener("click", () => {
  const groups = visibleGroups();
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

function prettifyShortcut(raw: string): string {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return raw
    .split("+")
    .map((part) => {
      const key = part.trim();
      if (!isMac) return key;
      switch (key) {
        case "Command":
        case "MacCtrl":
          return "⌘";
        case "Ctrl":
          return "⌃";
        case "Alt":
        case "Option":
          return "⌥";
        case "Shift":
          return "⇧";
        default:
          return key.length === 1 ? key.toUpperCase() : key;
      }
    })
    .join(isMac ? "" : "+");
}

async function renderShortcutHint(): Promise<void> {
  if (!shortcutHintEl) return;
  const fallback = prettifyShortcut("Alt+Shift+D");
  try {
    const commands = await browser.commands.getAll();
    const action = commands.find((c) => c.name === "_execute_action");
    const shortcut = action?.shortcut;
    shortcutHintEl.textContent = shortcut ? prettifyShortcut(shortcut) : fallback;
  } catch {
    shortcutHintEl.textContent = fallback;
  }
}

void renderShortcutHint();
document.body.classList.add("initial-load");
void refresh().then(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove("initial-load");
    });
  });
});
