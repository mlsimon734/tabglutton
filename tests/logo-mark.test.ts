import { describe, expect, test } from "bun:test";

/**
 * The mark's geometry exists in four files, because nothing can share it: the popup,
 * cockpit, options, and onboarding fetch `icons/logo-mark.svg` at runtime; the promo tile
 * inlines it so the tile stays a single `file://`-renderable page; and the two app icons
 * duplicate it because an icon is rasterized standalone with no stylesheet.
 *
 * A drifted copy is invisible until someone compares a store listing against the product —
 * which is exactly how the icon came to be a different mark from the extension's own. So the
 * copies are pinned to each other here rather than to a restated copy in this test, which
 * would only prove the test agrees with itself.
 */

async function read(path: string): Promise<string> {
  return await Bun.file(path).text();
}

const CANONICAL = "icons/logo-mark.svg";

/** Copies that carry the full drawing, chips included. */
const FULL = [CANONICAL, "icons/icon-chomp.svg", "docs/media/promo-tile.html"] as const;

/**
 * The toolbar-size drawing. It shares the silhouette and bite exactly and drops the chips on
 * purpose — they are sub-pixel at 16px and only cost contrast. Pinned as an intentional
 * omission so a later reader restoring "the missing chips" has to argue with a test.
 */
const SMALL = "icons/icon-chomp-small.svg";

const SOURCES = Object.fromEntries(
  await Promise.all([...FULL, SMALL].map(async (path) => [path, await read(path)] as const)),
) as Record<string, string>;

/** The tab-with-handle silhouette. */
function silhouette(svg: string): string {
  const match = /\sd="(M12 56[^"]+)"/.exec(svg);
  if (!match?.[1]) throw new Error("no silhouette path found");
  return match[1].replaceAll(/\s+/g, " ").trim();
}

function circles(source: string): string[] {
  return [...source.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(
    ([, cx, cy, r]) => `${cx},${cy},${r}`,
  );
}

/** The circles the bite mask subtracts from the right edge, in order. */
function bite(svg: string): string[] {
  const mask = /<mask id="cookie-bite"[\s\S]*?<\/mask>/.exec(svg);
  if (!mask) throw new Error("no cookie-bite mask found");
  return circles(mask[0]);
}

/** The chocolate chips, which carry their own colour rather than the tint. */
function chips(svg: string): string[] {
  const group = /<g fill="#3b2113"[\s\S]*?<\/g>/.exec(svg);
  return group ? circles(group[0]) : [];
}

describe("logo mark", () => {
  const canonical = SOURCES[CANONICAL]!;

  test("the canonical mark actually has a bite and chips to compare against", () => {
    expect(bite(canonical).length).toBeGreaterThan(0);
    expect(chips(canonical).length).toBeGreaterThan(0);
  });

  for (const path of [...FULL, SMALL]) {
    if (path === CANONICAL) continue;
    const svg = SOURCES[path]!;

    test(`${path} carries the canonical silhouette and bite`, () => {
      expect(silhouette(svg)).toBe(silhouette(canonical));
      expect(bite(svg)).toEqual(bite(canonical));
    });
  }

  for (const path of FULL) {
    if (path === CANONICAL) continue;
    test(`${path} carries the canonical chips`, () => {
      expect(chips(SOURCES[path]!)).toEqual(chips(canonical));
    });
  }

  test(`${SMALL} drops the chips deliberately`, () => {
    expect(chips(SOURCES[SMALL]!)).toEqual([]);
  });
});
