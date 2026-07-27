import type { BridgeStatusChangedMessage, GetBridgeStatusResponse } from "../src/background.js";
import type { BridgeStatus } from "../src/bridge-client.js";
import { DEFAULT_BRIDGE_PORT, generateToken, isBridgePort } from "../src/bridge-protocol.js";
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

/**
 * `save()` persists the whole settings object from DOM state, so it must never
 * run before `load()` has populated it — an empty `bridgeToken` field would be
 * written over a real token, revoking the bridge as a side effect of touching
 * an unrelated switch. Flipping the toggle is enough to trigger it, because the
 * change listener saves directly.
 */
let loaded = false;

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
  loaded = true;
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
  if (!loaded) return;
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
    // Only ever written when we have one. The field is readonly and Generate is
    // the sole way to set it, so an empty value means "not populated", never
    // "the user cleared it" — and writing it back would silently revoke the
    // sidecar's access.
    ...(bridgeToken.value ? { bridgeToken: bridgeToken.value } : {}),
  });
  flashStatus("Saved");
}

function parsePort(raw: string): number {
  // Fall back rather than persist a value the sidecar could never listen on.
  const port = Number.parseInt(raw, 10);
  return isBridgePort(port) ? port : DEFAULT_BRIDGE_PORT;
}

/** Text inputs save on a trailing edge, so a save is not issued per keystroke. */
function queueSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
}

for (const el of [stripFragment, bridgeEnabled, ...scopeRadios, ...clipModeRadios]) {
  el.addEventListener("change", () => void save());
}
extraStripParams.addEventListener("input", queueSave);
obsidianVault.addEventListener("input", () => {
  updateVaultWarning();
  queueSave();
});
clippingsBaseFolder.addEventListener("input", queueSave);

// ---------- agent bridge ----------

bridgePort.addEventListener("input", () => {
  updateBridgeSnippet();
  queueSave();
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
  // Named "tabglutton" rather than "gullet": this key becomes the tool
  // namespace the agent sees, and users know the product by one name.
  return JSON.stringify(
    {
      mcpServers: {
        tabglutton: {
          command: "bun",
          args: ["run", "/path/to/tabglutton/gullet/gullet.ts", "--port", String(port)],
          env: { TABGLUTTON_TOKEN: token },
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

const BRIDGE_STATUS_LABELS: Record<BridgeStatus, string> = {
  disabled: "Off",
  idle: "Waiting for a sidecar",
  connecting: "Connecting…",
  connected: "Connected",
};

function renderBridgeStatus(status: BridgeStatus): void {
  bridgeStatusEl.textContent = BRIDGE_STATUS_LABELS[status];
  bridgeStatusEl.dataset.state = status;
}

async function refreshBridgeStatus(): Promise<void> {
  let status: BridgeStatus = "disabled";
  try {
    const res = (await browser.runtime.sendMessage({ type: "get-bridge-status" })) as
      | GetBridgeStatusResponse
      | undefined;
    if (res) status = res.status;
  } catch {
    // Background asleep or restarting; infer from the settings we rendered
    // rather than showing an error the user cannot act on. This mirrors
    // BridgeClient.isConfigured() — enabled *and* holding a token — because
    // guessing from the toggle alone reports "waiting" for a bridge that has
    // no token and is therefore not dialling at all.
    status = bridgeEnabled.checked && bridgeToken.value ? "idle" : "disabled";
  }
  renderBridgeStatus(status);
}

// The background pushes every transition, so this page never polls — on Chrome
// MV3 a poll would keep the service worker awake for as long as it is open.
browser.runtime.onMessage.addListener((raw: unknown) => {
  const msg = raw as Partial<BridgeStatusChangedMessage> | null;
  if (msg?.type === "bridge-status-changed" && msg.status) renderBridgeStatus(msg.status);
});
// Resync on return to the tab, in case a push landed while it was hidden.
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

// Sequenced, not fired in parallel: refreshBridgeStatus() falls back to reading
// the rendered settings when the background is asleep, which is the normal case
// on MV3 when this page opens. Racing it against load() meant that fallback read
// an unpopulated checkbox and reported "Off" for a bridge that was connected.
void (async () => {
  await load();
  await refreshBridgeStatus();
})();
