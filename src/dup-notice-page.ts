// Injected into the active tab by background.ts (`showDupNotice`), after a
// companion executeScript has parked the frame URL on `window`. Its whole job
// is to place one <iframe> of the extension's own `notice/dup-notice.html` in
// the corner of the page and take it down when the frame says so. It reads
// nothing from the page and paints nothing of its own: every pixel of the
// notice is drawn inside the frame, which is an extension page — so it renders
// with the real design tokens, the page's stylesheet cannot reach it, and the
// page's CSP cannot block it, since both engines exempt an extension's own
// resources from the page's policy. A shadow-DOM overlay was the alternative,
// and its styles would have been either inline (which a strict `style-src`
// refuses, on both engines) or hand-copied hex.
//
// No `browser` here on purpose: the background hands over the fully resolved
// URL, so this file needs no polyfill on Chrome and bundles as one plain IIFE
// for both targets.

import { isDupNoticeFrameMessage } from "./dup-notice.js";

declare global {
  interface Window {
    __tabgluttonDupNotice?: { url: string };
  }
}

const HOST_ID = "tabglutton-dup-notice";
const INSET_PX = 20;

function placeNotice(url: string): void {
  // A second notice on the same page replaces the first rather than stacking:
  // the background only ever wants one on screen, and the memory it keeps is
  // per pile, not per frame.
  document.getElementById(HOST_ID)?.remove();

  const origin = new URL(url).origin;
  const frame = document.createElement("iframe");
  frame.id = HOST_ID;
  frame.src = url;
  frame.title = "Tabglutton";
  const style = frame.style;
  style.position = "fixed";
  style.right = `${INSET_PX}px`;
  style.bottom = `${INSET_PX}px`;
  // Sized by the frame itself once it has laid out; 1px until then, and
  // invisible, so no empty box flashes before the pill is ready.
  style.width = "1px";
  style.height = "1px";
  style.opacity = "0";
  style.border = "0";
  style.margin = "0";
  style.padding = "0";
  style.background = "transparent";
  style.borderRadius = "999px";
  style.overflow = "hidden";
  // The shadow lives on the frame element because the document inside cannot
  // paint outside its own viewport; the radius clips the frame to the pill.
  style.boxShadow = "0 10px 28px -6px rgba(27, 22, 20, 0.5)";
  style.zIndex = "2147483647";
  // `color-scheme` is inherited, and a page that declares `dark` would hand a
  // mismatched scheme to a frame following the user's preference — which
  // Chrome answers with an opaque canvas behind the frame. Both sides
  // declaring `light dark` resolve to the same used scheme.
  style.colorScheme = "light dark";
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    style.transition = "opacity 180ms cubic-bezier(0.2, 0.8, 0.2, 1)";
  }

  const onMessage = (event: MessageEvent): void => {
    // Both checks, not one: the page can post anything it likes on this
    // window, and only the frame we created, speaking from the extension's
    // origin, gets to size or remove itself.
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    if (!isDupNoticeFrameMessage(event.data)) return;
    if (event.data.type === "size") {
      style.width = `${Math.ceil(event.data.width)}px`;
      style.height = `${Math.ceil(event.data.height)}px`;
      style.opacity = "1";
      return;
    }
    window.removeEventListener("message", onMessage);
    frame.remove();
  };
  window.addEventListener("message", onMessage);
  (document.body ?? document.documentElement).append(frame);
}

const config = window.__tabgluttonDupNotice;
delete window.__tabgluttonDupNotice;
if (config?.url) placeNotice(config.url);
