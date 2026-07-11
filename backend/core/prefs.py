"""
Tiny user-preferences store — JSON file in DATA_DIR.

Keeps UI-selected choices (engine picks, translator provider, …) across
process restarts without reaching for a DB table. Environment variables
still win — users who set `OMNIVOICE_TTS_BACKEND=…` are opting into an
explicit override that the UI cannot silently undo.

    resolve("tts_backend", env="OMNIVOICE_TTS_BACKEND", default="omnivoice")
      → env var if set, else prefs.json value, else default.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from typing import Any, Optional

from core.config import DATA_DIR

logger = logging.getLogger("omnivoice.prefs")

_PREFS_PATH = os.path.join(DATA_DIR, "prefs.json")

# Serializes the load-modify-save cycle of every mutation. Writers run on
# many threads (FastAPI's request threadpool, background workers like the
# sidecar-engine installer); without the lock two concurrent set_/delete
# calls interleave their read-modify-write and the later save silently
# drops the other's key. Reads stay lock-free — the atomic os.replace in
# _save guarantees they never see a torn file.
_MUTATE_LOCK = threading.RLock()


def _load() -> dict:
    try:
        with open(_PREFS_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    except Exception as e:
        logger.warning("prefs.json unreadable (%s); treating as empty", e)
        return {}


def _save(data: dict) -> None:
    # Atomic write — no half-written JSON if the process dies mid-flush.
    # Derive temp-dir from _PREFS_PATH (not DATA_DIR) so os.replace() always
    # operates within the same filesystem — important when tests redirect the path.
    target_dir = os.path.dirname(_PREFS_PATH) or DATA_DIR
    os.makedirs(target_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".prefs.", suffix=".tmp", dir=target_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, _PREFS_PATH)
        os.chmod(_PREFS_PATH, 0o600)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get(key: str, default: Any = None) -> Any:
    return _load().get(key, default)


def set_(key: str, value: Any) -> None:
    with _MUTATE_LOCK:
        data = _load()
        data[key] = value
        _save(data)


def delete(key: str) -> None:
    """Remove *key* from prefs.json if present."""
    with _MUTATE_LOCK:
        data = _load()
        data.pop(key, None)
        _save(data)


def resolve(key: str, *, env: Optional[str] = None, default: Any = None) -> Any:
    """Env var > prefs.json > default. Env is authoritative so power-users
    can pin a backend without the UI silently changing it."""
    if env:
        v = os.environ.get(env)
        if v:
            return v
    return get(key, default)
