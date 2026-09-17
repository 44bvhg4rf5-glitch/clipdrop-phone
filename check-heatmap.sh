#!/bin/bash
# check-heatmap.sh — does YouTube give this machine most-replayed data?
#
#   bash check-heatmap.sh https://www.youtube.com/watch?v=...
#
# Answers one question and nothing else: which player client returns a heatmap.
# The pipeline needs one of them to, and when none do it is the video's fault,
# not the setup's.

URL="${1:-}"
[ -z "$URL" ] && { echo "usage: bash check-heatmap.sh <youtube url>"; exit 1; }

printf '\nChecking: %s\n\n' "$URL"
for client in "web,default" "mweb,default" "default"; do
  printf '  %-16s ' "$client"
  N=$(yt-dlp --dump-json --no-warnings --extractor-args "youtube:player_client=$client" "$URL" 2>/dev/null \
      | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{const j=JSON.parse(d.split('\n').find(l=>l.trim().startsWith('{'))||'{}');
    console.log(Array.isArray(j.heatmap)?j.heatmap.length:0);}catch{console.log(0);}
});" 2>/dev/null)
  if [ "${N:-0}" -gt 0 ]; then
    printf '\033[32m%s heatmap points\033[0m\n' "$N"
  else
    printf 'none\n'
  fi
done
printf '\nAny green line means this works. All "none" means this particular video\nhas no most-replayed data yet — try an older, more-viewed one.\n\n'
