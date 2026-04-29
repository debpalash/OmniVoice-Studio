#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# desktop-prod.sh — Build & launch OmniVoice Studio as a "fresh install"
#
# This gives you the EXACT same experience as a user downloading the
# installer (DMG on macOS, AppImage on Linux):
#   • Full Rust bootstrap (venv creation, uv sync, model setup)
#   • Splash screen with live logs
#   • Region selector, version badge, etc.
#
# Usage:
#   bun desktop-prod          # build debug + wipe + launch
#   bun desktop-prod:run      # re-launch last build (skip compile)
#   bun desktop-prod:upgrade  # rebuild, but keep data (test upgrade)
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_ID="com.debpalash.omnivoice-studio"
TAURI_DIR="frontend/src-tauri"
APP_NAME="OmniVoice Studio"

# ── Detect platform ───────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      echo "❌ Unsupported platform: $OS"; exit 1 ;;
esac

# ── Platform-specific paths ───────────────────────────────────────────────
if [ "$PLATFORM" = "macos" ]; then
  APP_DATA="$HOME/Library/Application Support/${APP_ID}"
  TAURI_LOGS="$HOME/Library/Logs/${APP_ID}"
  WEBKIT_DATA="$HOME/Library/WebKit/${APP_ID}"
else
  # Linux: XDG conventions
  APP_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/${APP_ID}"
  TAURI_LOGS="${XDG_DATA_HOME:-$HOME/.local/share}/${APP_ID}/logs"
  WEBKIT_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/${APP_ID}/webview"
fi

# HF cache — where downloaded models live
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}"

# ── Flags ──────────────────────────────────────────────────────────────────
SKIP_BUILD=false
KEEP_DATA=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --keep-data)  KEEP_DATA=true ;;
    -h|--help)
      echo "Usage: $0 [--skip-build] [--keep-data]"
      echo ""
      echo "  --skip-build  Skip cargo build, use last compiled binary"
      echo "  --keep-data   Don't wipe app data (test upgrade path)"
      exit 0
      ;;
  esac
done

# ── Wipe app data for fresh-install simulation ─────────────────────────────
if [ "$KEEP_DATA" = false ]; then
  echo "🧹 Cleaning all OmniVoice data for fresh prod emulation..."
  echo ""

  # 1. App data (venv, config, bundled backend)
  if [ -d "${APP_DATA}" ]; then
    echo "   ✗ App data:     ${APP_DATA}"
    rm -rf "${APP_DATA}"
  else
    echo "   ○ App data:     (already clean)"
  fi

  # 2. HF model cache (downloaded .safetensors, tokenizers, etc.)
  if [ -d "${HF_CACHE}" ]; then
    HF_SIZE=$(du -sh "${HF_CACHE}" 2>/dev/null | cut -f1)
    echo "   ✗ HF cache:     ${HF_CACHE} (${HF_SIZE})"
    rm -rf "${HF_CACHE}"
  else
    echo "   ○ HF cache:     (already clean)"
  fi

  # 3. Tauri log dir
  if [ -d "${TAURI_LOGS}" ]; then
    echo "   ✗ Tauri logs:   ${TAURI_LOGS}"
    rm -rf "${TAURI_LOGS}"
  else
    echo "   ○ Tauri logs:   (already clean)"
  fi

  # 4. WebView cache / local storage
  if [ -d "${WEBKIT_DATA}" ]; then
    echo "   ✗ WebKit data:  ${WEBKIT_DATA}"
    rm -rf "${WEBKIT_DATA}"
  else
    echo "   ○ WebKit data:  (already clean)"
  fi

  echo ""
  echo "   ✅ All clean — next launch bootstraps from zero."
else
  echo "📦 Keeping existing app data (upgrade test mode)"
fi

