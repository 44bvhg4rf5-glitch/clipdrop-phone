#!/bin/bash
# kaggle-run.sh — animate an episode's pack on a free Kaggle GPU.
#
#   ./kaggle-run.sh rain
#
# Needs: the kaggle command (brew install pipx && pipx install kaggle) and your
# API token at ~/.kaggle/kaggle.json (kaggle.com → Settings → Create New Token).
# The Mac only uploads, waits and downloads — no heat, and it can sleep between
# checks. Your Kaggle account must be phone-verified for GPU and internet.

set -euo pipefail
cd "$(dirname "$0")"

SLUG="${1:-}"
[ -z "$SLUG" ] && { echo "usage: ./kaggle-run.sh <episode>   e.g. ./kaggle-run.sh rain"; exit 1; }
PACK="packs/$SLUG"
[ -f "$PACK/prompts.json" ] || { echo "No pack at $PACK — make one first: node produce.mjs \"<idea>\" --pack --picks ..."; exit 1; }

KAGGLE="$(command -v kaggle || echo "$HOME/.local/bin/kaggle")"
[ -x "$KAGGLE" ] || { echo "kaggle command not found. Run:  brew install pipx && pipx ensurepath && pipx install kaggle"; exit 1; }
# Username: from the token file if there is one, else from the CLI's own config.
USERNAME="${KAGGLE_USERNAME:-}"
if [ -z "$USERNAME" ] && [ -f "$HOME/.kaggle/kaggle.json" ]; then
  chmod 600 "$HOME/.kaggle/kaggle.json"
  USERNAME="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.kaggle/kaggle.json'))).get('username',''))")"
fi
[ -z "$USERNAME" ] && USERNAME="$("$KAGGLE" config view 2>/dev/null | awk -F': *' '/username/{print $2; exit}')"
if [ -z "$USERNAME" ]; then
  echo "Kaggle isn't signed in. On kaggle.com: your picture → Settings → API → Create New Token, then:"
  echo "  mkdir -p ~/.kaggle && mv ~/Downloads/kaggle.json ~/.kaggle/ && chmod 600 ~/.kaggle/kaggle.json"
  exit 1
fi
echo "Kaggle account: $USERNAME"

DATASET="$USERNAME/koala-pack-$SLUG"
KERNEL="$USERNAME/koala-i2v-$SLUG"
STAGE=".produce/kaggle/$SLUG"
rm -rf "$STAGE" && mkdir -p "$STAGE/data" "$STAGE/kernel"

# Settings travel with the pack so the notebook needs no editing.
node -e '
  const fs = require("fs");
  const b = JSON.parse(fs.readFileSync("characters.json", "utf8"));
  const p = JSON.parse(fs.readFileSync(process.argv[1] + "/prompts.json", "utf8"));
  p.settings = { seed: b.seed, ...(b.kaggle || {}) };
  fs.writeFileSync(process.argv[2] + "/prompts.json", JSON.stringify(p, null, 2));
' "$PACK" "$STAGE/data"
cp "$PACK"/shot*.png "$STAGE/data/"
cat > "$STAGE/data/dataset-metadata.json" <<JSON
{ "title": "koala-pack-$SLUG", "id": "$DATASET", "licenses": [{ "name": "CC0-1.0" }] }
JSON

echo "1/4  uploading the pack (private)…"
if "$KAGGLE" datasets status "$DATASET" >/dev/null 2>&1; then
  "$KAGGLE" datasets version -p "$STAGE/data" -m "update" -q >/dev/null
else
  "$KAGGLE" datasets create -p "$STAGE/data" -q >/dev/null
fi
for _ in $(seq 1 60); do
  s="$("$KAGGLE" datasets status "$DATASET" 2>/dev/null || true)"
  [[ "$s" == *ready* ]] && break
  sleep 10
done

echo "2/4  starting the GPU notebook…"
cp kaggle/koala_i2v.py "$STAGE/kernel/"
cat > "$STAGE/kernel/kernel-metadata.json" <<JSON
{
  "id": "$KERNEL",
  "title": "koala-i2v-$SLUG",
  "code_file": "koala_i2v.py",
  "language": "python",
  "kernel_type": "script",
  "is_private": true,
  "enable_gpu": true,
  "enable_internet": true,
  "dataset_sources": ["$DATASET"]
}
JSON
"$KAGGLE" kernels push -p "$STAGE/kernel"

echo "3/4  animating on Kaggle — usually 1–3 hours. Safe to leave; checks every 2 minutes."
echo "     Watch it live: https://www.kaggle.com/code/$KERNEL"
START=$(date +%s)
while :; do
  sleep 120
  s="$("$KAGGLE" kernels status "$KERNEL" 2>&1 || true)"
  mins=$(( ($(date +%s) - START) / 60 ))
  case "$s" in
    *COMPLETE*|*complete*) echo "     finished after ${mins} min"; break ;;
    *ERROR*|*error*|*CANCEL*|*cancel*) echo "     Kaggle reports a problem after ${mins} min: $s"; break ;;
    *) echo "     still running (${mins} min)" ;;
  esac
done

echo "4/4  downloading clips…"
"$KAGGLE" kernels output "$KERNEL" -p "$PACK" >/dev/null || true
echo
[ -f "$PACK/log.txt" ] && tail -n 8 "$PACK/log.txt"
n=$(ls "$PACK"/shot*.mp4 2>/dev/null | wc -l | tr -d ' ')
echo
if [ "$n" -gt 0 ]; then
  echo "$n clip(s) in $PACK. Build the episode with:"
  echo "  node produce.mjs \"$(node -p "require('./$PACK/prompts.json').idea")\" --assemble --motion clips"
else
  echo "No clips came back. Send Claude the lines above (from $PACK/log.txt)."
  exit 1
fi
