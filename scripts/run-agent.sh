#!/usr/bin/env bash
# Run an IBKR Fund agent with auto-update.
# dist/ is committed to git — no build step needed.
# Usage: scripts/run-agent.sh <agent-name>
set -euo pipefail

AGENT="${1:?Usage: run-agent.sh <agent-name>}"
SCRIPT="dist/agents/${AGENT}.js"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# Pull latest code + prebuilt dist
git pull -q 2>/dev/null || true

# Install runtime deps if missing (@stoqey/ib, dotenv)
if [ ! -d "node_modules" ]; then
  npm install --omit=dev 2>/dev/null
fi

if [ ! -f "$SCRIPT" ]; then
  echo "[run-agent] FATAL: $SCRIPT not found" >&2
  exit 1
fi

exec node "$SCRIPT" --once