# ── Build debug binary ─────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo ""
  echo "🔨 Building debug bundle (this takes 1-3 min first time)..."

  # Remove stale bundle so we never accidentally launch old code
  if [ "$PLATFORM" = "macos" ]; then
    APP_BUNDLE="${TAURI_DIR}/target/debug/bundle/macos/${APP_NAME}.app"
    [ -d "$APP_BUNDLE" ] && rm -rf "$APP_BUNDLE"
  fi

  # Linux: linuxdeploy uses FUSE to mount itself; if FUSE is unavailable
  # (containers, some hardened kernels), set APPIMAGE_EXTRACT_AND_RUN=1 to
  # extract-and-run instead. Safe to always set on Linux.
  if [ "$PLATFORM" = "linux" ]; then
    export APPIMAGE_EXTRACT_AND_RUN=1
  fi

  # The build creates the bundle successfully, but then may fail trying
  # to sign the updater artifact (no TAURI_SIGNING_PRIVATE_KEY) or to
  # run linuxdeploy. The binary itself is fine — tolerate known errors.
  BUILD_LOG=$(mktemp)
  cd frontend
  set +e
  bunx tauri build --debug 2>&1 | tee "$BUILD_LOG"
  BUILD_EXIT=$?
  set -e
  cd ..
  if [ $BUILD_EXIT -ne 0 ]; then
    # Known-harmless failures:
    #   - Missing TAURI_SIGNING_PRIVATE_KEY (updater signing)
    #   - "failed to run linuxdeploy" (AppImage bundling — binary still works)
    if grep -qi "TAURI_SIGNING_PRIVATE_KEY\|private key\|failed to run linuxdeploy\|failed to bundle" "$BUILD_LOG"; then
      echo "⚠️  Non-fatal bundle error — binary is fine (see above for details)."
    else
      echo "❌ Build failed with exit code $BUILD_EXIT"
      rm -f "$BUILD_LOG"
      exit $BUILD_EXIT
    fi
  fi
  rm -f "$BUILD_LOG"

  echo "✅ Build complete."
else
  echo "⏭️  Skipping build (--skip-build)"
fi

# ── Find and launch the app ────────────────────────────────────────────────
if [ "$PLATFORM" = "macos" ]; then
  APP_BUNDLE="${TAURI_DIR}/target/debug/bundle/macos/${APP_NAME}.app"
  BINARY="${TAURI_DIR}/target/debug/app"

  if [ -d "$APP_BUNDLE" ]; then
    echo ""
    echo "🚀 Launching ${APP_NAME} (.app bundle)..."
    echo "   Bundle: ${APP_BUNDLE}"
    open "$APP_BUNDLE"
  elif [ -f "$BINARY" ]; then
    echo ""
    echo "🚀 Launching ${APP_NAME} (raw binary — no .app bundle)..."
    echo "   Binary: ${BINARY}"
    "$BINARY" &
  else
    echo "❌ No bundle or binary found. Run without --skip-build first."
    exit 1
  fi
else
  # Linux: prefer AppImage, fall back to raw binary
  APPIMAGE=$(find "${TAURI_DIR}/target/debug/bundle/appimage" -name "*.AppImage" -type f 2>/dev/null | head -1)
  BINARY="${TAURI_DIR}/target/debug/app"

  if [ -n "$APPIMAGE" ] && [ -f "$APPIMAGE" ]; then
    echo ""
    echo "🚀 Launching ${APP_NAME} (AppImage)..."
    echo "   AppImage: ${APPIMAGE}"
    chmod +x "$APPIMAGE"
    "$APPIMAGE" &
  elif [ -f "$BINARY" ]; then
    echo ""
    echo "🚀 Launching ${APP_NAME} (raw binary)..."
    echo "   Binary: ${BINARY}"
    "$BINARY" &
  else
    echo "❌ No AppImage or binary found. Run without --skip-build first."
    exit 1
  fi
fi

echo "   App data: ${APP_DATA}"
echo ""
echo "✅ App launched. Check the splash screen for bootstrap logs."
echo "   To re-run without rebuilding: bun desktop-prod:run"
