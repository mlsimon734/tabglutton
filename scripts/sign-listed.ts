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

const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout;
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
    console.error(`\n${command} ${argv[0]} failed (status ${ran.status}).`);
    process.exit(ran.status ?? 1);
  }
}

console.log(`\n✓ Submitted v${version} to AMO on the listed channel.`);
console.log("  Confirm the channel took: docs/STORE.md 3.");
