import { describe, expect, test } from "bun:test";
import { formatIsoDuration, pageExtras } from "../src/page-extras.js";

describe("formatIsoDuration", () => {
  test("hours, minutes, seconds", () => {
    expect(formatIsoDuration("PT2H4M31S")).toBe("2:04:31");
    expect(formatIsoDuration("PT4M5S")).toBe("4:05");
    expect(formatIsoDuration("PT45S")).toBe("0:45");
    expect(formatIsoDuration("P0DT1H0M0S")).toBe("1:00:00");
  });
  test("anything else is null", () => {
    expect(formatIsoDuration("PT")).toBeNull();
    expect(formatIsoDuration("P")).toBeNull();
    expect(formatIsoDuration("2:04")).toBeNull();
    expect(formatIsoDuration("PT0S")).toBeNull();
  });
});

describe("pageExtras", () => {
  test("a YouTube page: duration from the meta tag, else from schema.org", () => {
    expect(pageExtras({ durationMeta: "PT12M3S" })).toEqual({ duration: "12:03" });
    expect(
      pageExtras({ schemaOrgData: [{ "@type": "VideoObject", duration: "PT1H2M3S" }] }),
    ).toEqual({ duration: "1:02:03" });
  });

  test("a Reddit thread: comment count from the post element, else from schema.org", () => {
    expect(pageExtras({ commentCountAttr: "58" })).toEqual({ comments: 58 });
    expect(
      pageExtras({
        schemaOrgData: { "@graph": [{ "@type": "DiscussionForumPosting", commentCount: "214" }] },
      }),
    ).toEqual({ comments: 214 });
  });

  test("junk yields nothing", () => {
    expect(
      pageExtras({
        schemaOrgData: [{ "@type": "VideoObject", duration: "<script>" }],
        commentCountAttr: "lots",
      }),
    ).toEqual({});
    expect(pageExtras({})).toEqual({});
  });
});
