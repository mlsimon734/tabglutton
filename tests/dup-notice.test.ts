import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DUP_NOTICE_THRESHOLD,
  DUP_NOTICE_COOLDOWN_MS,
  dupNoticeAfterReopen,
  dupNoticeText,
  isDupNoticeFrameMessage,
  isDupNoticeHostMessage,
  isDupNoticeThreshold,
  planDupNotice,
  type DupNoticeMemory,
  type DupNoticeObservation,
} from "../src/dup-notice.js";

const T0 = 1_700_000_000_000;
const on = { dupNoticeEnabled: true, dupNoticeThreshold: 10 };
const off = { ...on, dupNoticeEnabled: false };
const armed: DupNoticeMemory = { shown: false };
/** A pass with nothing mid-navigation, which is what every test below means unless it says otherwise. */
const saw = (dupCount: number): DupNoticeObservation => ({ dupCount, settled: true });

describe("planDupNotice", () => {
  test("shows once the count reaches the threshold, and remembers when", () => {
    expect(planDupNotice(armed, saw(10), on, T0)).toEqual({
      show: true,
      memory: { shown: true, lastShownAt: T0 },
    });
  });

  test("a count under the threshold never shows", () => {
    expect(planDupNotice(armed, saw(9), on, T0)).toEqual({ show: false, memory: armed });
  });

  // One pile, one notice: ten more duplicates on top of an announced pile say
  // nothing, and dismissing the frame is not undone by the next tab.
  test("an announced pile stays announced while it stands, however it grows", () => {
    const shown = { shown: true, lastShownAt: T0 };
    expect(planDupNotice(shown, saw(10), on, T0 + 1_000)).toEqual({ show: false, memory: shown });
    expect(planDupNotice(shown, saw(40), on, T0 + DUP_NOTICE_COOLDOWN_MS * 3)).toEqual({
      show: false,
      memory: shown,
    });
  });

  test("only a count below the threshold disarms it, keeping the timestamp", () => {
    expect(planDupNotice({ shown: true, lastShownAt: T0 }, saw(9), on, T0 + 1_000)).toEqual({
      show: false,
      memory: { shown: false, lastShownAt: T0 },
    });
  });

  // Close one tab, open one: the same pile, not a new one.
  test("a dip and climb inside the cooldown holds rather than re-announcing", () => {
    const rearmed = { shown: false, lastShownAt: T0 };
    expect(planDupNotice(rearmed, saw(10), on, T0 + DUP_NOTICE_COOLDOWN_MS - 1)).toEqual({
      show: false,
      memory: rearmed,
    });
  });

  test("past the cooldown a re-armed memory shows again", () => {
    const rearmed = { shown: false, lastShownAt: T0 };
    const now = T0 + DUP_NOTICE_COOLDOWN_MS;
    expect(planDupNotice(rearmed, saw(10), on, now)).toEqual({
      show: true,
      memory: { shown: true, lastShownAt: now },
    });
  });

  // The background evaluates a wake with default settings before the real ones
  // load; a disarm there would turn the next pass into a fresh announcement.
  test("a disabled setting leaves the memory exactly as it is", () => {
    const shown = { shown: true, lastShownAt: T0 };
    expect(planDupNotice(shown, saw(50), off, T0 + 1)).toEqual({ show: false, memory: shown });
    expect(planDupNotice(shown, saw(0), off, T0 + 1)).toEqual({ show: false, memory: shown });
    expect(planDupNotice(armed, saw(50), off, T0 + 1)).toEqual({ show: false, memory: armed });
  });

  test("the threshold is the setting's, not the default's", () => {
    const settings = { dupNoticeEnabled: true, dupNoticeThreshold: 3 };
    expect(planDupNotice(armed, saw(2), settings, T0).show).toBe(false);
    expect(planDupNotice(armed, saw(3), settings, T0).show).toBe(true);
  });

  test("an armed memory with no history is unchanged by a pass that does nothing", () => {
    const plan = planDupNotice(armed, saw(0), on, T0);
    expect(plan.memory).toBe(armed);
  });

  // Restored tabs are created faster than they commit, and an uncommitted tab
  // has no URL the count can see: the pass right after an Undo reads zero.
  test("an unsettled pass never disarms, whatever its count", () => {
    const shown = { shown: true, lastShownAt: T0 };
    const plan = planDupNotice(shown, { dupCount: 0, settled: false }, on, T0 + 1_000);
    expect(plan).toEqual({ show: false, memory: shown });
  });

  test("an unsettled pass can still show — its count is a floor", () => {
    expect(planDupNotice(armed, { dupCount: 10, settled: false }, on, T0).show).toBe(true);
  });
});

