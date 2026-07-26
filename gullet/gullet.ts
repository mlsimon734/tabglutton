#!/usr/bin/env bun
// Gullet — the pipe tab content passes through on its way to an agent.
// Entry point referenced from agent MCP configs; see gullet/README.md.

import { main } from "./src/main.js";

process.exit(await main(Bun.argv.slice(2), Bun.env));
