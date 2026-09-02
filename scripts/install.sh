#!/bin/sh
# VoiceStudio — universal installer.
#
# Default mode installs the prebuilt desktop app from GitHub Releases
# (verified against the published SHA256SUMS). Use --source to clone and
# build from source instead.
#
# Usage:
#   curl -fsSL https://voicestudio.sh/install | sh
#       Install the latest prebuilt app (macOS dmg / Linux AppImage).
#
#   curl -fsSL https://voicestudio.sh/install | sh -s -- --version 0.5.2
#       Install a specific release.
#
#   curl -fsSL https://voicestudio.sh/install | sh -s -- --source
#       Clone the repo and build from source instead (installs system deps,
#       Python via uv, frontend via bun). Run ./run.sh afterwards.
#
# Options:
#   --binary          Prebuilt app from GitHub Releases (default)
#   --source          Clone and build from source
#   --version X.Y.Z   Release version in binary mode (default: latest)
#   --python V        Source mode: Python version for uv (default 3.11)
#   --verbose         Show all subcommand output
#   --help            This help
#
# Windows: run the PowerShell installer instead (`irm https://voicestudio.sh/install | iex`)
# or this script inside WSL.
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

show_usage() {
    cat <<'USAGE'
VoiceStudio installer

  curl -fsSL https://voicestudio.sh/install | sh
      Install the latest prebuilt app (macOS dmg / Linux AppImage).

  curl -fsSL https://voicestudio.sh/install | sh -s -- --version X.Y.Z
      Install a specific release.

  curl -fsSL https://voicestudio.sh/install | sh -s -- --source
      Clone and build from source (system deps + uv + bun).

Options:
  --binary          Prebuilt app from GitHub Releases (default)
  --source          Clone and build from source
  --version X.Y.Z   Release version in binary mode (default: latest)
  --python V        Source mode: Python version for uv (default 3.11)
  --verbose         Show all subcommand output
USAGE
}

# ── Parse flags ─────────────────────────────────────────────────────────────
MODE="binary"
VERBOSE=false
_USER_PYTHON=""
_VERSION_ARG=""
_expect=""
for arg in "$@"; do
    if [ "$_expect" = "python" ]; then
        _USER_PYTHON="$arg"; _expect=""
        continue
    fi
    if [ "$_expect" = "version" ]; then
        _VERSION_ARG="$arg"; _expect=""
        continue
    fi
    case "$arg" in
        --binary)        MODE="binary" ;;
        --source)        MODE="source" ;;
        --version)       _expect="version" ;;
        --verbose|-v)    VERBOSE=true ;;
        --python)        _expect="python" ;;
        --help|-h)       show_usage; exit 0 ;;
        *)               echo "Unknown option: $arg (see --help)" >&2; exit 1 ;;
    esac
done
[ -z "$_expect" ] || { echo "--$_expect requires a value" >&2; exit 1; }

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
case "$(uname -s)" in
    Darwin)               OS="macos" ;;
    MINGW*|MSYS*|CYGWIN*)  OS="windows" ;;
    *) if grep -qi microsoft /proc/version 2>/dev/null; then OS="wsl"; fi ;;
esac

if [ "$OS" = "windows" ]; then
    echo "⚠  This script handles macOS / Linux only."
    echo "   On Windows, run the PowerShell installer instead:"
    echo "     irm https://voicestudio.sh/install | iex"
    echo "   (or download the VoiceStudio installer (.msi) from the Releases page,"
    echo "    or run this script inside WSL)."
    exit 0
fi
ARCH=$(uname -m)

echo ""
printf "  ${C_TITLE}%s${C_RST}\n" "🎙 VoiceStudio Installer"
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

# ── Binary install (default): prebuilt app from GitHub Releases ────────────
REPO_DOWNLOADS="https://github.com/debpalash/VoiceStudio/releases/download"
REPO_LATEST="https://github.com/debpalash/VoiceStudio/releases/latest/download"

strip_v() { printf '%s' "${1#v}"; }

resolve_latest_version() {
    _tmp=$(mktemp)
    download "$REPO_LATEST/latest.json" "$_tmp" || die "Could not fetch the latest release manifest."
    _v=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$_tmp" | head -n1)
    rm -f "$_tmp"
    [ -n "$_v" ] || die "Could not resolve the latest release version."
    printf '%s' "$_v"
}

verify_sha256() { # <file> <sums-file> <asset-name>
    if have shasum; then
        _actual=$(shasum -a 256 "$1" | awk '{print $1}')
    elif have sha256sum; then
        _actual=$(sha256sum "$1" | awk '{print $1}')
    else
        warn "No sha256 tool found — skipping checksum verification."
        return 0
    fi
    _expected=$(grep -F "$3" "$2" | awk '{print $1}' | head -n1)
    [ -n "$_expected" ] || die "Checksum entry for $3 not found in $(basename "$2")."
    [ "$_actual" = "$_expected" ] || die "Checksum mismatch for $3 — download corrupted?"
    step "checksum" "OK"
}

