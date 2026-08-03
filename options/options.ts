import type { BridgeStatusChangedMessage, GetBridgeStatusResponse } from "../src/background.js";
import type { BridgeStatus } from "../src/bridge-client.js";
import {
  CONFIG_DIR_NAME,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_TOKEN_FILE_NAME,
  generateToken,
  isBridgePort,
} from "../src/bridge-protocol.js";
import { BRIDGE_ORIGINS, requestOrigins } from "../src/permissions.js";
import {
  loadSettings,
  type BridgePortMode,
  type ClipMode,
  type ScopeMode,
} from "../src/storage.js";
import { IS_CHROME } from "../src/target.js";
import { vaultWarningFor } from "../src/vault-warning.js";

const FALLBACK_SCOPE: ScopeMode = IS_CHROME ? "current-window" : "hidden-false";

// Framed means the browser's own extension-settings panel is hosting us, and it
// draws its own frame, heading and padding. CSP forbids an inline script, so
// this lands one module-execution late — on a page this small, before paint.
if (window.top !== window.self) document.documentElement.classList.add("embedded");

const stripFragment = document.getElementById("stripFragment") as HTMLInputElement;
const extraStripParams = document.getElementById("extraStripParams") as HTMLInputElement;
const obsidianVault = document.getElementById("obsidianVault") as HTMLInputElement;
const clippingsBaseFolder = document.getElementById("clippingsBaseFolder") as HTMLInputElement;
const vaultWarning = document.getElementById("vaultWarning") as HTMLParagraphElement;
const scopeRadios = document.querySelectorAll<HTMLInputElement>('input[name="scope"]');
const clipModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="clipMode"]');
const optionsInTabRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="optionsInTab"]',
);
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const bridgeEnabled = document.getElementById("bridgeEnabled") as HTMLInputElement;
const bridgeAllowTabLoad = document.getElementById("bridgeAllowTabLoad") as HTMLInputElement;
const bridgePortModeRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="bridgePortMode"]',
);
const bridgeFixedPort = document.getElementById("bridgeFixedPort") as HTMLDivElement;
const bridgePort = document.getElementById("bridgePort") as HTMLInputElement;
const bridgeToken = document.getElementById("bridgeToken") as HTMLInputElement;
const bridgeTokenCopy = document.getElementById("bridgeTokenCopy") as HTMLButtonElement;
const bridgeTokenReveal = document.getElementById("bridgeTokenReveal") as HTMLButtonElement;
const bridgeTokenGenerate = document.getElementById("bridgeTokenGenerate") as HTMLButtonElement;
const bridgeStatusEl = document.getElementById("bridgeStatus") as HTMLSpanElement;
const bridgeSnippet = document.getElementById("bridgeSnippet") as HTMLPreElement;
const bridgeSnippetCopy = document.getElementById("bridgeSnippetCopy") as HTMLButtonElement;
const bridgeLaunchCommand = document.getElementById("bridgeLaunchCommand") as HTMLElement;

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
  const settings = await loadSettings();
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
  for (const radio of optionsInTabRadios) {
    radio.checked = (radio.value === "tab") === settings.optionsInTab;
  }
  bridgeEnabled.checked = settings.bridgeEnabled;
  bridgeAllowTabLoad.checked = settings.bridgeAllowTabLoad;
  for (const radio of bridgePortModeRadios) {
    radio.checked = radio.value === settings.bridgePortMode;
  }
  bridgePort.value = String(settings.bridgePort);
  bridgeToken.value = settings.bridgeToken;
  // Repaints the snippet itself, so no separate updateBridgeSnippet() here.
  updateBridgePortMode();
  if (IS_CHROME) {
    // Chrome has no tab.hidden / workspaces, so the scope choice is fixed.
    const scopeBlock = scopeRadios[0]?.closest(".setting.block") as HTMLElement | null;
    if (scopeBlock) scopeBlock.hidden = true;
    // Chrome's embedded options are a modal on chrome://extensions, too narrow
    // for this page, so the Chrome build stays on `open_in_tab: true` and there
    // is no choice to offer. The whole section goes, not just the radios.
    const layoutSection = document.getElementById("optionsLayout")?.closest("section");
    if (layoutSection) (layoutSection as HTMLElement).hidden = true;
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
  const bridgePortMode = selectedBridgePortMode();
  await browser.storage.local.set({
    stripFragment: stripFragment.checked,
    extraStripParams: parseParams(extraStripParams.value),
    scope,
    obsidianVault: obsidianVault.value.trim(),
    clippingsBaseFolder: clippingsBaseFolder.value.trim(),
    clipMode,
    optionsInTab: [...optionsInTabRadios].find((r) => r.checked)?.value !== "embedded",
    bridgeEnabled: bridgeEnabled.checked,
    bridgeAllowTabLoad: bridgeAllowTabLoad.checked,
    bridgePortMode,
    bridgePort: parsePort(bridgePort.value),
    // Still only written when we have one, now that the field is editable. An
    // empty box is ambiguous — mid-paste, or selected-and-deleted on the way to
    // typing — and persisting it would revoke the sidecar's access for what is
    // usually a keystroke rather than a decision. Turning the bridge off is the
    // toggle above; replacing the token is Generate or a paste. Neither needs
    // "empty" to mean anything.
    ...(bridgeToken.value.trim() ? { bridgeToken: bridgeToken.value.trim() } : {}),
  });
  flashStatus("Saved");
}

