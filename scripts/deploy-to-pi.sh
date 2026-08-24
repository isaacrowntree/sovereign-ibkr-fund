#!/usr/bin/env bash
# Build locally and push src/ + dist/ to the Pi.
#
# Why push instead of letting the Pi build:
#   The bezant-client dep is git-hosted (github:isaacrowntree/bezant#path:/…)
#   and pnpm must run its `prepare` step to materialise the package. On the Pi
#   that fails two different ways — first ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
#   (git deps need an `allowBuilds` allowlist), and once allowlisted, the
#   package's own build dies with `code 127 / spawn ENOENT`. So `pnpm install`
#   can never deliver typescript there, and `tsc` is absent. The Pi cannot
#   build this repo. It only ever runs what we push.
#   bezant-client is `import type` only, so nothing needs it at runtime.
#
#   That blocks the DEV deps only. bezant-client is a devDependency, so
#   `pnpm install --prod --frozen-lockfile` never fetches it and does work on
#   the Pi — which is how the Pi gets its runtime deps (dotenv, @stoqey/ib).
#   Those are NOT pushed by this script: node_modules is not rsynced, so a
#   fresh clone has none and every agent dies on MODULE_NOT_FOUND. The verify
#   step below asserts they are present rather than letting that reach runtime.
#
# Pairs with the `.prebuilt` marker in the Pi checkout, which makes
# scripts/run-agent.sh skip `git pull` + the build and fail loudly if dist/
# is ever older than src/ (i.e. if someone pulled without redeploying).
#
# Usage: scripts/deploy-to-pi.sh [ssh-host] [remote-repo-path]
set -euo pipefail

# Deployment-specific. Pass as args or set in the environment — there are no
# defaults on purpose, so this never silently targets someone else's host.
#   FUND_DEPLOY_HOST    ssh host/alias of the machine running the fund
#   FUND_DEPLOY_REMOTE  absolute path to the checkout on that host
# e.g. FUND_DEPLOY_HOST=fund-pi \
#      FUND_DEPLOY_REMOTE=/var/lib/paperclip/instances/default/projects/<company>/<project>/sovereign-ibkr-fund \
#      scripts/deploy-to-pi.sh
HOST="${1:-${FUND_DEPLOY_HOST:-}}"
REMOTE="${2:-${FUND_DEPLOY_REMOTE:-}}"
if [ -z "$HOST" ] || [ -z "$REMOTE" ]; then
  echo "[deploy] FATAL: deployment target not set." >&2
  echo "[deploy] usage: scripts/deploy-to-pi.sh <ssh-host> <remote-repo-path>" >&2
  echo "[deploy]        or set FUND_DEPLOY_HOST / FUND_DEPLOY_REMOTE" >&2
  exit 1
fi
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

command -v node_modules/.bin/tsc >/dev/null 2>&1 || [ -x node_modules/.bin/tsc ] || {
  echo "[deploy] FATAL: node_modules/.bin/tsc not found — run your package manager install here first." >&2
  exit 1
}

echo "[deploy] building $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"
rm -rf dist
node_modules/.bin/tsc
[ -f dist/index.js ] || { echo "[deploy] FATAL: build produced no dist/index.js" >&2; exit 1; }
echo "[deploy] built $(ls dist/agents/*.js 2>/dev/null | wc -l | tr -d ' ') agent entrypoints"

# src/ AND dist/ together — shipping dist/ alone would leave the Pi's src/ at
# whatever commit it last cloned, and the fingerprint covers src/.
# --delete keeps the Pi a faithful mirror, but it makes THIS machine authoritative
# for anything living in these dirs. Two things must never be deleted that way:
#   portfolios/local.ts  — the REAL production book. It is gitignored, so a deploy
#     from a fresh clone (or after `git clean -X`) would delete it, and
#     portfolios/index.ts swallows the failure and silently falls back to
#     SAMPLE_PORTFOLIO — i.e. rebalance a live account toward a sample allocation.
#   validation/data/     — gitignored backtest fixtures, same reasoning.
# ._* / .DS_Store are macOS AppleDouble junk that otherwise rides along.
EXCLUDES=(--exclude 'portfolios/local.ts' --exclude 'validation/data/' --exclude '._*' --exclude '.DS_Store')

