#!/bin/sh
# OmniVoice Studio — universal installer.
#
# Works on macOS (ARM + Intel), Linux (Debian/Ubuntu, Fedora, Arch), and WSL.
# Run once, then `./run.sh` each time you want to use the app.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/debpalash/OmniVoice-Studio/main/install.sh | sh
#   # or locally:
#   sh install.sh
#   sh install.sh --verbose        # show all subcommand output
#   sh install.sh --python 3.12    # override Python version
set -e

# ── Output style ────────────────────────────────────────────────────────────
RULE=""
_rule_i=0
while [ "$_rule_i" -lt 56 ]; do
    RULE="${RULE}─"
    _rule_i=$((_rule_i + 1))
done

if [ -n "${NO_COLOR:-}" ]; then
    C_TITLE="" C_DIM="" C_OK="" C_WARN="" C_ERR="" C_RST=""
elif [ -t 1 ] || [ -n "${FORCE_COLOR:-}" ]; then
    _ESC="$(printf '\033')"
    C_TITLE="${_ESC}[1;38;5;141m"   # bold purple
    C_DIM="${_ESC}[38;5;245m"
    C_OK="${_ESC}[38;5;108m"        # green
    C_WARN="${_ESC}[38;5;136m"      # yellow
    C_ERR="${_ESC}[91m"             # red
    C_RST="${_ESC}[0m"
else
    C_TITLE="" C_DIM="" C_OK="" C_WARN="" C_ERR="" C_RST=""
fi

step()  { printf "  ${C_DIM}%-18.18s${C_RST}${3:-$C_OK}%s${C_RST}\n" "$1" "$2"; }
note()  { printf "  ${C_DIM}%-18s${2:-$C_DIM}%s${C_RST}\n" "" "$1"; }
warn()  { printf "  ${C_WARN}⚠  %s${C_RST}\n" "$1"; }
die()   { printf "  ${C_ERR}✗  %s${C_RST}\n" "$1" >&2; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ── Parse flags ─────────────────────────────────────────────────────────────
_VERBOSE=false
_USER_PYTHON=""
_next_is_python=false
for arg in "$@"; do
    if [ "$_next_is_python" = true ]; then
        _USER_PYTHON="$arg"
        _next_is_python=false
        continue
    fi
    case "$arg" in
        --verbose|-v) _VERBOSE=true ;;
        --python)     _next_is_python=true ;;
    esac
done
if [ "$_next_is_python" = true ]; then
    die "--python requires a version argument (e.g. --python 3.12)"
fi

run_quiet() {
    if [ "$_VERBOSE" = true ]; then
        "$@"
    else
        "$@" > /dev/null 2>&1
    fi
}

# ── Helper: download (curl or wget) ────────────────────────────────────────
download() {
    if have curl; then
        curl -LsSf "$1" -o "$2"
    elif have wget; then
        wget -qO "$2" "$1"
    else
        die "Neither curl nor wget found. Install one and re-run."
    fi
}

# ── Helper: open browser (cross-platform) ──────────────────────────────────
open_browser() {
    _url="$1"
    if [ "$(uname)" = "Darwin" ] && have open; then
        open "$_url"
    elif grep -qi microsoft /proc/version 2>/dev/null; then
        # WSL: use Windows browser
        if have powershell.exe; then
            powershell.exe -NoProfile -Command "Start-Process '$_url'" >/dev/null 2>&1 &
        elif have cmd.exe; then
            cmd.exe /c start "" "$_url" >/dev/null 2>&1 &
        elif have xdg-open; then
            xdg-open "$_url" >/dev/null 2>&1 &
        else
            echo "  Open in your browser: $_url"
        fi
    elif have xdg-open; then
        xdg-open "$_url" >/dev/null 2>&1 &
    else
        echo "  Open in your browser: $_url"
    fi
}

# ── Detect platform ────────────────────────────────────────────────────────
OS="linux"
if [ "$(uname)" = "Darwin" ]; then
    OS="macos"
elif grep -qi microsoft /proc/version 2>/dev/null; then
    OS="wsl"
fi
ARCH=$(uname -m)

echo ""
printf "  ${C_TITLE}%s${C_RST}\n" "🎙 OmniVoice Studio Installer"
printf "  ${C_DIM}%s${C_RST}\n" "$RULE"
echo ""

step "platform" "$OS ($ARCH)"

