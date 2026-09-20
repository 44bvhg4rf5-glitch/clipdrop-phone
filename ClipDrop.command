#!/bin/bash
# ClipDrop.command — double-clickable launcher.
#
# A .command file rather than an .app bundle: Finder runs it through Terminal,
# so none of Gatekeeper's app-launch rules apply. Less pretty, far more likely
# to simply work, and you can see what it is doing.

cd "$(dirname "$0")" || exit 1

# Finder-launched scripts get a bare PATH and never read .zprofile, so Homebrew
# is invisible unless we name it.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

PORT="${CLIPDROP_PORT:-4100}"

printf '\n  ClipDrop\n  --------\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  Node is not installed.\n  Run:  bash setup-mac.sh\n\n'
  read -r -p '  Press return to close. ' _
  exit 1
fi

# Already up? Just show the page rather than failing on the port.
if curl -sS -o /dev/null --max-time 2 "http://localhost:$PORT/api/state" 2>/dev/null; then
  printf '  Already running — opening the page.\n\n'
  open "http://localhost:$PORT/"
  exit 0
fi

printf '  Starting… your browser will open in a moment.\n'
printf '  Close this window (or press Ctrl+C) to stop ClipDrop.\n\n'

( sleep 1.5; open "http://localhost:$PORT/" ) &
CLIPDROP_PORT="$PORT" node dashboard.mjs