function parsePort(raw: string): number {
  // Fall back rather than persist a value the sidecar could never listen on.
  const value = raw.trim();
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return isBridgePort(port) ? port : DEFAULT_BRIDGE_PORT;
}

function selectedBridgePortMode(): BridgePortMode {
  const selected = [...bridgePortModeRadios].find((radio) => radio.checked)?.value;
  return selected === "fixed" ? "fixed" : "auto";
}

function updateBridgePortMode(): void {
  const fixed = selectedBridgePortMode() === "fixed";
  bridgeFixedPort.hidden = !fixed;
  bridgePort.disabled = !fixed;
  updateBridgeSnippet();
}

/** Text inputs save on a trailing edge, so a save is not issued per keystroke. */
function queueSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
}

for (const el of [
  stripFragment,
  bridgeAllowTabLoad,
  ...scopeRadios,
  ...clipModeRadios,
  ...optionsInTabRadios,
]) {
  el.addEventListener("change", () => void save());
}

// `bridgeEnabled` is not in that list because switching it on is the one moment
// we can ask for site access to the sidecar's loopback origin: Chrome requires a
// user gesture, and the background page — where the dialling happens — never has
// one. A refusal leaves the toggle off rather than persisting an enabled bridge
// that could only ever report "needs access".
bridgeEnabled.addEventListener("change", () => {
  void (async () => {
    // First await in the handler; see requestOrigins on why nothing may precede it.
    if (bridgeEnabled.checked && !(await requestOrigins(BRIDGE_ORIGINS))) {
      bridgeEnabled.checked = false;
      renderBridgeStatus("needs-access");
      return;
    }
    await save();
  })();
});
extraStripParams.addEventListener("input", queueSave);
obsidianVault.addEventListener("input", () => {
  updateVaultWarning();
  queueSave();
});
clippingsBaseFolder.addEventListener("input", queueSave);

// ---------- agent bridge ----------

for (const radio of bridgePortModeRadios) {
  radio.addEventListener("change", () => {
    updateBridgePortMode();
    void save();
  });
}

bridgePort.addEventListener("input", () => {
  updateBridgeSnippet();
  queueSave();
});

bridgeTokenGenerate.addEventListener("click", () => {
  bridgeToken.value = generateToken();
  updateBridgeSnippet();
  void save();
});

// Typing updates the snippet but does not persist. Every write of `bridgeToken`
// is a revocation — the handshake pins the token it proved, so a live socket
// drops — and saving per keystroke would tear the bridge down once per character
// while someone pastes or types one in. `change` fires on blur or Enter, which is
// when the value is actually meant.
bridgeToken.addEventListener("input", updateBridgeSnippet);
bridgeToken.addEventListener("change", () => {
  // Trimmed because the common way to get a token here is a paste, and a copied
  // secret routinely arrives with a trailing newline or a stray space. That would
  // otherwise be a token that looks identical to the one in the sidecar's config
  // and silently fails every handshake.
  const trimmed = bridgeToken.value.trim();
  if (trimmed !== bridgeToken.value) bridgeToken.value = trimmed;
  updateBridgeSnippet();
  void save();
});

// The token stays masked unless asked for. Copy works either way, so revealing
// it is only ever needed to eyeball one against a config file.
//
// The eye governs the config snippet below as well, not just this field. Masking
// the field while rendering the same secret in full a few hundred pixels lower
// protected nothing: this page gets screenshotted into bug reports and pasted
// into agent sessions, and the snippet is the part people capture.
bridgeTokenReveal.addEventListener("click", () => {
  setTokenRevealed(bridgeToken.type === "password");
});

function tokenRevealed(): boolean {
  return bridgeToken.type === "text";
}

function setTokenRevealed(reveal: boolean): void {
  bridgeToken.type = reveal ? "text" : "password";
  bridgeTokenReveal.setAttribute("aria-pressed", String(reveal));
  const label = reveal ? "Hide token" : "Reveal token";
  bridgeTokenReveal.setAttribute("aria-label", label);
  bridgeTokenReveal.title = label;
  bridgeTokenReveal.classList.toggle("revealed", reveal);
  updateBridgeSnippet();
}

