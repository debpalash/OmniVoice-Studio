#!/usr/bin/env bash
set -euo pipefail
URL="${OMNIVOICE_API_URL:-http://127.0.0.1:3900}/health"
if out=$(curl -sf --max-time 3 "$URL" 2>/dev/null); then
  echo "$out"
  exit 0
fi
echo "omnivoice backend not reachable at $URL" >&2
exit 1