# Detect Rosetta on macOS
if [ "$OS" = "macos" ] && [ "$ARCH" = "x86_64" ]; then
    if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
        warn "Apple Silicon detected running under Rosetta (x86_64)."
        note "Re-run from a native arm64 terminal for full MLX support."
    fi
fi

# ── Resolve script directory (for local installs) ──────────────────────────
SCRIPT_DIR=""
if [ -n "${0:-}" ] && [ -f "$0" ]; then
    SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || true
fi
if [ -z "$SCRIPT_DIR" ]; then
    SCRIPT_DIR=$(pwd)
fi

# If run via curl pipe, clone the repo first
if [ ! -f "$SCRIPT_DIR/pyproject.toml" ]; then
    step "clone" "downloading OmniVoice Studio..."
    INSTALL_DIR="$HOME/OmniVoice"
    if [ -d "$INSTALL_DIR/.git" ]; then
        note "Updating existing clone at $INSTALL_DIR"
        (cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null || true)
    else
        if have git; then
            git clone --depth 1 https://github.com/debpalash/OmniVoice-Studio.git "$INSTALL_DIR"
        else
            die "git is required. Install git and re-run."
        fi
    fi
    SCRIPT_DIR="$INSTALL_DIR"
fi

cd "$SCRIPT_DIR"

# ── Python version ──────────────────────────────────────────────────────────
if [ -n "$_USER_PYTHON" ]; then
    PYTHON_VERSION="$_USER_PYTHON"
    note "Using user-specified Python $PYTHON_VERSION"
else
    PYTHON_VERSION="3.11"
fi

# ── System dependencies ────────────────────────────────────────────────────

# Helper: install system packages with the right package manager
_install_sys_pkgs() {
    case "$OS" in
        macos)
            if ! have brew; then
                note "Installing Homebrew..."
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/null
                if [ -x /opt/homebrew/bin/brew ]; then
                    eval "$(/opt/homebrew/bin/brew shellenv)"
                elif [ -x /usr/local/bin/brew ]; then
                    eval "$(/usr/local/bin/brew shellenv)"
                fi
            fi
            brew install "$@" </dev/null 2>/dev/null || true
            ;;
        linux|wsl)
            if have apt-get; then
                # Try without sudo first, then escalate
                apt-get update -y </dev/null >/dev/null 2>&1 || true
                apt-get install -y "$@" </dev/null >/dev/null 2>&1 || {
                    if have sudo; then
                        echo ""
                        echo "  Need elevated permissions to install: $*"
                        sudo apt-get update -y </dev/null
                        sudo apt-get install -y "$@" </dev/null
                    else
                        die "Cannot install $*. Run as root or install manually."
                    fi
                }
            elif have dnf; then
                sudo dnf install -y "$@" </dev/null 2>/dev/null || true
            elif have yum; then
                sudo yum install -y "$@" </dev/null 2>/dev/null || true
            elif have pacman; then
                sudo pacman -S --noconfirm "$@" 2>/dev/null || true
            else
                warn "No supported package manager found. Please install manually: $*"
            fi
            ;;
    esac
}

# Xcode CLT (macOS only)
if [ "$OS" = "macos" ]; then
    step "xcode" "checking..."
    if ! xcode-select -p >/dev/null 2>&1; then
        note "Installing Xcode Command Line Tools..."
        xcode-select --install </dev/null 2>/dev/null || true
        until xcode-select -p >/dev/null 2>&1; do
            note "Waiting for Xcode CLT install..."
            sleep 10
        done
    fi
    step "xcode" "$(xcode-select -p)"
fi

# ffmpeg (required for audio/video processing)
step "ffmpeg" "checking..."
if ! have ffmpeg; then
    note "Installing ffmpeg..."
    case "$OS" in
        macos)  _install_sys_pkgs ffmpeg ;;
        linux|wsl)
            if have apt-get; then
                _install_sys_pkgs ffmpeg
            elif have dnf; then
                _install_sys_pkgs ffmpeg-free  # Fedora
            elif have pacman; then
                _install_sys_pkgs ffmpeg
            else
                warn "Please install ffmpeg manually."
            fi
            ;;
    esac
fi
if have ffmpeg; then
    step "ffmpeg" "$(ffmpeg -version 2>/dev/null | head -n1 | cut -d' ' -f1-3)"
else
    warn "ffmpeg not found — some features will be unavailable."
fi

# ── Install uv ──────────────────────────────────────────────────────────────
step "uv" "checking..."
UV_MIN_VERSION="0.7.0"

