#!/usr/bin/env bash
# Gracefully stop the OmniVoice backend bound to 127.0.0.1:3900.
#
# Exit codes:
#   0   stopped (or never running)
#   1   process(es) still bound to 3900 after SIGTERM + SIGKILL escalation
#   2   permission denied killing a bound process (EPERM — try sudo or a different account)

set -euo pipefail

# Helper: discover current PIDs bound to 3900 (recomputed each time to avoid stale data)
current_pids() {
  lsof -nP -iTCP:3900 -sTCP:LISTEN -t 2>/dev/null || true
}

PIDS="$(current_pids)"
if [ -z "$PIDS" ]; then
  echo "no listener on 3900"
  exit 0
fi

# SIGTERM phase — let processes shut down cleanly. Surface EPERM loudly so the user
# knows when they can't actually stop the backend (wrong user, sandboxed process, etc.).
EPERM_HIT=0
for pid in $PIDS; do
  echo "kill -TERM $pid"
  if ! kill -TERM "$pid" 2>/tmp/.omnivoice-kill-err; then
    if grep -qi 'permitted\|denied' /tmp/.omnivoice-kill-err 2>/dev/null; then
      echo "  ✗ EPERM — cannot signal PID $pid (different user / sandboxed)" >&2
      EPERM_HIT=1
    elif grep -qi 'no such process' /tmp/.omnivoice-kill-err 2>/dev/null; then
      :    # benign — process already gone
    else
      cat /tmp/.omnivoice-kill-err >&2 || true
    fi
  fi
done
rm -f /tmp/.omnivoice-kill-err

if [ "$EPERM_HIT" -eq 1 ]; then
  echo "✗ at least one bound process refused SIGTERM (permission denied)." >&2
  echo "  Try \`sudo $(realpath "$0")\` or stop the owning process manually." >&2
  exit 2
fi

# Wait up to 10s for graceful exit (poll lsof, not the captured PID list — PIDs may have been
# reaped or recycled by the kernel during this window).
for i in $(seq 1 5); do
  sleep 2
  if [ -z "$(current_pids)" ]; then
    echo "stopped"
    exit 0
  fi
done

# Escalate to SIGKILL on whatever is currently bound (re-query — don't trust stale PIDs).
echo "still running after 10s — escalating to SIGKILL" >&2
PIDS="$(current_pids)"
for pid in $PIDS; do kill -KILL "$pid" 2>/dev/null || true; done
sleep 1

# Verify the port is actually free now. If it's still held, the script failed its job.
if [ -n "$(current_pids)" ]; then
  echo "✗ port 3900 STILL bound after SIGKILL:" >&2
  lsof -nP -iTCP:3900 -sTCP:LISTEN 2>&1 | head -3 >&2
  exit 1
fi

echo "stopped (after SIGKILL)"
exit 0
