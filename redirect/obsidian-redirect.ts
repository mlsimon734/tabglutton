// Opened in a tab by background.ts to hand a clip off to Obsidian. The
// obsidian:// navigation happens from THIS extension page's origin, so the
// one-time approval granted through onboarding applies to every subsequent
// launch. A direct tabs.create({ url: "obsidian://…" }) is browser-initiated;
// neither engine can attach a rememberable per-origin grant to it.
const target = decodeURIComponent(window.location.hash.slice(1));
if (target.startsWith("obsidian://")) {
  // The manual way out if the browser blocks or drops the launch below. It is
  // a click on the same URL from the same page, so it asks under the same origin.
  const link = document.getElementById("fallbackLink");
  if (link instanceof HTMLAnchorElement) {
    link.href = target;
    link.parentElement?.removeAttribute("hidden");
  }
  window.location.replace(target);
}

export {};
