"""core.error_journal — structured, deduped, classified backend error ring."""
import json
import os

import pytest

from core import error_journal
from core.error_journal import classify_exception, record, recent


@pytest.fixture(autouse=True)
def isolated_journal(monkeypatch, tmp_path):
    """Point persistence at a temp file and start every test empty."""
    monkeypatch.setattr(error_journal, "JOURNAL_PATH", str(tmp_path / "journal.jsonl"))
    error_journal._entries.clear()
    yield
    error_journal._entries.clear()


# ── Classification ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "exc,trace,expected",
    [
        (RuntimeError("CUDA out of memory. Tried to allocate 2.5 GiB"), "", "GPU_OOM"),
        (RuntimeError("MPS backend out of memory"), "", "GPU_OOM"),
        (OSError(28, "No space left on device"), "", "DISK_FULL"),
        (RuntimeError("401 Client Error: Unauthorized for url: https://huggingface.co/x"), "", "HF_AUTH_FAILED"),
        (RuntimeError("boom"), "huggingface_hub.errors.GatedRepoError: ...", "HF_AUTH_FAILED"),
        (FileNotFoundError("No such file or directory: 'ffmpeg'"), "", "FFMPEG_MISSING"),
        (ConnectionError("Connection refused"), "", "NETWORK_ERROR"),
        (TimeoutError("timed out"), "", "NETWORK_ERROR"),
        (ValueError("tensor shape mismatch"), "", "UNKNOWN"),
    ],
)
def test_classify(exc, trace, expected):
    assert classify_exception(exc, trace) == expected


def test_pyannote_needs_auth_marker():
    # pyannote alone is any diarization bug — must NOT classify as license.
    plain = RuntimeError("pyannote pipeline failed on segment 3")
    assert classify_exception(plain, "") != "PYANNOTE_LICENSE_REQUIRED"
    gated = RuntimeError("pyannote/speaker-diarization-3.1: 403 gated repo, accept access")
    assert classify_exception(gated, "") == "PYANNOTE_LICENSE_REQUIRED"


# ── Recording + dedup ─────────────────────────────────────────────────────


def test_record_and_recent_order():
    record(ValueError("first"), route="/a")
    record(KeyError("second"), route="/b")
    errors = recent()
    assert errors[0]["message"].endswith("'second'") or "second" in errors[0]["message"]
    assert errors[1]["route"] == "/a"


def test_dedup_bumps_count():
    for _ in range(3):
        record(ValueError("same failure"), route="/gen")
    errors = recent()
    assert len(errors) == 1
    assert errors[0]["count"] == 3


def test_trace_is_scrubbed_and_truncated():
    trace = "File \"/home/eve/app/main.py\" line 1\n" + "x" * 10_000
    entry = record(RuntimeError("boom"), trace=trace)
    assert "/home/eve" not in entry["trace"]
    assert len(entry["trace"]) <= error_journal._MAX_TRACE_CHARS


def test_ring_capped():
    for i in range(error_journal._MAX_ENTRIES + 10):
        record(ValueError(f"distinct-{i}"))
    assert len(recent(limit=50)) == error_journal._MAX_ENTRIES


def test_persists_to_jsonl():
    record(ValueError("persisted"))
    with open(error_journal.JOURNAL_PATH, encoding="utf-8") as f:
        lines = [json.loads(line) for line in f]
    assert any("persisted" in e["message"] for e in lines)


def test_record_never_raises(monkeypatch):
    # Even with persistence broken, record() must return an entry.
    monkeypatch.setattr(error_journal, "JOURNAL_PATH", "/nonexistent/dir/x.jsonl")
    entry = record(ValueError("still works"))
    assert entry["error_class"] == "UNKNOWN"
    assert entry["count"] == 1
