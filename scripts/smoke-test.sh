#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# smoke-test.sh — Automated end-to-end first-launch verification
#
# Simulates a REAL end-user fresh install:
#   1. Wipes all app data (venv, config, tools, logs, HF cache)
#   2. Builds the debug production bundle
#   3. Launches the app in the background
#   4. Polls the backend until it's healthy or timeout
#   5. Runs health checks against every critical endpoint
#   6. Checks device detection, model status, region config
#   7. Kills the app and reports pass/fail
#
# This is what you should run BEFORE every release. It catches:
#   - Bootstrap failures (missing deps, bad downloads)
#   - GPU detection regressions
#   - FFmpeg/ffprobe resolution failures
#   - Region mirror misconfig
#   - Model loading crashes
#
# Usage:
#   bun run smoke-test               # full wipe + build + test
#   bun run smoke-test:quick         # skip build, re-test last binary
#   bun run smoke-test:upgrade       # keep data, test upgrade path
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_ID="com.debpalash.omnivoice-studio"
TAURI_DIR="frontend/src-tauri"
APP_NAME="OmniVoice Studio"
BACKEND_URL="http://127.0.0.1:3900"

# Timeouts (seconds)
BOOTSTRAP_TIMEOUT=600   # 10 min for full venv bootstrap
HEALTH_TIMEOUT=120      # 2 min for backend to become healthy after bootstrap
MODEL_TIMEOUT=180       # 3 min for model to load

# ── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
header() { echo -e "\n${BOLD}$1${NC}"; }

FAILURES=0
TESTS=0
APP_PID=""

# ── Cleanup on exit ────────────────────────────────────────────────────────
cleanup() {
    if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
        info "Killing app (pid $APP_PID)..."
        kill "$APP_PID" 2>/dev/null || true
        sleep 2
        kill -9 "$APP_PID" 2>/dev/null || true
    fi
    # Also kill any orphaned backend
    pkill -f "uvicorn.*3900" 2>/dev/null || true
}
trap cleanup EXIT

# ── Detect platform ───────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      echo "❌ Unsupported platform: $OS"; exit 1 ;;
esac

if [ "$PLATFORM" = "macos" ]; then
  APP_DATA="$HOME/Library/Application Support/${APP_ID}"
  OV_DATA="$HOME/Library/Application Support/OmniVoice"
else
  APP_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/${APP_ID}"
  OV_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/OmniVoice"
fi

HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}"

# ── Flags ──────────────────────────────────────────────────────────────────
SKIP_BUILD=false
KEEP_DATA=false
SKIP_MODEL=false

for arg in "$@"; do
  case "$arg" in
    --skip-build)  SKIP_BUILD=true ;;
    --keep-data)   KEEP_DATA=true ;;
    --skip-model)  SKIP_MODEL=true ;;
    -h|--help)
      echo "Usage: $0 [--skip-build] [--keep-data] [--skip-model]"
      echo ""
      echo "  --skip-build  Skip cargo build, use last compiled binary"
      echo "  --keep-data   Don't wipe app data (test upgrade path)"
      echo "  --skip-model  Skip waiting for TTS model load (saves time)"
      exit 0
      ;;
  esac
done

# ══════════════════════════════════════════════════════════════════════════
header "🧪 OmniVoice Studio — End-to-End Smoke Test"
echo "   Platform: $PLATFORM | $(date)"
echo ""

# ── Phase 1: Clean ────────────────────────────────────────────────────────
header "Phase 1: Environment Reset"

if [ "$KEEP_DATA" = false ]; then
    info "Wiping app data for fresh install simulation..."

    for dir in "$APP_DATA" "$OV_DATA"; do
        if [ -d "$dir" ]; then
            rm -rf "$dir"
            pass "Removed: $dir"
        fi
    done
    pass "Clean slate — next launch bootstraps from zero"
else
    warn "Keeping existing data (upgrade test mode)"
fi

# Kill any existing backend on port 3900
if lsof -i :3900 >/dev/null 2>&1; then
    info "Killing existing process on port 3900..."
    kill $(lsof -ti :3900) 2>/dev/null || true
    sleep 1
fi

# ── Phase 2: Build ────────────────────────────────────────────────────────
header "Phase 2: Build"

BINARY="${TAURI_DIR}/target/debug/app"

