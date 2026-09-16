#!/bin/bash
# drop-local.sh — build today's drop on this Mac and publish it.
#
#   bash drop-local.sh
#
# Handles the YouTube half of the pipeline, which the cloud runner can't do:
# YouTube refuses datacentre IPs, and this machine has a residential one.
# Clips the cloud already built today are kept, not replaced.

set -u
cd "$(dirname "$0")" || exit 1

printf '\n\033[1mClipDrop · local run\033[0m\n'

# Battery check up front, so we fail in a second rather than ten minutes in.
if [ "$(uname)" = "Darwin" ] && ! pmset -g ps | grep -q "AC Power"; then
  printf '  On battery. Plug in and re-run — rendering would eat a chunk of charge.\n'
  printf '  (The cloud half still runs on its own schedule regardless.)\n\n'
  exit 0
fi

# Take the cloud's commits first. Without this the push below is rejected
# whenever GitHub Actions has published since this Mac last pulled.
printf '  syncing…\n'
git pull --rebase --quiet origin main || {
  printf '  \033[31mgit pull failed\033[0m — resolve it and re-run.\n'; exit 1; }

CLIPDROP_RUNNER=local node clipdrop.mjs
STATUS=$?

if [ $STATUS -ne 0 ]; then
  printf '\n  \033[31mThe run failed.\033[0m Nothing was published; the existing page is untouched.\n\n'
  exit $STATUS
fi

if git diff --quiet -- docs && git diff --staged --quiet -- docs; then
  printf '\n  Nothing new to publish.\n\n'
  exit 0
fi

printf '  publishing…\n'
git add docs
git commit --quiet -m "drop: $(date -u +%Y-%m-%d) (local)"

for attempt in 1 2 3 4; do
  if git push --quiet origin main 2>/dev/null; then
    REPO=$(git config --get remote.origin.url | sed -E 's#.*github\.com[:/]([^/]+)/(.+?)(\.git)?$#\1.github.io/\2#')
    printf '\n  \033[32mPublished.\033[0m  https://%s/\n\n' "$REPO"
    exit 0
  fi
  printf '  push failed (attempt %s) — re-syncing and retrying…\n' "$attempt"
  git pull --rebase --quiet origin main || break
  sleep $((attempt * 2))
done

printf '\n  \033[31mCould not push.\033[0m Your clips are committed locally — run: git push origin main\n\n'
exit 1
