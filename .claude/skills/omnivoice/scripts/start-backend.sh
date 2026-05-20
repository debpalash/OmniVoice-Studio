#!/usr/bin/env bash
# Start the OmniVoice FastAPI backend on 127.0.0.1:3900, detached, idempotent.
# Resolves the repo root from this script's location, so it works regardless of CWD.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/ is at .claude/skills/omnivoice/scripts/ → repo root is 4 levels up
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
URL="${OMNIVOICE_API_URL:-http://127.0.0.1:3900}"
LOG="$REPO_ROOT/backend.log"

if [ ! -f "$REPO_ROOT/backend/main.py" ]; then
  echo "could not locate backend/main.py from $SCRIPT_DIR" >&2
  exit 2
fi

if curl -sf --max-time 2 "$URL/health" >/dev/null 2>&1; then
  echo "already running: $URL"
  curl -sf "$URL/health"; echo
  exit 0
fi

if lsof -nP -iTCP:3900 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 3900 held but /health not responding — investigate before starting" >&2
  lsof -nP -iTCP:3900 -sTCP:LISTEN >&2
  exit 3
fi

cd "$REPO_ROOT"
nohup uv run uvicorn main:app --app-dir backend --host 127.0.0.1 --port 3900 \
  > "$LOG" 2>&1 &
PID=$!
echo "starting backend (PID $PID, log: $LOG)..."

for i in $(seq 1 30); do
  sleep 2
  if curl -sf --max-time 2 "$URL/health" >/dev/null 2>&1; then
    curl -sf "$URL/health"; echo
    echo "ready after $((i*2))s"
    exit 0
  fi
done

echo "backend did not respond on $URL/health within 60s — see $LOG" >&2
exit 4