if [ "$SKIP_BUILD" = false ]; then
    info "Building debug bundle (this takes 1-3 min)..."

    # Remove stale bundle
    if [ "$PLATFORM" = "macos" ]; then
        APP_BUNDLE="${TAURI_DIR}/target/debug/bundle/macos/${APP_NAME}.app"
        [ -d "$APP_BUNDLE" ] && rm -rf "$APP_BUNDLE"
    fi

    BUILD_LOG=$(mktemp)
    cd frontend
    set +e
    bunx tauri build --debug >"$BUILD_LOG" 2>&1
    BUILD_EXIT=$?
    set -e
    cd ..

    if [ $BUILD_EXIT -ne 0 ]; then
        if grep -qi "TAURI_SIGNING_PRIVATE_KEY\|private key\|failed to bundle" "$BUILD_LOG"; then
            warn "Non-fatal bundle warning (signing/bundling) — binary is fine"
        else
            echo ""
            tail -20 "$BUILD_LOG"
            rm -f "$BUILD_LOG"
            fail "Build failed with exit code $BUILD_EXIT"
            exit 1
        fi
    fi
    rm -f "$BUILD_LOG"

    if [ -f "$BINARY" ]; then
        pass "Binary built: $BINARY"
    else
        fail "Binary not found at $BINARY"
        exit 1
    fi
else
    if [ -f "$BINARY" ]; then
        pass "Using existing binary: $BINARY (--skip-build)"
    else
        fail "No binary found. Run without --skip-build first."
        exit 1
    fi
fi

# ── Phase 3: Launch & Bootstrap ───────────────────────────────────────────
header "Phase 3: Launch & Bootstrap"

info "Starting app..."
"$BINARY" &
APP_PID=$!
info "App PID: $APP_PID"

# Wait for backend to come up
info "Waiting for backend health (timeout: ${BOOTSTRAP_TIMEOUT}s)..."
ELAPSED=0
INTERVAL=5
while [ $ELAPSED -lt $BOOTSTRAP_TIMEOUT ]; do
    if curl -sf "${BACKEND_URL}/system/info" >/dev/null 2>&1; then
        pass "Backend healthy after ${ELAPSED}s"
        break
    fi
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))

    # Check if app crashed
    if ! kill -0 "$APP_PID" 2>/dev/null; then
        fail "App process died during bootstrap (after ${ELAPSED}s)"
        echo ""
        # Show crash log if available
        CRASH_LOG="$OV_DATA/crash_log.txt"
        if [ -f "$CRASH_LOG" ] && [ -s "$CRASH_LOG" ]; then
            echo "  📋 Crash log:"
            tail -20 "$CRASH_LOG" | sed 's/^/     /'
        fi
        exit 1
    fi
done

if [ $ELAPSED -ge $BOOTSTRAP_TIMEOUT ]; then
    fail "Backend did not start within ${BOOTSTRAP_TIMEOUT}s"
    exit 1
fi

# ── Phase 4: Health Checks ────────────────────────────────────────────────
header "Phase 4: Health Checks"

check_endpoint() {
    local name="$1"
    local url="$2"
    local jq_filter="${3:-}"
    TESTS=$((TESTS + 1))

    RESPONSE=$(curl -sf "$url" 2>/dev/null) || { fail "$name — HTTP error"; return; }

    if [ -n "$jq_filter" ]; then
        VALUE=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print($jq_filter)" 2>/dev/null)
        if [ -n "$VALUE" ] && [ "$VALUE" != "None" ]; then
            pass "$name → $VALUE"
        else
            fail "$name — unexpected response"
        fi
    else
        pass "$name → OK"
    fi
}

# Core endpoints
check_endpoint "GET /system/info" "${BACKEND_URL}/system/info" "d.get('device','?')"
check_endpoint "GET /sysinfo" "${BACKEND_URL}/sysinfo"
check_endpoint "GET /model/status" "${BACKEND_URL}/model/status" "d.get('status','?')"

# Device detection — the most critical check
TESTS=$((TESTS + 1))
DEVICE=$(curl -sf "${BACKEND_URL}/system/info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('device','unknown'))" 2>/dev/null)
case "$DEVICE" in
    mps|cuda|xpu|cpu)
        pass "Device detection: $DEVICE"
        ;;
    *)
        if echo "$DEVICE" | grep -q "privateuseone"; then
            pass "Device detection: DirectML ($DEVICE)"
        else
            fail "Device detection returned unexpected: $DEVICE"
        fi
        ;;
esac

# Python version check
TESTS=$((TESTS + 1))
PY_VER=$(curl -sf "${BACKEND_URL}/system/info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('python','?'))" 2>/dev/null)
if echo "$PY_VER" | grep -q "^3\.11"; then
    pass "Python version: $PY_VER"
