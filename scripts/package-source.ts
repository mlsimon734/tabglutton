#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { $ } from "bun";

const { version } = await Bun.file("package.json").json();
// `git archive` will not create its output directory, and web-ext-artifacts/ is gitignored
// — so on a fresh clone this is the first thing that needs it. `bun run package` only gets
// away without this because package:firefox runs first.
mkdirSync("web-ext-artifacts", { recursive: true });
const out = `web-ext-artifacts/tabglutton-source-${version}.zip`;
await $`git archive HEAD --format=zip -o ${out}`;
console.log(`[package-source] ${out}`);
