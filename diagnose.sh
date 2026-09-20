#!/bin/bash
# diagnose.sh — is the missing heatmap our code, yt-dlp, or the video?
# Talks to yt-dlp directly so nothing in clipdrop.mjs can be the cause.

cd "$(dirname "$0")" || exit 1

echo "=== 1. am I running the fixed version? ==="
printf '  commit     : %s\n' "$(git log --oneline -1)"
printf '  fix present: %s\n' "$(grep -c player_client clipdrop.mjs) reference(s) to player_client (want 1+)"
printf '  yt-dlp     : %s\n' "$(yt-dlp --version 2>&1)"

echo
echo "=== 2. picking a video from the channel ==="
URL=$(yt-dlp --flat-playlist --playlist-end 1 --print url \
      "https://www.youtube.com/@JudoSloth/videos" 2>/dev/null | head -1)
if [ -z "$URL" ]; then echo "  could not list the channel at all"; exit 1; fi
echo "  $URL"

echo
echo "=== 3. does ANY player client return a heatmap? ==="
for c in "web,default" "web" "web_safari" "mweb" "default" "tv"; do
  printf '  %-12s ' "$c"
  yt-dlp --dump-json --no-warnings --extractor-args "youtube:player_client=$c" "$URL" 2>/dev/null \
  | python3 -c "
import sys,json
try:
    d=json.loads(sys.stdin.readline() or '{}')
    h=d.get('heatmap')
    print(f'{len(h)} points  (views: {d.get(\"view_count\",\"?\")})' if h else f'no heatmap  (views: {d.get(\"view_count\",\"?\")})')
except Exception as e: print('extraction failed')
" 2>/dev/null || echo "failed"
done

echo
echo "=== 4. does yt-dlp know the field at all? ==="
yt-dlp --dump-json --no-warnings "$URL" 2>/dev/null \
| python3 -c "
import sys,json
d=json.loads(sys.stdin.readline() or '{}')
print('  heatmap key present:', 'heatmap' in d)
print('  chapters present   :', bool(d.get('chapters')))
print('  duration           :', d.get('duration'))
" 2>/dev/null || echo "  could not parse metadata"
echo