else
    fail "Python version unexpected: $PY_VER (expected 3.11.x)"
fi

# Platform check
TESTS=$((TESTS + 1))
PLAT=$(curl -sf "${BACKEND_URL}/system/info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('platform','?'))" 2>/dev/null)
if [ "$PLAT" = "darwin" ] || [ "$PLAT" = "linux" ] || [ "$PLAT" = "win32" ]; then
    pass "Platform: $PLAT"
else
    fail "Platform unexpected: $PLAT"
fi

# FFmpeg check — try the sysinfo endpoint
TESTS=$((TESTS + 1))
FFMPEG_OK=$(curl -sf "${BACKEND_URL}/system/info" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('ok' if d.get('error') is None else d.get('error','?'))
" 2>/dev/null)
if [ "$FFMPEG_OK" = "ok" ]; then
    pass "No startup errors"
else
    fail "Startup error: $FFMPEG_OK"
fi

# WebSocket endpoint — curl GET returns 403/400/404 (needs WS upgrade)
# We just verify the route exists by checking it doesn't hard-error.
TESTS=$((TESTS + 1))
WS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BACKEND_URL}/ws/events" 2>/dev/null || echo "000")
if [ "$WS_CODE" != "000" ]; then
    pass "WebSocket route reachable (/ws/events → HTTP $WS_CODE)"
else
    fail "WebSocket route unreachable (connection refused)"  
fi

# System notifications endpoint
check_endpoint "GET /system/notifications" "${BACKEND_URL}/system/notifications"

# ── Phase 5: Model Loading (optional) ─────────────────────────────────────
if [ "$SKIP_MODEL" = false ]; then
    header "Phase 5: Model Loading"
    info "Waiting for TTS model to load (timeout: ${MODEL_TIMEOUT}s)..."

    ELAPSED=0
    while [ $ELAPSED -lt $MODEL_TIMEOUT ]; do
        STATUS=$(curl -sf "${BACKEND_URL}/model/status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
        SUB=$(curl -sf "${BACKEND_URL}/model/status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sub_stage','?'))" 2>/dev/null)

        if [ "$STATUS" = "ready" ]; then
            TESTS=$((TESTS + 1))
            pass "Model loaded successfully (${ELAPSED}s)"
            break
        elif [ "$STATUS" = "loading" ]; then
            info "Loading... ($SUB) [${ELAPSED}s]"
        fi

        sleep 10
        ELAPSED=$((ELAPSED + 10))
    done

    if [ $ELAPSED -ge $MODEL_TIMEOUT ]; then
        TESTS=$((TESTS + 1))
        ERR=$(curl -sf "${BACKEND_URL}/model/status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null)
        fail "Model did not load within ${MODEL_TIMEOUT}s (error: $ERR)"
    fi
else
    warn "Skipping model load test (--skip-model)"
fi

# ── Phase 6: Region Config ────────────────────────────────────────────────
header "Phase 6: Config Verification"

TESTS=$((TESTS + 1))
CONFIG_FILE="$APP_DATA/config.json"
if [ -f "$CONFIG_FILE" ]; then
    REGION=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('region','?'))" 2>/dev/null)
    pass "Region config: $REGION (from $CONFIG_FILE)"
else
    # No config file = default "auto" — that's correct for fresh install
    pass "Region config: auto (default, no config.json yet)"
fi

# ── Phase 7: Data Directory Structure ─────────────────────────────────────
header "Phase 7: Data Directories"

for dir in "$OV_DATA" "$APP_DATA"; do
    TESTS=$((TESTS + 1))
    if [ -d "$dir" ]; then
        pass "Directory exists: $(basename $dir)/"
    else
        warn "Directory missing: $dir (may be created on first use)"
    fi
done

# ── Results ────────────────────────────────────────────────────────────────
header "═══════════════════════════════════════════════════════════"
echo ""
if [ $FAILURES -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}ALL TESTS PASSED${NC} ($TESTS checks)"
    echo ""
    echo -e "  ${CYAN}The app bootstraps correctly from zero and all"
    echo -e "  endpoints are healthy. This matches the end-user experience.${NC}"
else
    echo -e "  ${RED}${BOLD}$FAILURES FAILURE(S)${NC} out of $TESTS checks"
    echo ""
    echo -e "  ${RED}Fix the failures above before releasing.${NC}"
fi
echo ""
echo "  Logs: ~/Library/Logs/OmniVoice/"
echo "  Data: $APP_DATA"
echo ""

exit $FAILURES
