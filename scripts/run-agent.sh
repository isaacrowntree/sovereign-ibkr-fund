#!/usr/bin/env bash
# Run an IBKR Fund agent with auto-update, for an external orchestrator
# (cron/systemd) that wants "pull latest, then run".
#
# Usage: scripts/run-agent.sh <agent-name>
#   e.g. scripts/run-agent.sh risk-manager
#
# This used to claim "dist/ is committed to git — no build step needed". That
# was never true: .gitignore ignores dist/, so `git pull` cannot deliver it. On
# a fresh clone the script just failed; worse, on a host where dist/ had been
# built once, a pull would update src/ and leave dist/ stale — silently running
# OLD code against a real account. So: build when the source is newer.
set -euo pipefail

AGENT="${1:?Usage: run-agent.sh <agent-name>}"
SCRIPT="dist/agents/${AGENT}.js"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# Pull latest source. Best-effort: a network blip must not stop a scheduled run
# from executing the code already on disk.
git pull -q 2>/dev/null || true

# pnpm, not npm: pnpm-lock.yaml is the committed lockfile, and npm below 11.13
# cannot parse the `#path:` fragment in the bezant-client dep. Resolved lazily —
# the steady state (deps present, dist fresh) needs no package manager at all,
# and a scheduled run shouldn't fail over a tool it isn't going to use.
pnpm_bin() {
  if command -v "${PNPM:-pnpm}" >/dev/null 2>&1; then
    echo "${PNPM:-pnpm}"
    return 0
  fi
  if command -v corepack >/dev/null 2>&1 && corepack enable pnpm >/dev/null 2>&1 &&
     command -v pnpm >/dev/null 2>&1; then
    echo pnpm
    return 0
  fi
  return 1
}

need_build=0
if [ ! -f dist/index.js ] || [ -n "$(find src -name '*.ts' -newer dist/index.js -print -quit 2>/dev/null)" ]; then
  need_build=1
fi

if [ ! -d node_modules ] || [ "$need_build" = 1 ]; then
  PM="$(pnpm_bin)" || {
    echo "[run-agent] FATAL: need to $( [ -d node_modules ] || echo 'install deps'; [ "$need_build" = 1 ] && echo 'rebuild' ) but pnpm is unavailable." >&2
    echo "[run-agent] install it with: corepack enable pnpm" >&2
    exit 1
  }
  # Dev deps are REQUIRED — typescript builds dist/. (The old `npm install
  # --omit=dev` here would have made the build below impossible.)
  [ -d node_modules ] || "$PM" install --frozen-lockfile
  if [ "$need_build" = 1 ]; then
    echo "[run-agent] source changed — rebuilding"
    "$PM" run build
  fi
fi

if [ ! -f "$SCRIPT" ]; then
  echo "[run-agent] FATAL: $SCRIPT not found after build — is '${AGENT}' a real agent name?" >&2
  echo "[run-agent] available: $(ls dist/agents/*.js 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.js$//' | tr '\n' ' ')" >&2
  exit 1
fi

exec node "$SCRIPT" --once
