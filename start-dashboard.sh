#!/bin/bash
# start-dashboard.sh — open the ClipDrop command centre.
#
#   bash start-dashboard.sh
#
# Stays running while you use it. Ctrl+C in this window closes it.

cd "$(dirname "$0")" || exit 1
PORT="${CLIPDROP_PORT:-4100}"

if ! command -v node >/dev/null 2>&1; then
  echo "node isn't installed. Run: bash setup-mac.sh"
  exit 1
fi

# The AI panel needs a key. Everything else works without one, so this is a
# note rather than a blocker.
[ -z "${ANTHROPIC_API_KEY:-}" ] && printf '\n  (Research panel is off — set ANTHROPIC_API_KEY to enable it.)\n'

( sleep 1; command -v open >/dev/null 2>&1 && open "http://localhost:$PORT" ) &
CLIPDROP_PORT="$PORT" node dashboard.mjs
