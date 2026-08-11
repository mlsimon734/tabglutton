/**
 * Rasterize the committed icon PNGs.
 *
 * `build.ts` does not rasterize — it copies `icons/` wholesale and points the Chrome manifest
 * at these files — so they are committed artefacts and this is what regenerates them.
 *
 * The point of the script is the mapping, not the loop: 16 and 32 come from
 * `icon-chomp-small.svg` and 48 and 128 from `icon-chomp.svg`. Regenerating all four from
 * one source is the obvious thing to do by hand and it silently discards the per-size
 * drawing, whose whole reason for existing is that the chips are illegible at toolbar size.
 *
 *   bun scripts/rasterize-icons.ts
 */

const ICONS = new URL("../icons/", import.meta.url);

/** size -> source, deliberately not one source for all four. */
const RASTERS: ReadonlyArray<readonly [number, string]> = [
  [16, "icon-chomp-small.svg"],
  [32, "icon-chomp-small.svg"],
  [48, "icon-chomp.svg"],
  [128, "icon-chomp.svg"],
];

/**
 * The AMO listing icon. It is a Developer Hub upload rather than a package file — AMO never
 * reads the manifest's `icons` key — so it lives under docs/media/store/ with the other
 * listing assets, and is rendered from the full drawing because AMO's smallest derived size
 * is 32.
 */
const AMO_ICON = {
  size: 512,
  source: "icon-chomp.svg",
  out: "../docs/media/store/amo-icon-512.png",
};

async function render(source: string, size: number, out: string): Promise<void> {
  const result = Bun.spawnSync([
    "rsvg-convert",
    "-w",
    String(size),
    "-h",
    String(size),
    Bun.fileURLToPath(new URL(source, ICONS)),
    "-o",
    out,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `rsvg-convert failed for ${source} at ${size}px: ${result.stderr.toString().trim()}`,
    );
  }
  console.log(`${out.split("/").at(-1)} <- ${source}`);
}

if (!Bun.which("rsvg-convert")) {
  throw new Error("rsvg-convert not found — `brew install librsvg`");
}

for (const [size, source] of RASTERS) {
  await render(source, size, Bun.fileURLToPath(new URL(`icon-chomp-${size}.png`, ICONS)));
}
await render(
  AMO_ICON.source,
  AMO_ICON.size,
  Bun.fileURLToPath(new URL(AMO_ICON.out, import.meta.url)),
);
