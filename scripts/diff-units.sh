#!/usr/bin/env bash
# Show how the fund's INSTALLED systemd user units differ from this repo's.
#
# Report-only: never installs, never fails a deploy. The units are templates
# (COMPANY_ID/PROJECT_ID stand in for the paperclip workspace path), so each is
# rendered with the ids taken from the remote checkout path before comparing.
# Written after the reconciler unit turned out to exist only on the Pi, where
# it had no timeout and nobody could review it.
#
# Usage: scripts/diff-units.sh <ssh-host> <remote-repo-path>
#   INSTALLED_DIR=<dir>  compare against a local directory instead of ssh (tests)
set -uo pipefail
HOST="${1:-${FUND_DEPLOY_HOST:-}}"
REMOTE="${2:-${FUND_DEPLOY_REMOTE:-}}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# .../projects/<company>/<project>/sovereign-ibkr-fund
IDS="$(printf '%s\n' "$REMOTE" | sed -nE 's#.*/projects/([^/]+)/([^/]+)/[^/]+/?$#\1/\2#p')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/installed" "$TMP/repo"

if [ -n "${INSTALLED_DIR:-}" ]; then
  cp "$INSTALLED_DIR"/ibkr-fund-* "$TMP/installed/" 2>/dev/null || true
elif [ -n "$HOST" ]; then
  rsync -q "$HOST:.config/systemd/user/ibkr-fund-*" "$TMP/installed/" 2>/dev/null || true
else
  echo "[units] usage: scripts/diff-units.sh <ssh-host> <remote-repo-path>" >&2
  exit 0
fi

for f in "$DIR"/deploy/*/ibkr-fund-*.service "$DIR"/deploy/*/ibkr-fund-*.timer \
         "$DIR"/deploy/*/systemd/ibkr-fund-*.service "$DIR"/deploy/*/systemd/ibkr-fund-*.timer; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  if [ -n "$IDS" ]; then sed "s#COMPANY_ID/PROJECT_ID#$IDS#g" "$f" > "$TMP/repo/$name"; else cp "$f" "$TMP/repo/$name"; fi
done

changed=0
for f in "$TMP"/repo/*; do
  name="$(basename "$f")"
  if [ ! -f "$TMP/installed/$name" ]; then
    echo "[units] NOT INSTALLED: $name"; changed=1; continue
  fi
  if ! diff -q "$TMP/installed/$name" "$f" >/dev/null; then
    echo "[units] DIFFERS: $name (installed → repo)"
    diff -u "$TMP/installed/$name" "$f" | sed '1,2d; s/^/    /'
    changed=1
  fi
done
for f in "$TMP"/installed/*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  [ -f "$TMP/repo/$name" ] || { echo "[units] NOT IN REPO: $name"; changed=1; }
done
[ "$changed" = 0 ] && echo "[units] installed units match the repo"
echo "[units] (report only — install with cp + systemctl --user daemon-reload; see deploy/README.md)"
exit 0
