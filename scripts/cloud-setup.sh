#!/usr/bin/env bash
# Cloud-session bootstrap, run by the SessionStart hook in .claude/settings.json.
# Local sessions exit immediately; only claude.ai/code (and `claude --cloud`) VMs
# set CLAUDE_CODE_REMOTE, and those start from a bare clone with no node_modules.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"

# Idempotent: a warm VM already has deps, so skip the network entirely.
if [ -d node_modules ] && [ -d node_modules/defuddle ]; then
  echo "cloud-setup: node_modules present, skipping install"
  exit 0
fi

# Bun is the local default, but its package fetching is a documented casualty of
# the cloud egress proxy. npm is unaffected and produces a node_modules the bun
# runtime reads fine, so it is the cloud-only fallback.
if bun install; then
  echo "cloud-setup: dependencies installed with bun"
elif npm install; then
  echo "cloud-setup: bun install failed (likely the cloud proxy); installed with npm"
else
  echo "cloud-setup: both bun install and npm install failed; run one by hand" >&2
fi

exit 0
