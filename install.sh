#!/usr/bin/env bash
# OmniVoice Studio — one-shot installer for macOS (Apple Silicon).
#
# Run this once, then `./run.sh` each time you want to use the app.
# Needs: macOS 12+ on M-series, internet (first run downloads ~5 GB of
# ML model weights), and access to run Homebrew/xcode-select if missing.
#
# Usage:
#   bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── pretty logging ──────────────────────────────────────────────────────────
BOLD=$(tput bold 2>/dev/null || echo "")
DIM=$(tput dim 2>/dev/null || echo "")
GREEN=$(tput setaf 2 2>/dev/null || echo "")
YELLOW=$(tput setaf 3 2>/dev/null || echo "")
RED=$(tput setaf 1 2>/dev/null || echo "")
RESET=$(tput sgr0 2>/dev/null || echo "")

step()  { printf "\n${BOLD}${GREEN}▸ %s${RESET}\n"  "$*"; }
note()  { printf "${DIM}  %s${RESET}\n"            "$*"; }
warn()  { printf "${YELLOW}  ⚠  %s${RESET}\n"      "$*"; }
die()   { printf "${RED}  ✗  %s${RESET}\n" "$*" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ── sanity ───────────────────────────────────────────────────────────────────
step "Checking platform"
if [[ "$(uname -s)" != "Darwin" ]]; then
  die "This installer is macOS-only. You're on $(uname -s)."
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  warn "Not on Apple Silicon ($(uname -m)). MLX Whisper will fall back to CPU Whisper — slower but works."
fi
note "macOS $(sw_vers -productVersion) · $(uname -m)"

# ── Xcode Command Line Tools ─────────────────────────────────────────────────
step "Xcode Command Line Tools"
if ! xcode-select -p >/dev/null 2>&1; then
  note "Not found — installing. A macOS dialog will appear; click Install."
  xcode-select --install || true
  until xcode-select -p >/dev/null 2>&1; do
    note "Waiting for install to finish…"
    sleep 10
  done
fi
note "OK ($(xcode-select -p))"

# ── Homebrew ─────────────────────────────────────────────────────────────────
step "Homebrew"
if ! have brew; then
  note "Installing Homebrew (you may be prompted for your password)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Put brew on PATH for this session (Apple Silicon default prefix)
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi
note "OK ($(brew --version | head -n1))"

# ── ffmpeg (audio/video mux) ─────────────────────────────────────────────────
step "ffmpeg"
if ! have ffmpeg; then
  brew install ffmpeg
fi
note "OK ($(ffmpeg -version | head -n1 | cut -d' ' -f1-3))"

# ── uv (Python package manager) ──────────────────────────────────────────────
step "uv (Python manager)"
if ! have uv; then
  brew install uv || curl -LsSf https://astral.sh/uv/install.sh | sh
  # Put ~/.local/bin on PATH for this session if that's where uv landed
  export PATH="$HOME/.local/bin:$PATH"
fi
note "OK ($(uv --version))"

# ── bun (JS runtime for the frontend) ────────────────────────────────────────
step "bun (JS runtime)"
if ! have bun; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
note "OK ($(bun --version))"

# ── Python deps via uv ───────────────────────────────────────────────────────
step "Python dependencies"
note "This can take 5–10 min the first time (torch + torchaudio + demucs…)"
uv sync
note "OK — virtualenv at .venv/"

# ── Frontend deps + build ────────────────────────────────────────────────────
step "Frontend dependencies"
(cd frontend && bun install)
note "OK"

step "Building frontend bundle"
(cd frontend && bun run build)
note "OK — output at frontend/dist/"

# ── done ────────────────────────────────────────────────────────────────────
cat <<EOF

${BOLD}${GREEN}✓ Install complete.${RESET}

To start OmniVoice Studio, run:

    ${BOLD}./run.sh${RESET}

First launch will download ~5 GB of ML model weights (OmniVoice TTS + Whisper).
After that, launches are instant.

${DIM}Logs land in ~/Library/Application Support/OmniVoice/omnivoice.log${RESET}
EOF
