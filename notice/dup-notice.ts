// The duplicate notice itself: an extension page embedded in the corner of a
// web page by src/dup-notice-page.ts, which sizes the frame to the pill here
// and removes it on request. Being an extension page is what lets it talk to
// the background directly — Dedup and Undo are the popup's own messages — and
// draw with the shared tokens instead of a hand-copied palette.
//
// It never takes focus. It arrives while the user is doing something else on
// the page, and a notice that steals the caret is worse than none.
import type { CloseDuplicatesResponse, ClosedTabRecord } from "../src/background.js";
import {
  DUP_NOTICE_LINGER_MS,
  dupNoticeText,
  type DupNoticeFrameMessage,
} from "../src/dup-notice.js";

/** Mirrors the popup toast's window (`TOAST_DURATION_SEC`), so Undo lasts one length everywhere. */
const UNDO_SEC = 6;
/** How long a terminal line ("nothing to close", a failure) stays before the pill leaves. */
const FAREWELL_MS = 2200;

const notice = document.getElementById("notice") as HTMLDivElement;
const textEl = document.getElementById("text") as HTMLSpanElement;
const actBtn = document.getElementById("act") as HTMLButtonElement;
const dismissBtn = document.getElementById("dismiss") as HTMLButtonElement;

// The count rides in on the hash, put there by the background: the only input
// this page takes, and one the embedding page never handled.
const count = Number(new URLSearchParams(location.hash.slice(1)).get("count"));

function post(msg: DupNoticeFrameMessage): void {
  // The parent is whatever page the user was on, so its origin is unknowable
  // here and irrelevant: a size and a dismiss carry nothing worth protecting.
  window.parent.postMessage(msg, "*");
}

// The pill is measured, never guessed at from here: its width depends on the
// count's digits and on whatever the platform's UI face is.
new ResizeObserver(() => {
  const box = notice.getBoundingClientRect();
  post({ source: "tabglutton-dup-notice", type: "size", width: box.width, height: box.height });
}).observe(notice);

let gone = false;
function dismiss(): void {
  if (gone) return;
  gone = true;
  linger.stop();
  post({ source: "tabglutton-dup-notice", type: "dismiss" });
}

/**
 * The unattended countdown, which only runs while someone could be looking:
 * paused while the pointer is over the pill and while the tab is hidden. A
 * notice that had already timed out behind another tab was never a notice.
 */
const linger = (() => {
  let remaining = DUP_NOTICE_LINGER_MS;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hovered = false;
  let armed = true;
  const stop = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  };
  const resume = (): void => {
    if (!armed || timer !== undefined || hovered || document.hidden) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  notice.addEventListener("mouseenter", () => {
    hovered = true;
    stop();
  });
  notice.addEventListener("mouseleave", () => {
    hovered = false;
    resume();
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : resume()));
  return {
    start: resume,
    stop,
    /** Once the user has acted, the pill's timing belongs to that action instead. */
    disarm: (): void => {
      armed = false;
      stop();
    },
  };
})();

function farewell(text: string): void {
  textEl.textContent = text;
  actBtn.hidden = true;
  setTimeout(dismiss, FAREWELL_MS);
}

async function send<T>(msg: unknown): Promise<T> {
  return (await browser.runtime.sendMessage(msg)) as T;
}

let restorable: ClosedTabRecord[] = [];
let undoTimer: ReturnType<typeof setInterval> | undefined;

async function dedup(): Promise<void> {
  linger.disarm();
  actBtn.disabled = true;
  actBtn.textContent = "Closing…";
  let res: CloseDuplicatesResponse | undefined;
  try {
    res = await send<CloseDuplicatesResponse>({ type: "close-duplicates" });
  } catch (err) {
    console.warn("[tabglutton] duplicate notice: close-duplicates failed", err);
  }
  if (!res) {
    farewell("Couldn't close duplicates");
    return;
  }
  if (res.closed === 0 || res.restorable.length === 0) {
    // The count was a snapshot; the tabs went some other way in the meantime.
    farewell("Nothing left to close");
    return;
  }
  restorable = res.restorable;
  textEl.textContent = `${res.closed} closed`;
  actBtn.title = "Reopen the tabs just closed";
  actBtn.disabled = false;
  let remainingSec = UNDO_SEC;
  const tick = (): void => {
    actBtn.textContent = `Undo (${remainingSec})`;
  };
  tick();
  undoTimer = setInterval(() => {
    remainingSec -= 1;
    if (remainingSec <= 0) {
      dismiss();
      return;
    }
    tick();
  }, 1000);
}

async function undo(): Promise<void> {
  if (undoTimer !== undefined) clearInterval(undoTimer);
  actBtn.disabled = true;
  actBtn.textContent = "Reopening…";
  try {
    await send({ type: "reopen-tabs", records: restorable });
  } catch (err) {
    console.warn("[tabglutton] duplicate notice: reopen-tabs failed", err);
  }
  dismiss();
}

actBtn.addEventListener("click", () => {
  void (restorable.length ? undo() : dedup());
});
dismissBtn.addEventListener("click", dismiss);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") dismiss();
});

textEl.textContent = dupNoticeText(Number.isFinite(count) ? count : 0);
linger.start();
