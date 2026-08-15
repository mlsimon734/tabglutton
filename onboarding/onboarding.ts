// `browser` is global: native on Firefox; on Chrome the bundle entry loads the
// webextension-polyfill global first (see writePolyfillGlobal in build.ts). A
// bare "webextension-polyfill" import here would not set the global anyway.
import { type ClipDestination, loadSettings, saveSettings } from "../src/storage.js";
import { requestDownloads } from "../src/permissions.js";
import { BUILT_IN_RULES } from "../src/site-rules.js";
import { IS_CHROME } from "../src/target.js";
import { vaultWarningFor } from "../src/vault-warning.js";

/**
 * The walkthrough is a *sequence of keys*, not a count: the `obsidian` step is
 * the one page that bootstraps the external-protocol grant (see
 * `docs/ENGINEERING.md` §Obsidian launch), so it has to disappear entirely for
 * someone filing to plain files rather than sit there as a dead screen. Every
 * ordinal the user sees is derived from the visible sequence.
 */
const STEP_KEYS = ["welcome", "destination", "obsidian", "rules"] as const;
type StepKey = (typeof STEP_KEYS)[number];

const stepperItems = document.querySelectorAll<HTMLLIElement>("[data-step-indicator]");
const panels = document.querySelectorAll<HTMLElement>(".panel");
const backBtn = document.getElementById("backBtn") as HTMLButtonElement;
const nextBtn = document.getElementById("nextBtn") as HTMLButtonElement;
const doneBtn = document.getElementById("doneBtn") as HTMLButtonElement;
const destinationRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="clipDestination"]',
);
const downloadsWarning = document.getElementById("downloadsWarning") as HTMLParagraphElement;
const vaultBlock = document.getElementById("vaultBlock") as HTMLElement;
const vaultInput = document.getElementById("obsidianVault") as HTMLInputElement;
const vaultWarning = document.getElementById("vaultWarning") as HTMLParagraphElement;
const approveLink = document.getElementById("approveLink") as HTMLAnchorElement;
const rulesList = document.getElementById("rulesList") as HTMLUListElement;
const rulesScopeObsidian = document.getElementById("rulesScopeObsidian") as HTMLParagraphElement;
const rulesScopeFile = document.getElementById("rulesScopeFile") as HTMLParagraphElement;

let currentStep: StepKey = "welcome";
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function selectedDestination(): ClipDestination {
  return [...destinationRadios].find((radio) => radio.checked)?.value === "file"
    ? "file"
    : "obsidian";
}

function visibleSteps(): StepKey[] {
  const filing = selectedDestination();
  return STEP_KEYS.filter((key) => key !== "obsidian" || filing === "obsidian");
}

function showStep(requested: StepKey): void {
  const steps = visibleSteps();
  // A step can leave the sequence under the user's feet, and only the
  // destination choice can do that — so that is where to land if the step being
  // shown is no longer one of them. Without this `indexOf` returns -1 and the
  // nav reads as the first slot while showing a panel that is not in the list.
  const step = steps.includes(requested) ? requested : "destination";
  currentStep = step;
  const index = steps.indexOf(step);
  for (const panel of panels) {
    const active = panel.dataset.step === step;
    panel.hidden = !active;
    if (active) panel.setAttribute("data-active", "");
    else panel.removeAttribute("data-active");
  }
  for (const item of stepperItems) {
    const itemIndex = steps.indexOf(item.dataset.stepIndicator as StepKey);
    item.hidden = itemIndex === -1;
    item.removeAttribute("data-active");
    item.removeAttribute("data-done");
    if (itemIndex === index) item.setAttribute("data-active", "");
    else if (itemIndex !== -1 && itemIndex < index) item.setAttribute("data-done", "");
  }
  backBtn.hidden = index === 0;
  nextBtn.hidden = index === steps.length - 1;
  doneBtn.hidden = index !== steps.length - 1;
  renumberSteps();
  updateNextEnabled();
  if (step === "obsidian") refreshApproveLink();
}

/** Headings carry the ordinal of their place in the *visible* sequence. */
function renumberSteps(): void {
  const steps = visibleSteps();
  for (const panel of panels) {
    const ordinal = panel.querySelector(".step-ordinal");
    const index = steps.indexOf(panel.dataset.step as StepKey);
    if (ordinal && index !== -1) ordinal.textContent = `Step ${index + 1}`;
  }
}

function updateNextEnabled(): void {
  // The vault name is the one field that can block the walkthrough, and only
  // when the notes are actually going to a vault.
  const needsVault = currentStep === "destination" && selectedDestination() === "obsidian";
  nextBtn.disabled = needsVault && vaultInput.value.trim().length === 0;
}

/** Everything on the page that the destination decides. */
function applyDestination(): void {
  const filing = selectedDestination();
  vaultBlock.hidden = filing === "file";
  rulesScopeObsidian.hidden = filing === "file";
  rulesScopeFile.hidden = filing === "obsidian";
  // The choice rewrites the sequence itself — which stepper pills exist, what
  // the later ones are numbered, whether Next is blocked — so re-run the step
  // rather than patching the pieces and leaving the pills a step behind.
  showStep(currentStep);
}

function selectObsidian(): void {
  for (const radio of destinationRadios) radio.checked = radio.value === "obsidian";
}

// `downloads` is optional, and the destination click is the one moment in
// onboarding a user gesture exists to ask for it — the background page, where
// the writing happens, never has one. A refusal reverts to Obsidian rather than
// persisting a choice whose every clip could only fail, and says how to ask
// again; the same trade the options page makes, so nobody is left on a dead end.
for (const radio of destinationRadios) {
  radio.addEventListener("change", () => {
    void (async () => {
      // First await in the handler; see requestDownloads on why nothing precedes it.
      const refused = selectedDestination() === "file" && !(await requestDownloads());
      if (refused) selectObsidian();
      downloadsWarning.textContent = refused
        ? "Download access was declined, so files would have nowhere to go — the destination is back on Obsidian. Choose Markdown files again to ask once more."
        : "";
      downloadsWarning.hidden = !refused;
      applyDestination();
      // Also written on Done; persisted here so a walkthrough abandoned midway
      // does not silently keep the destination the user just moved off.
      await saveSettings({ clipDestination: selectedDestination() });
    })();
  });
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
    approveLink.textContent = "Enter a vault name on the destination step first";
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

function step(offset: number): void {
  const steps = visibleSteps();
  const next = steps[steps.indexOf(currentStep) + offset];
  if (next) showStep(next);
}

backBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));

doneBtn.addEventListener("click", async () => {
  doneBtn.disabled = true;
  await saveSettings({
    clipDestination: selectedDestination(),
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

/** Same inline-SVG fetch the popup, cockpit and options headers use. */
async function loadLogoMark(): Promise<void> {
  const logoMark = document.getElementById("logo-mark");
  if (!logoMark) return;
  try {
    const res = await fetch(browser.runtime.getURL("icons/logo-mark.svg"));
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), "image/svg+xml");
    const svg = doc.documentElement;
    if (svg && svg.nodeName.toLowerCase() === "svg") {
      logoMark.replaceChildren(document.importNode(svg, true));
    }
  } catch (err) {
    console.warn("[tabglutton] logo load failed", err);
  }
}

async function init(): Promise<void> {
  applyTargetCopy();
  void loadLogoMark();
  const settings = await loadSettings();
  for (const radio of destinationRadios) {
    radio.checked = radio.value === settings.clipDestination;
  }
  vaultInput.value = settings.obsidianVault;
  applyDestination();
  updateVaultWarning();
  renderRules();
  refreshApproveLink();
  showStep("welcome");
}

void init();
