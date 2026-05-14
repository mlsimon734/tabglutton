#!/usr/bin/env bun
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { $ } from "bun";

const DIST = "dist";

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

await $`bunx tsc`;

const clipBuild = await Bun.build({
  entrypoints: ["src/clip-current.ts"],
  outdir: `${DIST}/src`,
  target: "browser",
  format: "iife",
  minify: true,
  sourcemap: "external",
});
if (!clipBuild.success) {
  for (const log of clipBuild.logs) console.error(log);
  process.exit(1);
}

cpSync("manifest.json", `${DIST}/manifest.json`);
cpSync("icons", `${DIST}/icons`, { recursive: true });

mkdirSync(`${DIST}/popup`, { recursive: true });
cpSync("popup/popup.html", `${DIST}/popup/popup.html`);
cpSync("popup/popup.css", `${DIST}/popup/popup.css`);

mkdirSync(`${DIST}/options`, { recursive: true });
cpSync("options/options.html", `${DIST}/options/options.html`);
cpSync("options/options.css", `${DIST}/options/options.css`);

mkdirSync(`${DIST}/THIRD_PARTY_LICENSES`, { recursive: true });
cpSync("node_modules/defuddle/LICENSE", `${DIST}/THIRD_PARTY_LICENSES/defuddle-LICENSE.txt`);

console.log("[build] dist/ ready");