install_binary() {
    if [ -n "$_VERSION_ARG" ]; then
        VERSION="$(strip_v "$_VERSION_ARG")"
    else
        step "release" "resolving latest version..."
        VERSION="$(strip_v "$(resolve_latest_version)")"
    fi
    step "release" "v$VERSION"

    BASE="$REPO_DOWNLOADS/v$VERSION"
    case "$OS" in
        macos)
            case "$ARCH" in
                arm64)
                    ASSET="VoiceStudio_${VERSION}_aarch64.dmg"
                    SUMS="SHA256SUMS-macOS.Apple.Silicon.txt" ;;
                x86_64)
                    ASSET="VoiceStudio_${VERSION}_x64.dmg"
                    SUMS="SHA256SUMS-macOS.Intel.txt" ;;
                *)
                    die "Unsupported macOS architecture: $ARCH" ;;
            esac
            ;;
        *)
            case "$ARCH" in
                x86_64)
                    ASSET="VoiceStudio_${VERSION}_amd64.AppImage"
                    SUMS="SHA256SUMS-Linux.x64.txt" ;;
                *)
                    die "No prebuilt Linux build for $ARCH yet. Try --source, or the Docker image." ;;
            esac
            ;;
    esac

    TMP=$(mktemp -d)
    step "download" "$ASSET"
    note "~100–230 MB depending on platform; runs through your GitHub connection."
    download "$BASE/$ASSET" "$TMP/$ASSET" || die "Download failed. Check your network or try --version with an older release."
    step "download" "$(du -h "$TMP/$ASSET" | cut -f1)"

    step "checksum" "verifying..."
    download "$BASE/$SUMS" "$TMP/$SUMS" || die "Could not fetch $SUMS."
    verify_sha256 "$TMP/$ASSET" "$TMP/$SUMS" "$ASSET"

    case "$OS" in
        macos)
            step "install" "mounting disk image..."
            MOUNT_DIR=$(hdiutil attach -nobrowse "$TMP/$ASSET" | awk -F'\t' '/\/Volumes\//{print $NF}')
            [ -n "$MOUNT_DIR" ] || die "Could not mount $ASSET"
            APP_SRC=$(find "$MOUNT_DIR" -maxdepth 1 -name "*.app" | head -n1)
            if [ -z "$APP_SRC" ]; then
                hdiutil detach "$MOUNT_DIR" -quiet || true
                die "No .app bundle found inside $ASSET"
            fi
            APP_NAME=$(basename "$APP_SRC")
            DEST_DIR="/Applications"
            if [ ! -w "/Applications" ]; then
                DEST_DIR="$HOME/Applications"
                mkdir -p "$DEST_DIR"
                note "Applications folder not writable — installing to ~/Applications instead."
            fi
            step "install" "$DEST_DIR/$APP_NAME"
            if [ -d "$DEST_DIR/$APP_NAME" ]; then
                rm -rf "$DEST_DIR/$APP_NAME"
            fi
            ditto "$APP_SRC" "$DEST_DIR/$APP_NAME"
            hdiutil detach "$MOUNT_DIR" -quiet || true
            ;;
        *)
            BIN_DIR="$HOME/.local/bin"
            mkdir -p "$BIN_DIR"
            step "install" "$BIN_DIR/VoiceStudio"
            if ! cp "$TMP/$ASSET" "$BIN_DIR/VoiceStudio"; then
                rm -rf "$TMP"
                die "Could not write to $BIN_DIR"
            fi
            chmod +x "$BIN_DIR/VoiceStudio"
            case ":$PATH:" in
                *":$BIN_DIR:"*) ;;
                *) note "Add ~/.local/bin to your PATH to launch VoiceStudio from anywhere." ;;
            esac
            ;;
    esac
    rm -rf "$TMP"

    if ! have ffmpeg; then
        warn "ffmpeg not found — VoiceStudio needs it at runtime."
        if [ "$OS" = "macos" ]; then
            note "Install it with: brew install ffmpeg"
        else
            note "Install it with your package manager (e.g. sudo apt install ffmpeg)."
        fi
    fi

    echo ""
    printf "  ${C_TITLE}%s${C_RST}\n" "✓ Install complete!"
    printf "  ${C_DIM}%s${C_RST}\n" "$RULE"
    echo ""
    if [ "$OS" = "macos" ]; then
        step "next" "Open VoiceStudio from Applications, or run: open -a VoiceStudio"
    else
        step "next" "Run VoiceStudio from ~/.local/bin (or your app launcher)"
    fi
    echo ""
    note "First launch downloads ML model weights (~5 GB). After that, launches are instant."
    echo ""
}