describe("dupNoticeAfterReopen", () => {
  // Reopening is keeping: the pile the user just restored is treated as
  // announced, so the next notice waits for a genuine drop.
  test("arms a disarmed memory without a notice", () => {
    expect(dupNoticeAfterReopen({ shown: false, lastShownAt: T0 })).toEqual({
      shown: true,
      lastShownAt: T0,
    });
    expect(dupNoticeAfterReopen(armed)).toEqual({ shown: true });
  });

  test("leaves an armed memory alone", () => {
    const shown = { shown: true, lastShownAt: T0 };
    expect(dupNoticeAfterReopen(shown)).toBe(shown);
  });

  test("then a count below the threshold disarms it like any other pile", () => {
    const kept = dupNoticeAfterReopen({ shown: false, lastShownAt: T0 });
    expect(planDupNotice(kept, saw(12), on, T0 + DUP_NOTICE_COOLDOWN_MS * 2).show).toBe(false);
    expect(planDupNotice(kept, saw(0), on, T0 + DUP_NOTICE_COOLDOWN_MS * 2).memory.shown).toBe(
      false,
    );
  });
});

describe("isDupNoticeThreshold", () => {
  test("accepts whole numbers from 1 to 9999", () => {
    expect(isDupNoticeThreshold(1)).toBe(true);
    expect(isDupNoticeThreshold(DEFAULT_DUP_NOTICE_THRESHOLD)).toBe(true);
    expect(isDupNoticeThreshold(9999)).toBe(true);
  });

  test("rejects what a count could never reach or a hand edit could store", () => {
    expect(isDupNoticeThreshold(0)).toBe(false);
    expect(isDupNoticeThreshold(-3)).toBe(false);
    expect(isDupNoticeThreshold(2.5)).toBe(false);
    expect(isDupNoticeThreshold(10_000)).toBe(false);
    expect(isDupNoticeThreshold(Number.NaN)).toBe(false);
    expect(isDupNoticeThreshold("10")).toBe(false);
    expect(isDupNoticeThreshold(undefined)).toBe(false);
  });
});

describe("dupNoticeText", () => {
  test("counts the badge's number", () => {
    expect(dupNoticeText(1)).toBe("1 duplicate tab");
    expect(dupNoticeText(12)).toBe("12 duplicate tabs");
  });
});

describe("isDupNoticeFrameMessage", () => {
  test("accepts the frame's two messages", () => {
    expect(
      isDupNoticeFrameMessage({
        source: "tabglutton-dup-notice",
        type: "size",
        width: 300,
        height: 36,
      }),
    ).toBe(true);
    expect(isDupNoticeFrameMessage({ source: "tabglutton-dup-notice", type: "dismiss" })).toBe(
      true,
    );
  });

  // The listener sits on a web page's window, so anything at all can arrive.
  test("rejects everything a page could post", () => {
    expect(isDupNoticeFrameMessage(null)).toBe(false);
    expect(isDupNoticeFrameMessage("dismiss")).toBe(false);
    expect(isDupNoticeFrameMessage({ type: "dismiss" })).toBe(false);
    expect(isDupNoticeFrameMessage({ source: "tabglutton-dup-notice", type: "resize" })).toBe(
      false,
    );
    expect(
      isDupNoticeFrameMessage({ source: "tabglutton-dup-notice", type: "size", width: "300" }),
    ).toBe(false);
  });
});

describe("isDupNoticeHostMessage", () => {
  test("accepts the host's nonce hand-over", () => {
    expect(
      isDupNoticeHostMessage({
        source: "tabglutton-dup-notice-host",
        type: "nonce",
        nonce: "6f1b0c2e",
      }),
    ).toBe(true);
  });

  // The frame's parent is an arbitrary web page whose origin cannot be checked,
  // so this listener sees whatever that page decides to post. Shape is all it
  // screens for — whether the nonce is the real one is the background's call.
  test("rejects what a page could post in its place", () => {
    expect(isDupNoticeHostMessage(null)).toBe(false);
    expect(isDupNoticeHostMessage("nonce")).toBe(false);
    expect(isDupNoticeHostMessage({ type: "nonce", nonce: "x" })).toBe(false);
    expect(
      isDupNoticeHostMessage({ source: "tabglutton-dup-notice", type: "nonce", nonce: "x" }),
    ).toBe(false);
    expect(
      isDupNoticeHostMessage({ source: "tabglutton-dup-notice-host", type: "size", nonce: "x" }),
    ).toBe(false);
    expect(
      isDupNoticeHostMessage({ source: "tabglutton-dup-notice-host", type: "nonce", nonce: "" }),
    ).toBe(false);
    expect(
      isDupNoticeHostMessage({ source: "tabglutton-dup-notice-host", type: "nonce", nonce: 7 }),
    ).toBe(false);
  });
});
