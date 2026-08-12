#!/usr/bin/env bash
# `uv sync` with backoff between whole attempts.
#
# One dependency — en-core-web-sm — resolves to a direct GitHub *release* URL
# rather than a package index, and github.com intermittently answers
#
#   http2 error: stream error received: refused stream before processing any
#   application logic
#
# uv already retries three times, but all three land inside the same ~10
# seconds and fail together, so the job dies on a dependency that has nothing
# to do with the change under test. On 2026-08-12 this cost four otherwise-green
# runs across #1515, #1517 and #1518 in one evening, on three different jobs.
#
# Backing off between whole attempts is what actually clears it. Every CI job
# that syncs goes through here, because the fetch is per-job: hardening only
# the job that happened to fail last time just moves the outage to the next one.
#
# Usage: bash scripts/uv-sync-retry.sh [uv sync args...]
set -uo pipefail

# Three attempts, not more: uv does its OWN retrying underneath (the smoke
# matrix sets UV_HTTP_RETRIES=5 with a 120 s timeout), so attempts here
# MULTIPLY that budget. Three attempts plus 60 s of backoff keeps the worst
# case comfortably inside the jobs' timeout-minutes while still outlasting the
# refusals actually seen — which cleared within seconds.
ATTEMPTS="${UV_SYNC_ATTEMPTS:-3}"
BACKOFFS=(15 45)

for attempt in $(seq 1 "$ATTEMPTS"); do
  if uv sync "$@"; then
    [ "$attempt" -gt 1 ] && echo "uv sync succeeded on attempt $attempt"
    exit 0
  fi
  if [ "$attempt" -eq "$ATTEMPTS" ]; then
    echo "::error::uv sync failed $ATTEMPTS times — this is not the flaky fetch" >&2
    exit 1
  fi
  delay="${BACKOFFS[$((attempt - 1))]:-90}"
  echo "::warning::uv sync failed (attempt $attempt/$ATTEMPTS) — retrying in ${delay}s"
  sleep "$delay"
done
exit 1