if [ "$MODE" = "binary" ]; then
    install_binary
    exit 0
fi

# ── Source mode: clone and build ────────────────────────────────────────────
step "mode" "building from source (clones the repo — use --binary for the prebuilt app)"
echo ""

install_source() {

    # ── Resolve repo root (for local installs) ─────────────────────────────────
    # The script lives in scripts/, so the project root may be one level up.
    SCRIPT_DIR=""
    if [ -n "${0:-}" ] && [ -f "$0" ]; then
        _script_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || true
        if [ -f "$_script_dir/pyproject.toml" ]; then
            SCRIPT_DIR="$_script_dir"
        elif [ -f "$_script_dir/../pyproject.toml" ]; then
            SCRIPT_DIR=$(cd "$_script_dir/.." 2>/dev/null && pwd) || true
        fi
    fi
    if [ -z "$SCRIPT_DIR" ]; then
        if [ -f "./pyproject.toml" ]; then
            SCRIPT_DIR=$(pwd)
        else
            SCRIPT_DIR=""
        fi
    fi

    # If run via curl pipe, clone the repo first
    if [ ! -f "$SCRIPT_DIR/pyproject.toml" ]; then
        step "clone" "downloading VoiceStudio..."
        INSTALL_DIR="$HOME/VoiceStudio"
        if [ -d "$INSTALL_DIR/.git" ]; then
            note "Updating existing clone at $INSTALL_DIR"
            (cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null || true)
        else
            if have git; then
                git clone --depth 1 https://github.com/debpalash/VoiceStudio.git "$INSTALL_DIR"
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
    if ! have uv; then
        die "uv installation failed. Install manually: curl -LsSf https://astral.sh/uv/install.sh | sh"
    fi
    step "uv" "$(uv --version 2>/dev/null)"

    # ── Install bun (JS runtime for frontend) ──────────────────────────────────
    step "bun" "checking..."
    if ! have bun; then
        note "Installing bun..."
        # Fetch to a temp file instead of `curl | sh`: if the download fails,
        # piping would run an empty script and exit 0, hiding the failure until
        # `bun: command not found` much later (seen on a GitHub runner).
        _bun_tmp=$(mktemp)
        if download "https://bun.sh/install" "$_bun_tmp" && [ -s "$_bun_tmp" ]; then
            run_quiet sh "$_bun_tmp" </dev/null || true
        fi
        rm -f "$_bun_tmp"
        export PATH="$HOME/.bun/bin:$PATH"
        if ! have bun && have npm; then
            note "Falling back to npm install -g bun..."
            run_quiet npm install -g bun </dev/null || true
        fi
    fi
    have bun || die "bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash"
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

    # Restricted-network support: when OMNIVOICE_REGION is set to china/russia/restricted,
    # route python-build-standalone downloads through ghproxy.net. See issues #57, #60.
    # Honors any existing UV_* env vars (power-user override).
    case "${OMNIVOICE_REGION:-}" in
        china|russia|restricted)
            : "${UV_PYTHON_INSTALL_MIRROR:=https://ghproxy.net/https://github.com/astral-sh/python-build-standalone/releases/download}"
            export UV_PYTHON_INSTALL_MIRROR
            note "Using ghproxy.net mirror for Python download (OMNIVOICE_REGION=${OMNIVOICE_REGION})"
            ;;
    esac
    : "${UV_HTTP_TIMEOUT:=120}"
    : "${UV_HTTP_RETRIES:=5}"
    export UV_HTTP_TIMEOUT UV_HTTP_RETRIES

    # Create venv with the target Python version if it doesn't exist.
    # If the managed-python download fails (restricted network, mirror unreachable),
    # fall back to the user's system Python.
    if [ ! -d .venv ]; then
        if ! uv venv --python "$PYTHON_VERSION"; then
            warn "uv venv failed (likely Python download). Retrying with system Python..."
            uv venv --python "$PYTHON_VERSION" --python-preference only-system \
                || die "uv venv failed: install Python $PYTHON_VERSION system-wide, set OMNIVOICE_REGION=china|russia|restricted to route through a mirror, or check your network."
        fi
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
        *)     LOG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/VoiceStudio" ;;
    esac
    mkdir -p "$LOG_DIR"

    # ── Done ────────────────────────────────────────────────────────────────────
    echo ""
    printf "  ${C_TITLE}%s${C_RST}\n" "✓ Install complete!"
    printf "  ${C_DIM}%s${C_RST}\n" "$RULE"
    echo ""
    step "next" "Run ./run.sh to start VoiceStudio"
    echo ""
    note "First launch downloads ~5 GB of ML model weights (VoiceStudio TTS + Whisper)."
    note "After that, launches are instant."
    echo ""
    note "GPU: $GPU_INFO"
    note "Logs: $LOG_DIR/omnivoice.log"
    echo ""

}

install_source