_version_ge() {
    # Returns 0 if $1 >= $2 (dotted version comparison)
    _a=$1; _b=$2
    while [ -n "$_a" ] || [ -n "$_b" ]; do
        _a_part=${_a%%.*}; _b_part=${_b%%.*}
        [ "$_a" = "$_a_part" ] && _a="" || _a=${_a#*.}
        [ "$_b" = "$_b_part" ] && _b="" || _b=${_b#*.}
        [ -z "$_a_part" ] && _a_part=0
        [ -z "$_b_part" ] && _b_part=0
        if [ "$_a_part" -gt "$_b_part" ] 2>/dev/null; then return 0; fi
        if [ "$_a_part" -lt "$_b_part" ] 2>/dev/null; then return 1; fi
    done
    return 0
}

_uv_ok() {
    have uv || return 1
    _raw=$(uv --version 2>/dev/null | awk '{print $2}') || return 1
    [ -n "$_raw" ] || return 1
    _ver=${_raw%%[-+]*}
    _version_ge "$_ver" "$UV_MIN_VERSION"
}

if ! _uv_ok; then
    note "Installing uv package manager..."
    _uv_tmp=$(mktemp)
    download "https://astral.sh/uv/install.sh" "$_uv_tmp"
    run_quiet sh "$_uv_tmp" </dev/null
    rm -f "$_uv_tmp"
    # Source env if uv's installer created it
    if [ -f "$HOME/.local/bin/env" ]; then
        . "$HOME/.local/bin/env"
    fi
    export PATH="$HOME/.local/bin:$PATH"
fi
step "uv" "$(uv --version 2>/dev/null)"

# ── Install bun (JS runtime for frontend) ──────────────────────────────────
step "bun" "checking..."
if ! have bun; then
    note "Installing bun..."
    if have curl; then
        curl -fsSL https://bun.sh/install | sh </dev/null
    else
        die "curl is required to install bun."
    fi
    export PATH="$HOME/.bun/bin:$PATH"
fi
step "bun" "bun $(bun --version 2>/dev/null)"

# ── GPU detection (informational) ──────────────────────────────────────────
step "gpu" "detecting..."
GPU_INFO="CPU only"
if [ "$OS" = "macos" ] && [ "$ARCH" = "arm64" ]; then
    GPU_INFO="Apple Silicon (Metal/MPS)"
elif have nvidia-smi; then
    _gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    _cuda_ver=$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version:[[:space:]]*\([0-9]*\.[0-9]*\).*/\1/p' | head -1)
    if [ -n "$_gpu_name" ]; then
        GPU_INFO="NVIDIA $_gpu_name (CUDA $_cuda_ver)"
    fi
elif have rocminfo; then
    _amd_name=$(rocminfo 2>/dev/null | awk '/Marketing Name:/{$1=$2=""; print; exit}' | sed 's/^ *//')
    if [ -n "$_amd_name" ]; then
        GPU_INFO="AMD $_amd_name (ROCm)"
    fi
fi
step "gpu" "$GPU_INFO"

# ── Python dependencies via uv ──────────────────────────────────────────────
step "python" "syncing dependencies..."
note "This can take 5–10 min the first time (torch + torchaudio + demucs...)"

# Create venv with the target Python version if it doesn't exist
if [ ! -d .venv ]; then
    uv venv --python "$PYTHON_VERSION"
fi

# Sync all deps from pyproject.toml + uv.lock
uv sync

step "python" "OK — virtualenv at .venv/"

# ── Frontend deps + build ──────────────────────────────────────────────────
step "frontend" "installing dependencies..."
(cd frontend && bun install)
step "frontend" "OK"

step "frontend" "building bundle..."
(cd frontend && bun run build)
step "frontend" "OK — output at frontend/dist/"

# ── Log directory ──────────────────────────────────────────────────────────
case "$OS" in
    macos) LOG_DIR="$HOME/Library/Application Support/OmniVoice" ;;
    *)     LOG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/OmniVoice" ;;
esac
mkdir -p "$LOG_DIR"

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
printf "  ${C_TITLE}%s${C_RST}\n" "✓ Install complete!"
printf "  ${C_DIM}%s${C_RST}\n" "$RULE"
echo ""
step "next" "Run ./run.sh to start OmniVoice Studio"
echo ""
note "First launch downloads ~5 GB of ML model weights (OmniVoice TTS + Whisper)."
note "After that, launches are instant."
echo ""
note "GPU: $GPU_INFO"
note "Logs: $LOG_DIR/omnivoice.log"
echo ""
