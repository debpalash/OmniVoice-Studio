#!/usr/bin/env bash
# Start the OmniVoice FastAPI backend on 127.0.0.1:3900, detached, idempotent.
# Honors $OMNIVOICE_HOME (default ~/OmniVoice-Studio).
#
# Exit codes:
#   0   success (already running, or freshly started + healthy within 60s)
#   2   $OMNIVOICE_HOME doesn't exist
#   3   port 3900 held but /health unresponsive (won't auto-kill — caller decides)
#   4   backend started but /health didn't respond within 60s
#   5   uvicorn process died during the wait

set -euo pipefail

HOME_DIR="${OMNIVOICE_HOME:-$HOME/OmniVoice-Studio}"
URL="${OMNIVOICE_API_URL:-http://127.0.0.1:3900}"
LOG="$HOME_DIR/backend.log"

if [ ! -d "$HOME_DIR" ]; then
  echo "OMNIVOICE_HOME not found: $HOME_DIR" >&2
  echo "See references/mcp-setup.md for install steps." >&2
  exit 2
fi

# Already up?
if curl -sf --max-time 2 "$URL/health" >/dev/null 2>&1; then
  echo "already running: $URL"
  curl -sf "$URL/health"; echo
  exit 0
fi

# Port held by something else? Identify it before refusing.
BIND_PID="$(lsof -nP -iTCP:3900 -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -n "$BIND_PID" ]; then
  BIND_CMD="$(ps -o command= -p "$BIND_PID" 2>/dev/null || echo "?")"
  echo "port 3900 held by PID $BIND_PID but /health not responding — investigate before starting" >&2
  echo "  bound process: $BIND_CMD" >&2
  case "$BIND_CMD" in
    *uvicorn*main:app*)
      echo "  → looks like a stale uvicorn from a previous run; consider scripts/stop-backend.sh" >&2
      ;;
    *)
      echo "  → unknown process holds the port; resolve before re-running this script" >&2
      ;;
  esac
  exit 3
fi

cd "$HOME_DIR"
nohup uv run uvicorn main:app --app-dir backend --host 127.0.0.1 --port 3900 \
  > "$LOG" 2>&1 &
PID=$!
echo "starting backend (PID $PID, log: $LOG)..."

# Wait up to 60s for /health, AND verify the child stays alive.
# A dead child means immediate bind failure (port grabbed in the TOCTOU window above)
# or an early crash — surface it instead of waiting the full timeout.
for i in $(seq 1 30); do
  sleep 2
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "✗ uvicorn (PID $PID) exited during startup — see $LOG" >&2
    tail -20 "$LOG" >&2 || true
    exit 5
  fi
  if curl -sf --max-time 2 "$URL/health" >/dev/null 2>&1; then
    curl -sf "$URL/health"; echo
    echo "ready after $((i*2))s"
    exit 0
  fi
done

echo "backend did not respond on $URL/health within 60s — see $LOG" >&2
exit 4
