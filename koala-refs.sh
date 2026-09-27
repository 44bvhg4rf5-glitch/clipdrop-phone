#!/bin/bash
# koala-refs.sh — send your approved Pip & Willow pictures to GitHub as the
# "this is what they look like" guide for the nightly cloud episodes.
#
#   ./koala-refs.sh packs/rain/shot2.png packs/rain/shot4.png
#
# Pick 1–4 pictures where both koalas look exactly right (a clear two-shot is
# best). They replace any earlier set.

set -euo pipefail
cd "$(dirname "$0")"
[ $# -ge 1 ] || { echo "usage: ./koala-refs.sh <picture> [picture…]   (1–4 pictures)"; exit 1; }
[ $# -le 4 ] || { echo "Use at most 4 pictures."; exit 1; }
for f in "$@"; do [ -f "$f" ] || { echo "Can't find $f"; exit 1; }; done

git pull --rebase --autostash --quiet origin main
rm -rf koala/refs && mkdir -p koala/refs
i=1
for f in "$@"; do
  ext="$(printf '%s' "${f##*.}" | tr '[:upper:]' '[:lower:]')"
  cp "$f" "koala/refs/ref$i.$ext"
  i=$((i + 1))
done
[ -z "$(git config user.name 2>/dev/null)" ] && git config user.name "ClipDrop User"
[ -z "$(git config user.email 2>/dev/null)" ] && git config user.email "clipdrop@users.noreply.github.com"
git add koala/refs
git commit --quiet -m "koala: reference pictures ($#)" || { echo "Those pictures are already the references."; exit 0; }
git push --quiet origin main
echo "Done — $# reference picture(s) are on GitHub. Tonight's episode will match them."
