#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { loadSigningEnv } from "./sign-env.js";

loadSigningEnv();

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