# The Pi cannot run a package manager (see header), so it can never reconcile a
# dependency change. Detect it here rather than discovering MODULE_NOT_FOUND at
# runtime against a real account.
echo "[deploy] checking dependency manifest parity"
for f in package.json pnpm-lock.yaml tsconfig.json; do
  local_sum=$(shasum -a 256 "$f" | cut -d' ' -f1)
  remote_sum=$(ssh "$HOST" "shasum -a 256 '$REMOTE/$f' 2>/dev/null | cut -d' ' -f1" || true)
  if [ -n "$remote_sum" ] && [ "$local_sum" != "$remote_sum" ]; then
    echo "[deploy] FATAL: $f differs from the Pi's copy." >&2
    echo "[deploy] The Pi cannot run pnpm install, so a dependency/compiler change" >&2
    echo "[deploy] cannot be reconciled by pushing dist/ alone. Vendor the dep or" >&2
    echo "[deploy] bundle the output before deploying." >&2
    exit 1
  fi
done

# Don't rsync --delete over a live agent. Runs are short (~20s) and 4h apart, so
# an atomic dist swap would be overkill — but `--delete` CAN unlink a .js that a
# running process has not lazily require()d yet (portfolios/index.ts does a
# deferred require), producing MODULE_NOT_FOUND mid-execution, possibly after
# orders are already placed. Waiting a few seconds removes that window entirely.
# Asked via paperclip's DATABASE, not `ps`. Process inspection does not work
# here: the container has no `ps`, and a `docker exec` child is not visible to
# `docker top`, host `ps`, or the container's own /proc scan — all three were
# tested and all three reported "nothing running" while an agent was demonstrably
# mid-run. A guard built on that would have been a silent no-op, which is worse
# than no guard. `heartbeat_runs.status='running'` is the system of record and is
# what paperclip itself uses. Credentials come from the container's own env, so
# this script needs none.
IN_FLIGHT_JS='const {createRequire}=require("node:module");const {globSync}=require("node:fs");
const r=createRequire("/app/x.js");let P;for(const p of ["postgres",...globSync("/app/node_modules/.pnpm/postgres@*/node_modules/postgres")]){try{P=r(p);break}catch{}}
if(!P){console.log("DRIVER_MISSING");process.exit(0)}
const sql=P(process.env.DATABASE_URL,{max:1,idle_timeout:3,connect_timeout:8});
sql`select a.name from paperclip.heartbeat_runs h join paperclip.agents a on a.id=h.agent_id where h.status=${"running"} and h.finished_at is null`
 .then(rs=>{console.log(rs.map(x=>x.name).join(",")||"NONE");return sql.end()})
 .catch(e=>{console.log("QUERY_FAILED:"+e.message);return sql.end()});'
echo "[deploy] checking for in-flight agent runs (via heartbeat_runs)"
for attempt in $(seq 1 30); do
  running=$(ssh "$HOST" "docker exec paperclip node -e '$IN_FLIGHT_JS'" 2>/dev/null | tail -1 || echo "QUERY_FAILED")
  case "$running" in
    NONE) break ;;
    DRIVER_MISSING|QUERY_FAILED*)
      echo "[deploy] WARNING: could not determine in-flight runs ($running) — proceeding." >&2
      echo "[deploy] A concurrent agent run could see a partially-synced dist/." >&2
      running=NONE; break ;;
  esac
  [ "$attempt" = 1 ] && echo "[deploy] waiting for in-flight run(s): $running"
  sleep 5