bridgeTokenCopy.addEventListener("click", () => {
  if (!bridgeToken.value) {
    flashStatus("No token yet");
    return;
  }
  void copyText(bridgeToken.value, "Token copied");
});

bridgeSnippetCopy.addEventListener("click", () => {
  const command = bridgeSnippetText(false);
  if (command === null) {
    flashStatus("No token yet");
    return;
  }
  void copyText(command, "Setup command copied");
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

/**
 * Null when there is no token yet — one notion of "nothing to install", shared
 * by the rendered snippet and the copy button. Rendering a runnable command
 * around a placeholder invited someone to select the `<pre>` by hand and write
 * that placeholder into the token file, which the button's guard never covered.
 *
 * @param masked render the token as dots rather than the secret itself. The
 * displayed snippet is masked unless the eye is open; "Copy setup command"
 * always passes `false`, so the clipboard gets a command that actually works.
 */
function bridgeSnippetText(masked: boolean): string | null {
  if (!bridgeToken.value) return null;
  const token = masked ? "•".repeat(24) : bridgeToken.value;
  const tokenPath = `"$config_dir/${DEFAULT_TOKEN_FILE_NAME}"`;
  return (
    `config_dir="\${XDG_CONFIG_HOME:-$HOME/.config}/${CONFIG_DIR_NAME}"\n` +
    'mkdir -p "$config_dir" && chmod 700 "$config_dir" &&\n' +
    `(umask 077; printf '%s\\n' ${shellQuote(token)} > ${tokenPath}) && ` +
    `chmod 600 ${tokenPath}`
  );
}

/** Single-quote arbitrary pasted tokens without giving the shell code to run. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const GULLET_LAUNCH_COMMAND = "bunx tabglutton-gullet";

function updateBridgeSnippet(): void {
  const code = bridgeSnippet.querySelector("code");
  if (code) {
    code.textContent =
      bridgeSnippetText(!tokenRevealed()) ??
      "Generate or paste a token above to get the setup command.";
  }
  const port = selectedBridgePortMode() === "fixed" ? ` --port ${parsePort(bridgePort.value)}` : "";
  bridgeLaunchCommand.textContent = `${GULLET_LAUNCH_COMMAND}${port}`;
}

const BRIDGE_STATUS_LABELS: Record<BridgeStatus, string> = {
  disabled: "Off",
  idle: "Waiting for a sidecar",
  connecting: "Connecting…",
  connected: "Connected",
  // Names the port because that is the whole content of the fix, and this
  // otherwise presents as "Waiting for a sidecar" forever with a sidecar that
  // is running perfectly well a few lines above.
  "port-conflict": "Port in use by another program",
  // Chrome only: the loopback grant was refused or later revoked. Switching the
  // toggle off and on again is what re-asks for it, so the label says so — the
  // browser's own permissions UI is the other route and much harder to describe.
  "needs-access": "Needs access — switch off and on to allow",
};

function renderBridgeStatus(status: BridgeStatus, port?: number): void {
  if (status === "connected" && port !== undefined) {
    bridgeStatusEl.textContent = `Connected on ${port}`;
  } else if (status === "idle" && selectedBridgePortMode() === "auto") {
    bridgeStatusEl.textContent = "No compatible sidecar found";
  } else {
    bridgeStatusEl.textContent = BRIDGE_STATUS_LABELS[status];
  }
  bridgeStatusEl.dataset.state = status;
}

async function refreshBridgeStatus(): Promise<void> {
  let status: BridgeStatus = "disabled";
  let port: number | undefined;
  try {
    const res = (await browser.runtime.sendMessage({ type: "get-bridge-status" })) as
      | GetBridgeStatusResponse
      | undefined;
    if (res) {
      status = res.status;
      port = res.port;
    }
  } catch {
    // Background asleep or restarting; infer from the settings we rendered
    // rather than showing an error the user cannot act on. This mirrors
    // BridgeClient.isConfigured() — enabled *and* holding a token — because
    // guessing from the toggle alone reports "waiting" for a bridge that has
    // no token and is therefore not dialling at all.
    status = bridgeEnabled.checked && bridgeToken.value ? "idle" : "disabled";
  }
  renderBridgeStatus(status, port);
}

// The background pushes every transition, so this page never polls — on Chrome
// MV3 a poll would keep the service worker awake for as long as it is open.
browser.runtime.onMessage.addListener((raw: unknown) => {
  const msg = raw as Partial<BridgeStatusChangedMessage> | null;
  if (msg?.type === "bridge-status-changed" && msg.status) {
    renderBridgeStatus(msg.status, msg.port);
  }
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
