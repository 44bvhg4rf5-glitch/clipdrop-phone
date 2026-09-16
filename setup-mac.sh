#!/bin/bash
# setup-mac.sh — one-time setup for the local half of ClipDrop.
#
#   bash setup-mac.sh
#
# Installs the four tools the pipeline shells out to, plus the speech model
# used for auto-captions. Safe to re-run: everything here is idempotent.

set -u
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad() { printf '  \033[31mfail\033[0m %s\n' "$*"; }

say "ClipDrop · local setup"
printf '  %s · %s\n' "$(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)" "$(uname -m)"

# ── Homebrew ──────────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (it will ask for your Mac password)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || {
    bad "Homebrew install failed — stopping here"; exit 1; }
  # Apple Silicon puts brew somewhere the default PATH doesn't look.
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$p" ] && eval "$("$p" shellenv)"
  done
fi
command -v brew >/dev/null 2>&1 && ok "homebrew $(brew --version | head -1 | awk '{print $2}')" || { bad "brew still not on PATH"; exit 1; }

# ── tools ─────────────────────────────────────────────────────
say "Installing tools"
for pkg in node ffmpeg yt-dlp whisper-cpp gh; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    ok "$pkg (already installed)"
  else
    printf '  installing %s…\n' "$pkg"
    brew install "$pkg" >/dev/null 2>&1 && ok "$pkg" || bad "$pkg — check 'brew install $pkg' by hand"
  fi
done

# ── the bits the pipeline actually needs ──────────────────────
say "Checking what the pipeline needs"
command -v node   >/dev/null 2>&1 && ok "node $(node -v)"            || bad "node missing"
command -v yt-dlp >/dev/null 2>&1 && ok "yt-dlp $(yt-dlp --version)" || bad "yt-dlp missing"

if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"
  # Apple's hardware encoder: much faster than libx264 and far easier on a battery.
  if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
    ok "h264_videotoolbox (hardware encoding available)"
  else
    printf '       no videotoolbox — will fall back to libx264 (slower, hotter)\n'
  fi
  ffmpeg -hide_banner -filters 2>/dev/null | grep -q " subtitles " \
    && ok "subtitles filter (captions can be burnt in)" \
    || bad "no subtitles filter — captions will be skipped"
else
  bad "ffmpeg missing"
fi

# ── GitHub sign-in ────────────────────────────────────────────
# Publishing means pushing. GitHub stopped accepting passwords over git years
# ago, so without this the first push fails with an authentication error that
# looks nothing like "you need to log in".
say "GitHub sign-in"
if gh auth status >/dev/null 2>&1; then
  ok "signed in as $(gh api user --jq .login 2>/dev/null || echo 'github user')"
else
  printf '  Not signed in yet. Run this, then come back:\n\n    gh auth login\n\n'
  printf '  Choose: GitHub.com -> HTTPS -> Yes (authenticate git) -> Login with a web browser\n'
fi

# git needs an identity before it will make a commit at all.
if [ -z "$(git config --global user.name 2>/dev/null)" ]; then
  git config --global user.name "$(id -F 2>/dev/null || echo 'ClipDrop User')"
  ok "set a git name (was blank, commits would have failed)"
fi
if [ -z "$(git config --global user.email 2>/dev/null)" ]; then
  git config --global user.email "$(gh api user --jq '.id|tostring + "+" + (env.USER//"user") + "@users.noreply.github.com"' 2>/dev/null || echo "clipdrop@users.noreply.github.com")"
  ok "set a git email (was blank)"
fi

# ── speech model for captions ─────────────────────────────────
say "Speech model for auto-captions"
MODEL_DIR="$HOME/.clipdrop"
MODEL="$MODEL_DIR/ggml-base.en.bin"
mkdir -p "$MODEL_DIR"
if [ -f "$MODEL" ] && [ "$(wc -c < "$MODEL")" -gt 100000000 ]; then
  ok "model already downloaded ($(( $(wc -c < "$MODEL") / 1048576 )) MB)"
else
  printf '  downloading (~142 MB, one time)…\n'
  curl -fL --progress-bar -o "$MODEL.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
    && mv "$MODEL.part" "$MODEL" && ok "model downloaded" \
    || { rm -f "$MODEL.part"; bad "model download failed — captions will be skipped, everything else still works"; }
fi

for c in whisper-cli whisper-cpp whisper; do
  command -v "$c" >/dev/null 2>&1 && { ok "$c (transcriber)"; break; }
done

say "Done"
cat <<'EOF'
  Build a drop now:      bash drop-local.sh
  See what it would pick without rendering:
                         CLIPDROP_RUNNER=local node clipdrop.mjs --dry

  It will refuse to run on battery. Plug in first.
EOF
