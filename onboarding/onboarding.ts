// `browser` is global: native on Firefox; on Chrome the bundle entry loads the
// webextension-polyfill global first (see writePolyfillGlobal in build.ts). A
// bare "webextension-polyfill" import here would not set the global anyway.
import { loadSettings, saveSettings } from "../src/storage.js";
import { BUILT_IN_RULES } from "../src/site-rules.js";
import { IS_CHROME } from "../src/target.js";
import { vaultWarningFor } from "../src/vault-warning.js";

const TOTAL_STEPS = 4;

const stepperItems = document.querySelectorAll<HTMLLIElement>("[data-step-indicator]");
const panels = document.querySelectorAll<HTMLElement>(".panel");
const backBtn = document.getElementById("backBtn") as HTMLButtonElement;
const nextBtn = document.getElementById("nextBtn") as HTMLButtonElement;
const doneBtn = document.getElementById("doneBtn") as HTMLButtonElement;
const vaultInput = document.getElementById("obsidianVault") as HTMLInputElement;
const vaultWarning = document.getElementById("vaultWarning") as HTMLParagraphElement;
const approveLink = document.getElementById("approveLink") as HTMLAnchorElement;
const rulesList = document.getElementById("rulesList") as HTMLUListElement;

let currentStep = 1;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function showStep(step: number): void {
  currentStep = step;
  for (const panel of panels) {
    const panelStep = Number(panel.dataset.step);
    panel.hidden = panelStep !== step;
    if (panelStep === step) panel.setAttribute("data-active", "");
    else panel.removeAttribute("data-active");
  }
  for (const item of stepperItems) {
    const indicatorStep = Number(item.dataset.stepIndicator);
    item.removeAttribute("data-active");
    item.removeAttribute("data-done");
    if (indicatorStep === step) item.setAttribute("data-active", "");
    else if (indicatorStep < step) item.setAttribute("data-done", "");
  }
  backBtn.hidden = step === 1;
  nextBtn.hidden = step === TOTAL_STEPS;
  doneBtn.hidden = step !== TOTAL_STEPS;
  updateNextEnabled();
  if (step === 3) refreshApproveLink();
}

function updateNextEnabled(): void {
  if (currentStep === 2) {
    const ok = vaultInput.value.trim().length > 0;
    nextBtn.disabled = !ok;
  } else {
    nextBtn.disabled = false;
  }
}

function updateVaultWarning(): void {
  const msg = vaultWarningFor(vaultInput.value);
  vaultWarning.textContent = msg;
  vaultWarning.hidden = !msg;
}

function refreshApproveLink(): void {
  const vault = vaultInput.value.trim();
  if (vault) {
    approveLink.href = `obsidian://open?vault=${encodeURIComponent(vault)}`;
    approveLink.removeAttribute("aria-disabled");
    approveLink.textContent = `Open "${vault}" in Obsidian`;
  } else {
    approveLink.href = "#";
    approveLink.setAttribute("aria-disabled", "true");
    approveLink.textContent = "Enter a vault name in step 2 first";
  }
}

function renderRules(): void {
  rulesList.innerHTML = "";
  for (const rule of BUILT_IN_RULES) {
    const li = document.createElement("li");
    const hosts = document.createElement("span");
    hosts.className = "rule-host";
    hosts.textContent = rule.hostMatches.join(", ");
    const arrow = document.createElement("span");
    arrow.className = "rule-arrow";
    arrow.textContent = "→";
    const folder = document.createElement("span");
    folder.className = "rule-folder";
    folder.textContent = `Clippings/${rule.subfolder}/`;
    li.append(hosts, arrow, folder);
    rulesList.append(li);
  }
  const fallback = document.createElement("li");
  const fhost = document.createElement("span");
  fhost.className = "rule-host";
  fhost.textContent = "everything else";
  const farrow = document.createElement("span");
  farrow.className = "rule-arrow";
  farrow.textContent = "→";
  const ffolder = document.createElement("span");
  ffolder.className = "rule-folder";
  ffolder.textContent = "Clippings/";
  fallback.append(fhost, farrow, ffolder);
  rulesList.append(fallback);
}

vaultInput.addEventListener("input", () => {
  updateVaultWarning();
  updateNextEnabled();
  refreshApproveLink();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveSettings({ obsidianVault: vaultInput.value.trim() });
  }, 400);
});

backBtn.addEventListener("click", () => {
  if (currentStep > 1) showStep(currentStep - 1);
});

nextBtn.addEventListener("click", () => {
  if (currentStep < TOTAL_STEPS) showStep(currentStep + 1);
});

doneBtn.addEventListener("click", async () => {
  doneBtn.disabled = true;
  await saveSettings({
    obsidianVault: vaultInput.value.trim(),
    onboardingComplete: true,
  });
  try {
    const current = await browser.tabs.getCurrent();
    if (current?.id !== undefined) {
      await browser.tabs.remove(current.id);
      return;
    }
  } catch {
    // fall through to close()
  }
  window.close();
});

function applyTargetCopy(): void {
  if (!IS_CHROME) return;
  const ffStep3 = document.getElementById("step3-firefox");
  const chromeStep3 = document.getElementById("step3-chrome");
  const ffHelp = document.getElementById("firefoxStep3Help");
  if (ffStep3) ffStep3.hidden = true;
  if (ffHelp) ffHelp.hidden = true;
  if (chromeStep3) chromeStep3.hidden = false;
}

async function init(): Promise<void> {
  applyTargetCopy();
  const settings = await loadSettings();
  vaultInput.value = settings.obsidianVault;
  updateVaultWarning();
  renderRules();
  refreshApproveLink();
  showStep(1);
}

void init();
