import { describe, expect, test } from "bun:test";
import { clipTextLength, MIN_CLIP_CONTENT_CHARS, thinClipVerdict } from "../src/clip-guard.js";

/** Enough visible text to clear the floor, with no signature wording in it. */
function article(chars = MIN_CLIP_CONTENT_CHARS + 200): string {
  const sentence = "The archive was reorganized again that winter, and nobody minded. ";
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
}

/**
 * What Defuddle gets off a Cloudflare interstitial: the site name, the challenge
 * line, and the footer. Reproduces the clip-and-close half of #49 without a real
 * challenge, which is what the issue says a synthetic page is good for.
 */
const CLOUDFLARE_INTERSTITIAL = {
  title: "Just a moment…",
  markdown: [
    "# example.com",
    "",
    "Verifying you are human. This may take a few seconds.",
    "",
    "example.com needs to review the security of your connection before proceeding.",
    "",
    "Ray ID: 8f3c1d2ea4b70119",
    "",
    "Performance & security by [Cloudflare](https://www.cloudflare.com/5xx-error-landing/)",
  ].join("\n"),
};

describe("thinClipVerdict", () => {
  test("refuses a bot-check interstitial and names it as one", () => {
    const verdict = thinClipVerdict(CLOUDFLARE_INTERSTITIAL);
    expect(verdict).not.toBeNull();
    expect(verdict?.reason).toBe("thin-content");
    expect(verdict?.challengeSuspect).toBe(true);
    expect(verdict?.message).toContain("bot check");
    expect(verdict?.message).toContain("the tab was kept");
  });

  test("passes a normal article", () => {
    expect(thinClipVerdict({ title: "A winter in the stacks", markdown: article() })).toBeNull();
  });

  test("passes an article that only just clears the floor", () => {
    const markdown = article(MIN_CLIP_CONTENT_CHARS);
    expect(clipTextLength(markdown)).toBe(MIN_CLIP_CONTENT_CHARS);
    expect(thinClipVerdict({ title: "Exactly enough", markdown })).toBeNull();
  });

  /**
   * The documented cost of the threshold: a real page this short is refused, and
   * the refusal keeps the tab and says the page may not have finished loading
   * rather than accusing it of being a challenge. #49 accepts the manual retry.
   */
  test("refuses a genuinely short real page, without calling it a bot check", () => {
    const verdict = thinClipVerdict({
      title: "Linked: a better tape backup",
      markdown: "Worth reading if you still keep tapes. Three paragraphs of setup, one of regret.",
    });
    expect(verdict?.reason).toBe("thin-content");
    expect(verdict?.challengeSuspect).toBe(false);
    expect(verdict?.message).not.toContain("bot check or CAPTCHA");
    expect(verdict?.message).toContain("may not have finished loading");
  });

  /**
   * The signature list sharpens wording and never returns a verdict of its own,
   * which is what keeps a rotting list from costing anything but precision — and
   * what keeps a real page about bot checks clippable.
   */
  test("a signature alone never refuses a page with enough content", () => {
    expect(
      thinClipVerdict({
        title: "Just a moment… — on the psychology of interstitials",
        markdown: `${article()}\n\nChecking your browser before accessing anything, forever.`,
      }),
    ).toBeNull();
  });

  test("an empty extraction is refused at zero characters", () => {
    const verdict = thinClipVerdict({ title: "Untitled", markdown: "" });
    expect(verdict?.chars).toBe(0);
    expect(verdict?.challengeSuspect).toBe(false);
  });
});

describe("clipTextLength", () => {
  test("does not count link and image targets as content", () => {
    const padding = "x".repeat(MIN_CLIP_CONTENT_CHARS);
    const markdown = `[go](https://example.com/${padding}) ![](https://example.com/${padding}.png)`;
    expect(clipTextLength(markdown)).toBeLessThan(MIN_CLIP_CONTENT_CHARS);
    expect(thinClipVerdict({ title: "Redirecting", markdown })).not.toBeNull();
  });

  test("keeps link text and image alt text", () => {
    expect(clipTextLength("[readable](https://example.com/a/b/c)")).toBe("readable".length);
    expect(clipTextLength("![a chart](https://example.com/chart.png)")).toBe("a chart".length);
  });

  test("does not count stray HTML or markdown markers", () => {
    expect(clipTextLength("## **Heading**\n\n> quoted `code`")).toBe("Heading quoted code".length);
    expect(clipTextLength('<div class="challenge-running">held</div>')).toBe("held".length);
  });

  /**
   * A character floor is only ever stricter for a language that packs more
   * meaning into one character, which is the safe direction — a word count would
   * refuse every unspaced-script page outright.
   */
  test("counts unspaced scripts by character", () => {
    expect(clipTextLength("图书馆")).toBe(3);
  });
});
