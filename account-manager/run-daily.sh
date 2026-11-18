#!/bin/zsh
# Daily account-manager run. Called by launchd (see launchd/) or by hand.
#   ./account-manager/run-daily.sh example-client [--dry]
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT="${1:-example-client}"; shift || true
LOG="$REPO/account-manager/logs/daily.log"
mkdir -p "$REPO/account-manager/logs"
cd "$REPO"
echo "===== $(date '+%Y-%m-%d %H:%M:%S') daily $CLIENT $*" >> "$LOG"
npx tsx account-manager/scripts/daily.ts --client="$CLIENT" "$@" >> "$LOG" 2>&1
STATUS=$?
echo "===== exit $STATUS" >> "$LOG"

# Optional judgment step: when the deterministic run escalated something Claude can act on
# (NEED_LEADS → prep the blocked stock, draft a new campaign), hand it to Claude Code headless.
# Enable with AM_CLAUDE_STEP=1 in the environment (or in the launchd plist). Off by default.
if [[ "${AM_CLAUDE_STEP:-0}" == "1" ]] && command -v claude >/dev/null 2>&1; then
  LATEST="$REPO/account-manager/clients/$CLIENT/state/latest.json"
  if [[ -f "$LATEST" ]] && grep -q '"escalations": \[' "$LATEST" && ! grep -q '"escalations": \[\]' "$LATEST"; then
    echo "----- claude judgment step $(date '+%H:%M:%S')" >> "$LOG"
    claude -p "/account-manager follow-up --client=$CLIENT" --permission-mode acceptEdits --max-turns 60 >> "$LOG" 2>&1
  fi
fi
exit 0
