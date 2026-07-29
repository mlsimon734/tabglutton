#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { loadSigningEnv } from "./sign-env.js";

loadSigningEnv();

const origPkgText = readFileSync("package.json", "utf8");
const origManifestText = readFileSync("manifest.json", "utf8");
const pkg = JSON.parse(origPkgText);
const manifest = JSON.parse(origManifestText);
// Versions are major.minor.patch.build, and Firefox accepts at most four parts.
// The 4th is the signed-test-build counter: it belongs in the artifact and its
// tag, not in package.json. Slice to the release triple anyway — a 4-part
// version has been committed before (v0.1.2.1), and appending to that would
// produce a five-part version AMO rejects.
const versionParts: string[] = pkg.version.split(".");
const base = versionParts.slice(0, 3).join(".");

const tags = spawnSync("git", ["tag", "--list", `v${base}.*`, "--sort=-v:refname"], {
  encoding: "utf8",
});
const lastTag = tags.stdout.split("\n").filter(Boolean)[0];
const taggedN = lastTag ? Number(lastTag.slice(`v${base}.`.length)) : 0;
// AMO requires versions to be unique and strictly increasing, and these tags are
// local and unpushed — so never trust them alone. If package.json already
// carries a build number, count from whichever is higher.
const committedN = versionParts.length > 3 ? Number(versionParts[3]) : 0;
const lastN = Math.max(
  Number.isFinite(taggedN) ? taggedN : 0,
  Number.isFinite(committedN) ? committedN : 0,
);
const next = lastN + 1;
const dev = `${base}.${next}`;

console.log(`Signing dev build v${dev} (base ${base})`);

let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  writeFileSync("package.json", origPkgText);
  writeFileSync("manifest.json", origManifestText);
};
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(143);
});

pkg.version = dev;
manifest.version = dev;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const built = spawnSync("bun", ["run", "build:firefox"], { stdio: "inherit", env: process.env });
if (built.status !== 0) {
  console.error(`\nbuild failed (status ${built.status}).`);
  process.exit(built.status ?? 1);
}

const signed = spawnSync(
  "bunx",
  [
    "web-ext",
    "sign",
    "--source-dir=dist-firefox",
    "--artifacts-dir=web-ext-artifacts",
    "--channel=unlisted",
  ],
  { stdio: "inherit", env: process.env },
);
if (signed.status !== 0) {
  console.error(`\nweb-ext sign failed (status ${signed.status}).`);
  process.exit(signed.status ?? 1);
}

spawnSync("git", ["tag", `v${dev}`]);
console.log(`\n✓ Signed v${dev}. XPI is in web-ext-artifacts/`);
console.log(`  Local tag v${dev} created (not pushed).`);
