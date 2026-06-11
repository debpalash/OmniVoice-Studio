"""Ring journal of recent backend errors — the "what just broke" store.

The global exception handler (main.py) records every unhandled exception
here. Unlike crash_log.txt (append-only plain text for humans), the journal
is structured and deduplicated, so the UI and the bug-report pipeline can
answer:

  - what was the most recent backend error? (auto-attach to a report)
  - is it the same error repeating? (count by fingerprint, "x14 since start")
  - what KIND of failure is it? (error_class — GPU_OOM, HF_AUTH_FAILED, …)

Everything stored is pre-scrubbed (core.scrub) because journal entries feed
the diagnostic bundle and prefilled GitHub issues. In-memory ring of
``_MAX_ENTRIES`` fingerprints, mirrored to ``DATA_DIR/error_journal.jsonl``
(rewritten on each record — entry count is small, atomicity beats append
here) so the journal survives restarts and the crash it just recorded.

``error_class`` values: the install-time classes reuse the locked taxonomy
keys from core.error_docs_map (HF_AUTH_FAILED, PYANNOTE_LICENSE_REQUIRED) so
docs deeplinks keep working; runtime classes (GPU_OOM, DISK_FULL,
NETWORK_ERROR, FFMPEG_MISSING) are journal-local and fall back to
DEFAULT_DOCS in lookup(). Don't add them to ERROR_DOCS without following
the 4-step mirror contract documented there.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import OrderedDict

from core.config import DATA_DIR
from core.scrub import scrub_text

JOURNAL_PATH = os.path.join(DATA_DIR, "error_journal.jsonl")

_MAX_ENTRIES = 50
_MAX_TRACE_CHARS = 4000

_lock = threading.Lock()
# fingerprint -> entry, oldest first (move_to_end on repeat).
_entries: "OrderedDict[str, dict]" = OrderedDict()


# Ordered: first match wins, most specific patterns up top.
_CLASS_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("GPU_OOM", (
        "cuda out of memory",
        "mps backend out of memory",
        "hip out of memory",
        "out of memory on device",
    )),
    ("PYANNOTE_LICENSE_REQUIRED", (
        "pyannote",  # only meaningful combined with an auth marker — see classify()
    )),
    ("HF_AUTH_FAILED", (
        "401 client error",
        "403 client error",
        "gatedrepoerror",
        "repository not found",
        "invalid user token",
        "huggingface_hub.errors",
    )),
    ("DISK_FULL", (
        "no space left on device",
        "errno 28",
        "disk quota exceeded",
    )),
    ("FFMPEG_MISSING", (
        "ffmpeg not found",
        "ffmpeg is not installed",
        "no such file or directory: 'ffmpeg'",
    )),
    ("NETWORK_ERROR", (
        "connection refused",
        "connection reset",
        "connection aborted",
        "timed out",
        "timeout",
        "name or service not known",
        "temporary failure in name resolution",
        "ssl",
        "proxyerror",
    )),
)

_AUTH_MARKERS = ("401", "403", "gated", "access", "token")


def classify_exception(exc: BaseException, trace: str = "") -> str:
    """Best-effort classification of an exception into a stable class key.

    Pattern-matching on message text is inherently fuzzy — the goal is
    triage ("which docs page / which hint"), not perfection. UNKNOWN is an
    acceptable answer.
    """
    blob = f"{type(exc).__name__}: {exc}\n{trace}".lower()
    for cls, needles in _CLASS_RULES:
        if cls == "PYANNOTE_LICENSE_REQUIRED":
            # pyannote in the trace alone is too broad (any diarization bug
            # would match); require an auth/gating marker alongside it.
            if "pyannote" in blob and any(m in blob for m in _AUTH_MARKERS):
                return cls
            continue
        if any(n in blob for n in needles):
            return cls
    return "UNKNOWN"


def _fingerprint(error_class: str, exc: BaseException) -> str:
    import hashlib
    raw = f"{error_class}|{type(exc).__name__}|{scrub_text(str(exc))[:200]}"
    # Dedup key for the journal, not a security boundary.
    return hashlib.sha1(raw.encode("utf-8", "replace"), usedforsecurity=False).hexdigest()[:16]


def _persist_locked() -> None:
    """Rewrite the JSONL mirror from the in-memory ring. Caller holds _lock.
    Never raises — losing persistence must not break the exception handler."""
    try:
        tmp = JOURNAL_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for entry in _entries.values():
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        os.replace(tmp, JOURNAL_PATH)
    except Exception:
        pass


def _hydrate() -> None:
    """Load persisted entries at import so 'recent errors' survives restarts
    (and shows the error that killed the previous run)."""
    try:
        with open(JOURNAL_PATH, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    fp = entry.get("fingerprint")
                    if fp:
                        _entries[fp] = entry
                except Exception:
                    continue
        while len(_entries) > _MAX_ENTRIES:
            _entries.popitem(last=False)
    except FileNotFoundError:
        pass
    except Exception:
        pass


_hydrate()


def record(exc: BaseException, route: str = "", trace: str = "") -> dict:
    """Record an unhandled exception. Returns the (scrubbed) journal entry.

    Never raises — this runs inside the global exception handler, where a
    second failure would shadow the one being reported.
    """
    try:
        error_class = classify_exception(exc, trace)
        fp = _fingerprint(error_class, exc)
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        with _lock:
            existing = _entries.get(fp)
            if existing:
                existing["count"] = int(existing.get("count", 1)) + 1
                existing["last_seen"] = now
                existing["route"] = scrub_text(route) or existing.get("route", "")
                _entries.move_to_end(fp)
                entry = existing
            else:
                entry = {
                    "fingerprint": fp,
                    "error_class": error_class,
                    "type": type(exc).__name__,
                    "message": scrub_text(str(exc)),
                    "route": scrub_text(route),
                    "trace": scrub_text(trace)[:_MAX_TRACE_CHARS],
                    "first_seen": now,
                    "last_seen": now,
                    "count": 1,
                }
                _entries[fp] = entry
                while len(_entries) > _MAX_ENTRIES:
                    _entries.popitem(last=False)
            _persist_locked()
        return entry
    except Exception:
        return {"error_class": "UNKNOWN", "type": type(exc).__name__, "count": 1}


def recent(limit: int = 20) -> list[dict]:
    """Most recent errors first."""
    with _lock:
        items = list(_entries.values())
    return list(reversed(items))[: max(1, min(limit, _MAX_ENTRIES))]


def clear() -> None:
    with _lock:
        _entries.clear()
        try:
            os.remove(JOURNAL_PATH)
        except OSError:
            pass
