import type { GetBridgeStatusResponse } from "../src/background.js";
import { DEFAULT_BRIDGE_PORT, generateToken } from "../src/bridge-protocol.js";
import type { ClipMode, ScopeMode, Settings } from "../src/storage.js";
import { IS_CHROME } from "../src/target.js";
import { vaultWarningFor } from "../src/vault-warning.js";

const FALLBACK_SCOPE: ScopeMode = IS_CHROME ? "current-window" : "hidden-false";

const stripFragment = document.getElementById("stripFragment") as HTMLInputElement;
const extraStripParams = document.getElementById("extraStripParams") as HTMLInputElement;
const obsidianVault = document.getElementById("obsidianVault") as HTMLInputElement;
const clippingsBaseFolder = document.getElementById("clippingsBaseFolder") as HTMLInputElement;
const vaultWarning = document.getElementById("vaultWarning") as HTMLParagraphElement;
const scopeRadios = document.querySelectorAll<HTMLInputElement>('input[name="scope"]');
const clipModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="clipMode"]');
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const bridgeEnabled = document.getElementById("bridgeEnabled") as HTMLInputElement;
const bridgePort = document.getElementById("bridgePort") as HTMLInputElement;
const bridgeToken = document.getElementById("bridgeToken") as HTMLInputElement;
const bridgeTokenCopy = document.getElementById("bridgeTokenCopy") as HTMLButtonElement;
const bridgeTokenGenerate = document.getElementById("bridgeTokenGenerate") as HTMLButtonElement;
const bridgeStatusEl = document.getElementById("bridgeStatus") as HTMLSpanElement;
const bridgeSnippet = document.getElementById("bridgeSnippet") as HTMLPreElement;
const bridgeSnippetCopy = document.getElementById("bridgeSnippetCopy") as HTMLButtonElement;

const DEFAULTS: Pick<
  Settings,
  | "stripFragment"
  | "extraStripParams"
  | "scope"
  | "obsidianVault"
  | "clippingsBaseFolder"
  | "clipMode"
  | "bridgeEnabled"
  | "bridgePort"
  | "bridgeToken"
> = {
  stripFragment: true,
  extraStripParams: [],
  scope: FALLBACK_SCOPE,
  obsidianVault: "",
  clippingsBaseFolder: "",
  clipMode: "clipboard",
  bridgeEnabled: false,
  bridgePort: DEFAULT_BRIDGE_PORT,
  bridgeToken: "",
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
  clippingsBaseFolder.value = settings.clippingsBaseFolder;
  updateVaultWarning();
  for (const radio of scopeRadios) {
    radio.checked = radio.value === settings.scope;
  }
  for (const radio of clipModeRadios) {
    radio.checked = radio.value === settings.clipMode;
  }
  bridgeEnabled.checked = settings.bridgeEnabled;
  bridgePort.value = String(settings.bridgePort);
  bridgeToken.value = settings.bridgeToken;
  updateBridgeSnippet();
  if (IS_CHROME) {
    // Chrome has no tab.hidden / workspaces, so the scope choice is fixed.
    const scopeBlock = scopeRadios[0]?.closest(".setting.block") as HTMLElement | null;
    if (scopeBlock) scopeBlock.hidden = true;
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
  const scope: ScopeMode = (checked?.value as ScopeMode) ?? FALLBACK_SCOPE;
  const checkedClipMode = [...clipModeRadios].find((r) => r.checked);
  const clipMode: ClipMode = (checkedClipMode?.value as ClipMode) ?? "clipboard";
  await browser.storage.local.set({
    stripFragment: stripFragment.checked,
    extraStripParams: parseParams(extraStripParams.value),
    scope,
    obsidianVault: obsidianVault.value.trim(),
    clippingsBaseFolder: clippingsBaseFolder.value.trim(),
    clipMode,
    bridgeEnabled: bridgeEnabled.checked,
    bridgePort: parsePort(bridgePort.value),
    bridgeToken: bridgeToken.value,
  });
  flashStatus("Saved");
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  // Sub-1024 needs root to bind and 65535 is the ceiling; fall back rather than
  // persist a value the sidecar could never listen on.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return DEFAULT_BRIDGE_PORT;
  return port;
}

for (const el of [stripFragment, bridgeEnabled, ...scopeRadios, ...clipModeRadios]) {
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
clippingsBaseFolder.addEventListener("input", () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
});

// ---------- agent bridge ----------

bridgePort.addEventListener("input", () => {
  updateBridgeSnippet();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
});

bridgeTokenGenerate.addEventListener("click", () => {
  bridgeToken.value = generateToken();
  updateBridgeSnippet();
  void save();
});

bridgeTokenCopy.addEventListener("click", () => {
  if (!bridgeToken.value) {
    flashStatus("No token yet");
    return;
  }
  void copyText(bridgeToken.value, "Token copied");
});

bridgeSnippetCopy.addEventListener("click", () => {
  void copyText(bridgeSnippetText(), "Config copied");
});

async function copyText(text: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flashStatus(okMessage);
  } catch (err) {
    console.warn("[tabglutton] clipboard write failed", err);
    flashStatus("Copy failed");
  }
}

function bridgeSnippetText(): string {
  const port = parsePort(bridgePort.value);
  const token = bridgeToken.value || "<generate a token above>";
  return JSON.stringify(
    {
      mcpServers: {
        gullet: {
          command: "bun",
          args: ["run", "/path/to/tabglutton/gullet/gullet.ts", "--port", String(port)],
          env: { GULLET_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}

function updateBridgeSnippet(): void {
  const code = bridgeSnippet.querySelector("code");
  if (code) code.textContent = bridgeSnippetText();
}

const BRIDGE_STATUS_LABELS: Record<GetBridgeStatusResponse["status"], string> = {
  disabled: "Off",
  idle: "Waiting for a sidecar",
  connecting: "Connecting…",
  connected: "Connected",
};

async function refreshBridgeStatus(): Promise<void> {
  let status: GetBridgeStatusResponse["status"] = "disabled";
  try {
    const res = (await browser.runtime.sendMessage({ type: "get-bridge-status" })) as
      | GetBridgeStatusResponse
      | undefined;
    if (res) status = res.status;
  } catch {
    // Background asleep or restarting; treat as not connected and retry on the
    // next tick rather than showing an error the user cannot act on.
    status = bridgeEnabled.checked ? "idle" : "disabled";
  }
  bridgeStatusEl.textContent = BRIDGE_STATUS_LABELS[status];
  bridgeStatusEl.dataset.state = status;
}

// The socket lives in the background; there is no event to subscribe to from
// here, so poll while the options page is actually visible.
setInterval(() => {
  if (document.visibilityState === "visible") void refreshBridgeStatus();
}, 2000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshBridgeStatus();
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

const logoMark = document.getElementById("logo-mark");
if (logoMark) {
  void (async () => {
    try {
      const res = await fetch(browser.runtime.getURL("icons/logo-mark.svg"));
      if (!res.ok) return;
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      const svg = doc.documentElement;
      if (svg && svg.nodeName.toLowerCase() === "svg") {
        logoMark.replaceChildren(document.importNode(svg, true));
      }
    } catch (err) {
      console.warn("[tabglutton] logo load failed", err);
    }
  })();
}

void load();
void refreshBridgeStatus();
