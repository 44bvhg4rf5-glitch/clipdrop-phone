#!/bin/bash
# notify.sh "Title" "Message" — push to the phone through ntfy (free app).
# Does nothing unless the NTFY_TOPIC secret is set. Tapping opens the app.
[ -z "${NTFY_TOPIC:-}" ] && exit 0
curl -s -o /dev/null -H "Title: $1" -H "Click: https://44bvhg4rf5-glitch.github.io/clipdrop-phone/app/" \
  -H "Tags: clapper" -d "$2" "https://ntfy.sh/${NTFY_TOPIC}" || true
