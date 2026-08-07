import { describe, expect, test } from "bun:test";
import { isAcademicZoteroTarget, type ZoteroTabInfo } from "../src/zotero.js";

function info(itemType?: string, isPDF = false): ZoteroTabInfo {
  return {
    state: "ready",
    isPDF,
    ...(itemType ? { translator: { itemType, label: "Test translator" } } : {}),
  };
}

describe("isAcademicZoteroTarget()", () => {
  test.each([
    "bookSection",
    "conferencePaper",
    "journalArticle",
    "manuscript",
    "preprint",
    "report",
    "thesis",
  ])("routes scholarly item type %s", (itemType) => {
    expect(isAcademicZoteroTarget(info(itemType))).toBe(true);
  });

  test("routes a standalone PDF even without a translator", () => {
    expect(isAcademicZoteroTarget(info(undefined, true))).toBe(true);
  });

  test.each(["blogPost", "magazineArticle", "multiple", "newspaperArticle", "webpage"])(
    "leaves non-paper item type %s on the Obsidian path",
    (itemType) => {
      expect(isAcademicZoteroTarget(info(itemType))).toBe(false);
    },
  );

  test("does not route while Connector detection is still pending", () => {
    expect(isAcademicZoteroTarget({ state: "detecting", isPDF: true })).toBe(false);
  });
});
