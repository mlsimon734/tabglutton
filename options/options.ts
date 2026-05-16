import type { ScopeMode, Settings } from "../src/storage.js";
import { vaultWarningFor } from "../src/vault-warning.js";

const stripFragment = document.getElementById("stripFragment") as HTMLInputElement;
const extraStripParams = document.getElementById("extraStripParams") as HTMLInputElement;
const obsidianVault = document.getElementById("obsidianVault") as HTMLInputElement;
const vaultWarning = document.getElementById("vaultWarning") as HTMLParagraphElement;
const scopeRadios = document.querySelectorAll<HTMLInputElement>('input[name="scope"]');
const statusEl = document.getElementById("status") as HTMLParagraphElement;

const DEFAULTS: Pick<Settings, "stripFragment" | "extraStripParams" | "scope" | "obsidianVault"> = {
  stripFragment: true,
  extraStripParams: [],
  scope: "hidden-false",
  obsidianVault: "",
};

function parseParams(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function load(): Promise<void> {
  const stored = (await browser.storage.local.get(Object.keys(DEFAULTS))) as Partial<Settings>;
  const settings = { ...DEFAULTS, ...stored };
  stripFragment.checked = settings.stripFragment;
  extraStripParams.value = (settings.extraStripParams ?? []).join(", ");
  obsidianVault.value = settings.obsidianVault;
  updateVaultWarning();
  for (const radio of scopeRadios) {
    radio.checked = radio.value === settings.scope;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function flashStatus(msg: string): void {
  statusEl.textContent = msg;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    statusEl.textContent = "";
  }, 1200);
}

async function save(): Promise<void> {
  const checked = [...scopeRadios].find((r) => r.checked);
  const scope: ScopeMode = (checked?.value as ScopeMode) ?? "hidden-false";
  await browser.storage.local.set({
    stripFragment: stripFragment.checked,
    extraStripParams: parseParams(extraStripParams.value),
    scope,
    obsidianVault: obsidianVault.value.trim(),
  });
  flashStatus("Saved");
}

for (const el of [stripFragment, ...scopeRadios]) {
  el.addEventListener("change", () => void save());
}
extraStripParams.addEventListener("input", () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
});
obsidianVault.addEventListener("input", () => {
  updateVaultWarning();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
});

function updateVaultWarning(): void {
  const msg = vaultWarningFor(obsidianVault.value);
  vaultWarning.textContent = msg;
  vaultWarning.hidden = !msg;
}

const rerunLink = document.getElementById("rerunOnboarding") as HTMLAnchorElement | null;
rerunLink?.addEventListener("click", async (e) => {
  e.preventDefault();
  await browser.storage.local.set({ onboardingComplete: false });
  await browser.tabs.create({ url: browser.runtime.getURL("onboarding/onboarding.html") });
});

void load();
