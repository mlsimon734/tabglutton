// Opened in a tab by background.ts to hand a clip off to Obsidian. The
// obsidian:// navigation happens from THIS extension page's origin, so the
// one-time approval granted through onboarding applies to every subsequent
// launch. A direct tabs.create({ url: "obsidian://…" }) is browser-initiated;
// neither engine can attach a rememberable per-origin grant to it.
const target = decodeURIComponent(window.location.hash.slice(1));
if (target.startsWith("obsidian://")) {
  window.location.replace(target);
}

export {};
