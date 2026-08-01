#!/usr/bin/env bun
import { $ } from "bun";

const { version } = await Bun.file("package.json").json();
const out = `web-ext-artifacts/tabglutton-source-${version}.zip`;
await $`git archive HEAD --format=zip -o ${out}`;
console.log(`[package-source] ${out}`);
