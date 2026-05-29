// Opened in a tab by background.ts (Chrome only) to hand a clip off to Obsidian.
// The obsidian:// navigation happens from THIS extension page's origin, so the
// "Always allow chrome-extension://<id>" choice the user grants once (e.g. via
// the onboarding ping) applies and every subsequent launch is silent. A direct
// tabs.create({ url: "obsidian://…" }) is browser-initiated, which Chrome never
// lets the user remember — so it would prompt on every clip. See openObsidianUrl.
const target = decodeURIComponent(window.location.hash.slice(1));
if (target.startsWith("obsidian://")) {
  window.location.replace(target);
}

export {};
