#!/usr/bin/env bun
// The listed AMO counterpart to `bun run sign`, which is --channel=unlisted and therefore
// self-distribution signing: it mints an XPI and never touches the public listing.
//
// Source upload is not optional here. build.ts minifies, so the packaged code is
// machine-generated, and a listed submission whose source is missing gets bounced. The
// zip comes from `git archive HEAD`, so a dirty tree would ship source that does not build
// the package being signed — refuse rather than discover that in a review queue.
import { spawnSync } from "node:child_process";
import { loadSigningEnv } from "./sign-env.js";

loadSigningEnv();

const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
// A git that could not run answers `null` stdout, and a git that failed answers "" with a
// nonzero status — both of which would read as "clean" and wave a mismatched source zip
// through. Absence of an answer is not an answer.
if (status.status !== 0 || status.stdout === null) {
  console.error(`Could not read \`git status\` (status ${status.status}). Refusing to sign blind.`);
  process.exit(1);
}
const dirty = status.stdout;
if (dirty.trim()) {
  console.error(
    "Working tree is dirty. The source zip is `git archive HEAD`, so it would not match" +
      "\nthe package being signed. Commit or set the changes aside first:\n",
  );
  console.error(dirty);
  process.exit(1);
}

const { version } = (await Bun.file("package.json").json()) as { version: string };

const steps: [string, string[]][] = [
  ["bun", ["run", "build:firefox"]],
  ["bun", ["scripts/package-source.ts"]],
  [
    "bunx",
    [
      "web-ext",
      "sign",
      "--source-dir=dist-firefox",
      "--artifacts-dir=web-ext-artifacts",
      "--channel=listed",
      `--upload-source-code=web-ext-artifacts/tabglutton-source-${version}.zip`,
    ],
  ],
];

for (const [command, argv] of steps) {
  const ran = spawnSync(command, argv, { stdio: "inherit", env: process.env });
  if (ran.status !== 0) {
    console.error(`\n${command} ${argv.join(" ")} failed (status ${ran.status}).`);
    process.exit(ran.status ?? 1);
  }
}

console.log(`\n✓ Submitted v${version} to AMO on the listed channel.`);
console.log("  Confirm the channel took: docs/STORE.md 3.");
