"""Phase 2.4/2.7 — `services/dub_pipeline` state helpers.

Covers the non-ingest, non-streaming surface: path safety, cache lookup,
process tracking, in-memory + DB job round-trip.
"""
import os
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import uuid
import pytest
from core.db import init_db
from services import dub_pipeline as dp


@pytest.fixture(autouse=True)
def _init():
    init_db()
    yield


def _jid():
    return f"p_{uuid.uuid4().hex[:8]}"


# ── Path safety ─────────────────────────────────────────────────────────────


def test_safe_job_dir_rejects_traversal():
    assert dp.safe_job_dir("") is None
    assert dp.safe_job_dir("../etc") is None
    assert dp.safe_job_dir("..") is None
    assert dp.safe_job_dir("a/b") is None
    # Legit ids resolve under DUB_DIR.
    ok = dp.safe_job_dir("abc123")
    assert ok is not None
    assert ok.endswith("abc123")


# ── SSE event shape ─────────────────────────────────────────────────────────


def test_prep_event_contains_type_and_fields():
    out = dp.prep_event("extract_done", job_id="x", duration=1.5)
    assert out.startswith("data: ")
    assert '"type": "extract_done"' in out
    assert '"job_id": "x"' in out
    assert '"duration": 1.5' in out
    assert out.endswith("\n\n")


def test_sse_event_shape():
    out = dp.sse_event("segments", {"n": 3})
    assert out.startswith(b"event: segments\ndata: ")
    assert out.endswith(b"\n\n")


# ── Process tracking ────────────────────────────────────────────────────────


class _FakeProc:
    def __init__(self):
        self.returncode = None
        self.killed = False

    def kill(self):
        self.killed = True
        self.returncode = -9


def test_register_unregister_has_active():
    jid = _jid()
    proc = _FakeProc()
    assert not dp.has_active_procs(jid)
    dp.register_proc(jid, proc)
    assert dp.has_active_procs(jid)
    dp.unregister_proc(jid, proc)
    assert not dp.has_active_procs(jid)


def test_kill_job_procs_is_idempotent():
    jid = _jid()
    dp.register_proc(jid, _FakeProc())
    dp.register_proc(jid, _FakeProc())
    dp.kill_job_procs(jid)
    # Called twice — second call is a no-op.
    dp.kill_job_procs(jid)
    assert not dp.has_active_procs(jid)


# ── Job state round-trip ────────────────────────────────────────────────────


def test_put_get_job_in_memory():
    jid = _jid()
    assert dp.get_job(jid) is None
    dp.put_job(jid, {"filename": "x.mp4", "duration": 1.23})
    got = dp.get_job(jid)
    assert got["filename"] == "x.mp4"
    assert got["duration"] == 1.23


def test_save_job_persists_to_dub_history():
    """save_job writes to dub_history so a subsequent get_job on a cold cache
    can hydrate from disk."""
    jid = _jid()
    dp.put_job(jid, {"filename": "disk.mp4", "duration": 9.0, "dubbed_tracks": {}, "segments": []})
    dp.save_job(jid, dp.get_job(jid), filename="disk.mp4", duration=9.0)

    # Simulate fresh process: drop in-memory entry, force re-hydrate.
    dp._dub_jobs.pop(jid, None)
    rehydrated = dp.get_job(jid)
    assert rehydrated is not None
    assert rehydrated["filename"] == "disk.mp4"
    assert rehydrated["duration"] == 9.0
