#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# desktop-prod.sh — Build & launch OmniVoice Studio as a "fresh install"
#
# This gives you the EXACT same experience as a user downloading the DMG:
#   • Full Rust bootstrap (venv creation, uv sync, model setup)
#   • Splash screen with live logs
#   • Region selector, version badge, etc.
#
# Usage:
#   bun desktop-prod          # build debug + wipe + launch
#   bun desktop-prod:run      # re-launch last build (skip compile)
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_ID="com.debpalash.omnivoice-studio"
APP_DATA="$HOME/Library/Application Support/${APP_ID}"
TAURI_DIR="frontend/src-tauri"
APP_NAME="OmniVoice Studio"

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
  TAURI_LOGS="$HOME/Library/Logs/${APP_ID}"
  if [ -d "${TAURI_LOGS}" ]; then
    echo "   ✗ Tauri logs:   ${TAURI_LOGS}"
    rm -rf "${TAURI_LOGS}"
  else
    echo "   ○ Tauri logs:   (already clean)"
  fi

  # 4. WebView cache / local storage
  WEBKIT_DATA="$HOME/Library/WebKit/${APP_ID}"
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
  APP_BUNDLE="${TAURI_DIR}/target/debug/bundle/macos/${APP_NAME}.app"
  [ -d "$APP_BUNDLE" ] && rm -rf "$APP_BUNDLE"

  cd frontend
  # The build creates the .app bundle successfully, but then fails trying
  # to sign the updater artifact (no TAURI_SIGNING_PRIVATE_KEY). The .app
  # itself is fine — tolerate the exit code.
  bunx tauri build --debug 2>&1 || true
  cd ..

  if [ -d "${TAURI_DIR}/target/debug/bundle/macos/${APP_NAME}.app" ]; then
    echo "✅ Build complete."
  else
    echo "❌ Build failed — no .app bundle produced."
    exit 1
  fi
else
  echo "⏭️  Skipping build (--skip-build)"
fi

# ── Find and launch the app ────────────────────────────────────────────────
APP_BUNDLE="${TAURI_DIR}/target/debug/bundle/macos/${APP_NAME}.app"

if [ -d "$APP_BUNDLE" ]; then
  echo ""
  echo "🚀 Launching ${APP_NAME} (.app bundle)..."
  echo "   Bundle: ${APP_BUNDLE}"
  open "$APP_BUNDLE"
else
  echo "❌ No bundle found. Run without --skip-build first."
  exit 1
fi

echo "   App data: ${APP_DATA}"
echo ""
echo "✅ App launched. Check the splash screen for bootstrap logs."
echo "   To re-run without rebuilding: bun desktop-prod:run"