done
if [ "${running:-NONE}" != "NONE" ]; then
  echo "[deploy] FATAL: agents still running after 150s ($running) — refusing to rsync over a live run." >&2
  exit 1
fi
echo "[deploy] no agents in flight"

echo "[deploy] pushing src/ + dist/ + scripts/ to ${HOST}:${REMOTE}"
rsync -a --delete "${EXCLUDES[@]}" src/     "${HOST}:${REMOTE}/src/"
rsync -a --delete "${EXCLUDES[@]}" dist/    "${HOST}:${REMOTE}/dist/"
# scripts/ too — run-agent.sh itself carries the .prebuilt handling, so a Pi
# running an older copy of it would still try (and fail) to build.
rsync -a --delete "${EXCLUDES[@]}" scripts/ "${HOST}:${REMOTE}/scripts/"

# Content stamp, not mtimes. run-agent.sh recomputes this fingerprint on the Pi
# and refuses to run if it differs — so a partial rsync, a clock step, or an
# edit made directly on the Pi is caught deterministically rather than by which
# of two operations happened to land last. MUST match source_fingerprint() in
# scripts/run-agent.sh.
. "$DIR/scripts/fingerprint.sh"
FP="$(source_fingerprint)"
REV="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY=""; [ -n "$(git status --porcelain 2>/dev/null)" ] && DIRTY=" (dirty tree)"
ssh "$HOST" "cd '$REMOTE' && touch .prebuilt && cat > dist/.build-stamp" <<STAMP
fingerprint=$FP
rev=$REV$DIRTY
built=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
STAMP
echo "[deploy] stamped ${FP:0:12}… rev ${REV:0:8}${DIRTY}"

# Verify by asking the Pi to run the SAME check run-agent.sh will run. That is
# the only assertion that matters: if this passes, the next agent run cannot
# hit the FATAL stale path.
echo "[deploy] verifying (running the Pi's own freshness check)"
ssh "$HOST" "cd '$REMOTE' && \
  test -f .prebuilt || { echo '[deploy] FAIL: .prebuilt missing'; exit 1; }; \
  test -f dist/.build-stamp || { echo '[deploy] FAIL: no build stamp landed'; exit 1; }; \
  test -d node_modules/dotenv || { \
     echo '[deploy] FAIL: runtime deps missing on the host (no node_modules/dotenv).'; \
     echo '[deploy] node_modules is never rsynced, so a fresh clone has none.'; \
     echo '[deploy] Fix on the host, in the container, from the repo root:'; \
     echo '[deploy]   pnpm install --prod --frozen-lockfile'; \
     echo '[deploy] (--prod skips the bezant-client git dep, which cannot build there.)'; \
     exit 1; }; \
  test -f src/portfolios/local.ts || { \
     echo '[deploy] FAIL: src/portfolios/local.ts is missing on the host.'; \
     echo '[deploy] That file is the REAL production book. It is gitignored AND'; \
     echo '[deploy] excluded from this rsync, so a re-clone loses it silently and'; \
     echo '[deploy] portfolios/index.ts falls back to SAMPLE_PORTFOLIO — i.e. it'; \
     echo '[deploy] would rebalance a live account toward a sample allocation.'; \
     echo '[deploy] Copy it across by hand, then redeploy.'; \
     exit 1; }; \
  remote_fp=\$(sh -c '. ./scripts/fingerprint.sh; source_fingerprint'); \
  stamped=\$(grep '^fingerprint=' dist/.build-stamp | cut -d= -f2); \
  if [ \"\$remote_fp\" != \"\$stamped\" ]; then \
     echo \"[deploy] FAIL: fingerprint mismatch after transfer\"; \
     echo \"  stamped=\$stamped\"; echo \"  on disk=\$remote_fp\"; exit 1; fi; \
  echo \"[deploy] OK — \$(ls dist/agents/*.js | wc -l | tr -d ' ') agents, fingerprint \${remote_fp:0:12}… verified on the Pi\""

echo "[deploy] done"
