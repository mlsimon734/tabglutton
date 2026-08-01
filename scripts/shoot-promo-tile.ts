#!/usr/bin/env bun
/**
 * Render the Chrome Web Store small promo tile from `docs/media/promo-tile.html`.
 *
 * Headless Chrome rather than the CDP harness the screenshots use: the tile has
 * no live browser state behind it, so it should be reproducible from a clean
 * checkout instead of needing a staged profile on a debug port.
 *
 * Two things are load-bearing:
 *   - The webfonts are inlined as data URIs first. Chrome treats every `file://`
 *     document as its own opaque origin, so a relative `@font-face` URL fetches
 *     nothing and the tile silently renders in Times. Inlined, they also need no
 *     network round trip, so `font-display: block` has them ready at first paint
 *     and no virtual-time budget is required.
 *   - Chrome is killed once the file is written rather than waited on. Chrome
 *     151's `--headless` writes the screenshot promptly and then sits for two to
 *     three minutes before exiting, so awaiting the process turns a one-second
 *     render into a coffee break. The PNG is polled for a stable size instead.
 *
 * Shot at 2x and downscaled, so the antialiasing comes from the resample. The
 * store wants exactly 440x280, 24-bit, no alpha.
 */

import { $ } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCE = `${ROOT}docs/media/promo-tile.html`;
const FONT_DIR = `${ROOT}popup/fonts`;
const OUT = `${ROOT}docs/media/store/promo-tile-440x280.png`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const WIDTH = 440;
const HEIGHT = 280;

const work = `${process.env.TMPDIR ?? "/tmp"}/tabglutton-promo-tile`;
await $`mkdir -p ${work}`.quiet();

let html = await Bun.file(SOURCE).text();
for (const family of ["Vollkorn", "Geist"]) {
  const bytes = await Bun.file(`${FONT_DIR}/${family}.woff2`).arrayBuffer();
  const dataUri = `data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}`;
  const before = html;
  html = html.replace(new RegExp(`url\\("[^"]*${family}\\.woff2"\\)`), `url("${dataUri}")`);
  if (html === before) throw new Error(`no @font-face URL to inline for ${family}`);
}
const staged = `${work}/tile.html`;
await Bun.write(staged, html);

const shot = `${work}/tile@2x.png`;
await $`rm -f ${shot}`.quiet();

const chrome = Bun.spawn(
  [
    CHROME,
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    `--user-data-dir=${work}/profile`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--force-device-scale-factor=2",
    `--screenshot=${shot}`,
    `file://${staged}`,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

// Written, not merely present: Chrome creates the file and then fills it, so a
// bare existence check can hand sips a truncated PNG.
let settled = 0;
let lastSize = -1;
for (let i = 0; i < 160 && settled < 2; i++) {
  await Bun.sleep(250);
  const size = await Bun.file(shot)
    .arrayBuffer()
    .then((b) => b.byteLength)
    .catch(() => -1);
  settled = size > 0 && size === lastSize ? settled + 1 : 0;
  lastSize = size;
}
chrome.kill();
await chrome.exited;
if (settled < 2) throw new Error(`Chrome never finished writing ${shot}`);

// -z takes height then width, and crops nothing: the 2x shot is exactly 2:1.
await $`sips -s format png -z ${HEIGHT} ${WIDTH} ${work}/tile@2x.png --out ${OUT}`.quiet();

const probe = await $`sips -g pixelWidth -g pixelHeight -g hasAlpha ${OUT}`.text();
const size = (await Bun.file(OUT).arrayBuffer()).byteLength;
console.log(probe.trim());
console.log(`  bytes: ${size}`);
console.log(`\nwrote ${OUT.replace(ROOT, "")}`);
