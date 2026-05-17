#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ENV_FILE = ".env.signing";

if (!existsSync(ENV_FILE)) {
  console.error(`Missing ${ENV_FILE}. Create it with:`);
  console.error(`  WEB_EXT_API_KEY=user:...`);
  console.error(`  WEB_EXT_API_SECRET=...`);
  process.exit(1);
}

for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  let value = m[2];
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  process.env[m[1]] = value;
}

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error(`${ENV_FILE} is missing WEB_EXT_API_KEY or WEB_EXT_API_SECRET.`);
  process.exit(1);
}

const origPkgText = readFileSync("package.json", "utf8");
const origManifestText = readFileSync("manifest.json", "utf8");
const pkg = JSON.parse(origPkgText);
const manifest = JSON.parse(origManifestText);
const base: string = pkg.version;

const tags = spawnSync("git", ["tag", "--list", `v${base}.*`, "--sort=-v:refname"], {
  encoding: "utf8",
});
const lastTag = tags.stdout.split("\n").filter(Boolean)[0];
const lastN = lastTag ? Number(lastTag.replace(`v${base}.`, "")) : 0;
const next = (Number.isFinite(lastN) ? lastN : 0) + 1;
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

const built = spawnSync("bun", ["run", "build"], { stdio: "inherit", env: process.env });
if (built.status !== 0) {
  console.error(`\nbuild failed (status ${built.status}).`);
  process.exit(built.status ?? 1);
}

const signed = spawnSync(
  "bunx",
  [
    "web-ext",
    "sign",
    "--source-dir=dist",
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
