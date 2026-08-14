"""Startup progress ledger — what the backend is doing before it can serve.

Why this exists: the project's #1 lifetime failure class is "can't reach the
local backend", and a large slice of it was never a dead backend at all —
just one that couldn't say "I'm starting, currently loading PyTorch" because
nothing listened until every heavy import and migration finished. main.py now
binds the socket early and defers the heavy work; this module is the shared
state the early `/health` + `/startup/progress` endpoints report from while
that work runs.

Thread-safety: the deferred init runs Phase A in an executor thread while the
event loop serves probes, so every mutation and snapshot takes the lock.
"""

from __future__ import annotations

import threading
import time

# Execution order matters only for display; the ledger records whatever order
# steps actually begin in. Keep ids stable — the desktop shell field-sniffs
# them and tests pin them.
STEPS: "dict[str, str]" = {
    "env_prefs": "Restoring settings…",
    "native_preload": "Preparing GPU libraries…",
    "ml_imports": "Loading ML runtime (PyTorch)…",
    "api_routes": "Loading API routes…",
    "db_migrate": "Preparing database…",
    "services_start": "Starting background services…",
}

_lock = threading.Lock()
_t0 = time.monotonic()
_current: "str | None" = None
_done: "list[tuple[str, float]]" = []  # (step_id, seconds it took)
_started_at: float = 0.0
_ready = False
_error: "dict | None" = None


def begin_step(step_id: str) -> None:
    global _current, _started_at
    with _lock:
        _finish_current_locked()
        _current = step_id
        _started_at = time.monotonic()


def _finish_current_locked() -> None:
    global _current
    if _current is not None:
        _done.append((_current, round(time.monotonic() - _started_at, 2)))
        _current = None


def mark_ready() -> None:
    global _ready
    with _lock:
        _finish_current_locked()
        _ready = True


def fail(message: str) -> None:
    """Record a startup failure against the step that was running."""
    global _error
    with _lock:
        _error = {"step": _current, "message": str(message)[:500]}


def is_ready() -> bool:
    with _lock:
        return _ready


def current_step() -> "tuple[str | None, str | None]":
    """(step_id, human label) of the active step, or (None, None)."""
    with _lock:
        if _current is None:
            return None, None
        return _current, STEPS.get(_current, _current)


def snapshot() -> dict:
    """The `/startup/progress` body. Always safe to call, never raises."""
    with _lock:
        if _error is not None:
            status = "failed"
        elif _ready:
            status = "ready"
        else:
            status = "starting"
        states = {sid: "pending" for sid in STEPS}
        for sid, _t in _done:
            states[sid] = "done"
        if _current is not None:
            states[_current] = "active"
        if _error is not None and _error.get("step"):
            states[_error["step"]] = "failed"
        durations = dict(_done)
        return {
            "status": status,
            "step": _current,
            "label": STEPS.get(_current, _current) if _current else None,
            "steps": [
                {
                    "id": sid,
                    "label": label,
                    "state": states.get(sid, "pending"),
                    **({"t": durations[sid]} if sid in durations else {}),
                }
                for sid, label in STEPS.items()
            ],
            "elapsed_s": round(time.monotonic() - _t0, 2),
            "error": _error,
        }


def _reset_for_tests() -> None:
    global _current, _ready, _error, _started_at
    with _lock:
        _current = None
        _done.clear()
        _ready = False
        _error = None
        _started_at = 0.0
