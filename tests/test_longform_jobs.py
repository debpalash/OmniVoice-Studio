"""PR 7 — Longform Job Library. Tests the recovery logic in
``api.routers.longform_jobs.build_longform_library`` against a seeded job_store.

We call the pure builder (and the route handler) directly — no ``main``/torch
import — seeding the real job_store over its temp DB.
"""
import json
import os
import time

os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest
from core import job_store
from core.db import init_db

from api.routers.longform_jobs import (
    build_longform_library,
    _done_payload_from_events,
    longform_jobs,
)


@pytest.fixture(autouse=True)
def _init_db_once():
    init_db()
    yield


def _uid(prefix: str) -> str:
    return f"{prefix}_{int(time.time()*1e6)}_{os.getpid()}"


def _seed_done(job_id: str, *, type: str, done_payload: dict | None,
               meta: dict | None = None, extra_events: list[dict] | None = None):
    """Create a job, append some progress events + a final done event, mark done."""
    job_store.create(job_id, type=type, meta=meta)
    job_store.mark_running(job_id)
    for ev in (extra_events or []):
        job_store.append_event(job_id, json.dumps(ev))
    if done_payload is not None:
        job_store.append_event(job_id, json.dumps(done_payload))
    job_store.mark_done(job_id)


# ── _done_payload_from_events ────────────────────────────────────────────────


def test_done_payload_recovers_last_done():
    events = [
        {"payload": json.dumps({"type": "started", "chapters": 2})},
        {"payload": json.dumps({"type": "chapter", "index": 0})},
        {"payload": json.dumps({"type": "done", "output": "story_x.m4b",
                                 "chapters": 2, "duration_s": 12.5})},
    ]
    done = _done_payload_from_events(events)
    assert done is not None
    assert done["output"] == "story_x.m4b"


def test_done_payload_skips_malformed_json():
    events = [
        {"payload": "not json at all"},
        {"payload": json.dumps({"type": "done", "output": "ok.m4b"})},
    ]
    assert _done_payload_from_events(events)["output"] == "ok.m4b"


def test_done_payload_none_when_absent():
    events = [{"payload": json.dumps({"type": "chapter"})}]
    assert _done_payload_from_events(events) is None


# ── build_longform_library ───────────────────────────────────────────────────


def test_library_lists_only_finished_longform():
    ab = _uid("ab")
    st = _uid("st")
    failed = _uid("fail")
    dub = _uid("dub")

    _seed_done(ab, type="audiobook", meta={"title": "My Book"},
               done_payload={"type": "done", "output": f"{ab}.m4b",
                             "chapters": 3, "duration_s": 100.0})
    _seed_done(st, type="story",
               done_payload={"type": "done", "output": f"{st}.m4b",
                             "chapters": 1, "duration_s": 42.0, "title": "A Tale"})
    # A failed audiobook job — has progress events but never a done event.
    job_store.create(failed, type="audiobook")
    job_store.mark_running(failed)
    job_store.append_event(failed, json.dumps({"type": "chapter", "index": 0}))
    job_store.mark_failed(failed, "boom")
    # A finished dub job — done, but not a longform type → excluded.
    _seed_done(dub, type="dub_generate",
               done_payload={"type": "done", "output": f"{dub}.wav"})

    lib = build_longform_library(job_store.list_jobs, job_store.events_since, limit=50)
    by_id = {it["job_id"]: it for it in lib}

    assert ab in by_id
    assert st in by_id
    assert failed not in by_id  # never finished
    assert dub not in by_id     # wrong type

    assert by_id[ab]["type"] == "audiobook"
    assert by_id[ab]["output"] == f"{ab}.m4b"
    assert by_id[ab]["chapters"] == 3
    assert by_id[ab]["duration_s"] == 100.0
    assert by_id[ab]["title"] == "My Book"          # from job meta
    assert by_id[ab]["created_at"] is not None

    assert by_id[st]["title"] == "A Tale"           # from done event
    assert by_id[st]["chapters"] == 1


def test_library_skips_done_job_without_output():
    bad = _uid("noout")
    _seed_done(bad, type="story",
               done_payload={"type": "done", "chapters": 2})  # no "output"
    lib = build_longform_library(job_store.list_jobs, job_store.events_since, limit=50)
    assert bad not in {it["job_id"] for it in lib}


def test_library_newest_first():
    older = _uid("old")
    newer = _uid("new")
    _seed_done(older, type="audiobook",
               done_payload={"type": "done", "output": f"{older}.m4b", "chapters": 1})
    time.sleep(0.01)
    _seed_done(newer, type="audiobook",
               done_payload={"type": "done", "output": f"{newer}.m4b", "chapters": 1})

    lib = build_longform_library(job_store.list_jobs, job_store.events_since, limit=50)
    ids = [it["job_id"] for it in lib if it["job_id"] in (older, newer)]
    assert ids.index(newer) < ids.index(older)


def test_library_respects_limit():
    seeded = []
    for _ in range(5):
        jid = _uid("lim")
        _seed_done(jid, type="story",
                   done_payload={"type": "done", "output": f"{jid}.m4b", "chapters": 1})
        seeded.append(jid)
    lib = build_longform_library(job_store.list_jobs, job_store.events_since, limit=2)
    assert len(lib) == 2


def test_library_never_raises_on_bad_callables():
    def boom(*a, **k):
        raise RuntimeError("db down")
    # list_jobs failing → empty list, no exception.
    assert build_longform_library(boom, job_store.events_since, limit=10) == []
    # events_since failing for a row → that row skipped, no exception.
    jid = _uid("ev")
    _seed_done(jid, type="audiobook",
               done_payload={"type": "done", "output": f"{jid}.m4b", "chapters": 1})

    def evboom(*a, **k):
        raise RuntimeError("events down")
    lib = build_longform_library(job_store.list_jobs, evboom, limit=10)
    assert jid not in {it["job_id"] for it in lib}


# ── route handler ────────────────────────────────────────────────────────────


def test_route_handler_returns_jobs_envelope():
    jid = _uid("route")
    _seed_done(jid, type="audiobook",
               done_payload={"type": "done", "output": f"{jid}.m4b",
                             "chapters": 2, "duration_s": 9.0})
    resp = longform_jobs(limit=50)
    assert "jobs" in resp
    assert jid in {it["job_id"] for it in resp["jobs"]}
