#!/usr/bin/env bash
# Gracefully stop the OmniVoice backend bound to 127.0.0.1:3900.
set -euo pipefail

PIDS=$(lsof -nP -iTCP:3900 -sTCP:LISTEN -t 2>/dev/null || true)
if [ -z "$PIDS" ]; then
  echo "no listener on 3900"
  exit 0
fi

for pid in $PIDS; do
  echo "kill -TERM $pid"
  kill -TERM "$pid" 2>/dev/null || true
done

for i in $(seq 1 5); do
  sleep 2
  if ! lsof -nP -iTCP:3900 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "stopped"
    exit 0
  fi
done

echo "still running after 10s — escalating to SIGKILL" >&2
for pid in $PIDS; do kill -KILL "$pid" 2>/dev/null || true; done
exit 0
