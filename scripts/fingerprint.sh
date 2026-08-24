# shellcheck shell=sh
#
# Shared source fingerprint — the freshness contract between a workstation
# deploy and a prebuilt host. Sourced by BOTH scripts/deploy-to-pi.sh (which
# stamps it into dist/.build-stamp) and scripts/run-agent.sh (which recomputes
# it and refuses to run on a mismatch). It lives in one file so the two can
# never drift apart; a silent drift would mean the host either runs stale code
# or hard-fails forever.
#
# Replaced an mtime comparison (`find src -newer dist/index.js`), which was
# unfit for the job: `rsync -a` preserves source mtimes while dist/ got touched
# afterwards, so freshness reduced to the wall-clock ordering of two unrelated
# operations — the 2026-08-02 deploy cleared its own gate by 216 milliseconds.
# It also ignored package.json/tsconfig.json, could not see deletions, missed
# non-.ts inputs (tsconfig sets resolveJsonModule), and over-triggered on
# *.test.ts which tsconfig excludes from the build.
#
# Hashes CONTENT + the sorted path list through a SINGLE hash invocation. Do not
# "simplify" this to hashing per-file digests: `shasum` (macOS) and `sha256sum`
# (Linux) print different line formats, so that would make the Mac and the Pi
# disagree about an identical tree. LC_ALL=C keeps ordering locale-independent.

_fp_hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}

# src/validation/data/ is EXCLUDED. It holds gitignored Yahoo daily bars fetched
# by `pnpm fetch-data` for the backtest suites — megabytes of market data that is
# not a build input (the suites read it with readFileSync at runtime, and tsconfig
# excludes *.test.ts from the build). Including it meant that merely RUNNING the
# backtests on a workstation changed the source fingerprint, so the next deploy
# stamped a hash the Pi could never reproduce — the tree does not rsync there —
# and every agent hard-failed the prebuilt freshness check. That happened on
# 2026-08-19. Deleting the data would have unblocked it; excluding it stops the
# trap being re-armed by the next person who runs a backtest.
_fp_files() {
  find src -type f \( -name '*.ts' -o -name '*.json' \) ! -name '*.test.ts' \
    ! -path 'src/validation/data/*' 2>/dev/null | LC_ALL=C sort
}

source_fingerprint() {
  {
    _fp_files | tr '\n' '\0' | xargs -0 cat 2>/dev/null
    cat package.json tsconfig.json pnpm-lock.yaml 2>/dev/null
    _fp_files
  } | _fp_hash
}
