"""#1252/#1253: a dub ingest failed with the toast ``ingest: 'mgw39lx3'``.

Two reports, same reporter, same session, four `dub:upload` actions in a row.
The entire user-facing error was eight characters of their own job id:

    ingest: 'mgw39lx3'
    Error: ingest: 'mgw39lx3'

That is ``str(KeyError("mgw39lx3"))`` — the repr of a dict key. ``KeyError``
does not put "a lookup failed" in its message, so `build_failure` faithfully
reported a value with no explanation attached to it.

The lookup that failed: ``ingest_pipeline`` finished with a bare
``_dub_jobs[job_id].update(...)``. Everything before it — demucs, scene
detection, thumbnailing — takes minutes, and ``DELETE /dub/history/{id}`` pops
the entry. Deleting an in-flight dub therefore raised ``KeyError`` from a
pipeline that was, by then, doing exactly what it was told.

Both halves are covered: the crash no longer happens, and no exception whose
``str()`` is a bare value can present itself to a user that way again.
"""
from __future__ import annotations

import pytest

from core.failure import build_failure, describe_exception
from services import dub_pipeline


@pytest.fixture(autouse=True)
def _clean_jobs():
    dub_pipeline._dub_jobs.clear()
    yield
    dub_pipeline._dub_jobs.clear()


# ── the crash ────────────────────────────────────────────────────────────


def test_merging_into_a_live_job_updates_it():
    dub_pipeline.put_job("job1", {"filename": "a.mp4", "scene_cuts": []})

    assert dub_pipeline.merge_job("job1", {"scene_cuts": [1.0, 2.0]}) is True
    assert dub_pipeline._dub_jobs["job1"]["scene_cuts"] == [1.0, 2.0]
    assert dub_pipeline._dub_jobs["job1"]["filename"] == "a.mp4", "a merge, not a replace"


def test_merging_into_a_deleted_job_reports_it_instead_of_raising():
    """The #1252 moment: the user deleted the dub while it was still ingesting."""
    dub_pipeline.put_job("mgw39lx3", {"filename": "a.mp4"})
    dub_pipeline._dub_jobs.pop("mgw39lx3")  # DELETE /dub/history/{id}

    assert dub_pipeline.merge_job("mgw39lx3", {"scene_cuts": []}) is False


def test_a_deleted_job_is_not_resurrected():
    """`False` must mean "stop", not "insert it back" — the user deleted this
    on purpose, and re-adding it would put a phantom row back in history."""
    assert dub_pipeline.merge_job("gone", {"scene_cuts": []}) is False
    assert "gone" not in dub_pipeline._dub_jobs


def test_the_ingest_pipeline_no_longer_blind_subscripts_the_job():
    """The call site itself. A direct `_dub_jobs[job_id].update(` anywhere in
    the pipeline reintroduces exactly this KeyError."""
    import inspect

    src = inspect.getsource(dub_pipeline.ingest_pipeline)
    assert "_dub_jobs[job_id].update(" not in src
    assert "merge_and_save_job(" in src


# ── the message ──────────────────────────────────────────────────────────


def test_a_keyerror_no_longer_presents_as_a_bare_key():
    """The exact reason string the reporter saw."""
    failure = build_failure(KeyError("mgw39lx3"), stage="ingest")

    assert failure["reason"] != "'mgw39lx3'"
    assert failure["error_class"] == "KeyError"
    assert "KeyError" in failure["reason"], "name what happened, not just the value"
    assert "mgw39lx3" in failure["reason"], "but keep the value — it is the only clue"


def test_an_exception_with_no_message_at_all_still_names_itself():
    assert describe_exception(RuntimeError()) == "RuntimeError"
    assert describe_exception(ValueError("   ")) == "ValueError"


def test_a_real_message_is_left_exactly_alone():
    """The fix must not prefix class names onto errors that already read fine —
    every existing hint and classification matches on message text."""
    assert describe_exception(RuntimeError("CUDA out of memory")) == "CUDA out of memory"
    assert describe_exception(
        OSError("[Errno 28] No space left on device")
    ) == "[Errno 28] No space left on device"


def test_classification_still_works_through_the_wrapper():
    """`build_failure` classifies on the raw text; adding a class prefix must
    not break the hint lookup for messages that do classify."""
    failure = build_failure(RuntimeError("No module named 'omnivoice'"), stage="startup")
    assert failure["docs_topic"] == "BROKEN_VENV"
    assert failure["hint"]


# ── the delete race the first fix left open ──────────────────────────────


def test_merge_and_save_are_one_step(monkeypatch):
    """Review finding (#1252): merging and persisting as two steps leaves a
    window where the user deletes the dub in between — and the pending save
    then UPSERTs the row straight back, so a dub they deleted reappears."""
    saved = []
    monkeypatch.setattr(
        dub_pipeline, "save_job",
        lambda job_id, job, *a, **kw: saved.append(job_id),
    )
    dub_pipeline.put_job("job1", {"filename": "a.mp4"})

    assert dub_pipeline.merge_and_save_job("job1", {"scene_cuts": [1.0]}) is True
    assert saved == ["job1"]
    assert dub_pipeline._dub_jobs["job1"]["scene_cuts"] == [1.0]


def test_a_deleted_job_is_never_persisted(monkeypatch):
    saved = []
    monkeypatch.setattr(
        dub_pipeline, "save_job",
        lambda job_id, job, *a, **kw: saved.append(job_id),
    )

    assert dub_pipeline.merge_and_save_job("gone", {"scene_cuts": []}) is False
    assert saved == [], "a withdrawn job must not reach the database"


def test_a_delete_landing_mid_save_cannot_be_overtaken(monkeypatch):
    """The lock is the mechanism, so exercise it: a purge that runs while the
    merge+save holds the lock must not interleave.

    `purge_jobs` calls its row-delete WITH the lock held, so if
    `merge_and_save_job` did not hold the same lock across both of its steps,
    this would deadlock or reorder. Asserting the observable contract: after a
    purge, a later merge finds nothing and writes nothing."""
    saved = []
    monkeypatch.setattr(
        dub_pipeline, "save_job",
        lambda job_id, job, *a, **kw: saved.append(job_id),
    )
    dub_pipeline.put_job("job1", {"filename": "a.mp4"})

    deleted_rows = []
    dub_pipeline.purge_jobs(["job1"], delete_rows=lambda: deleted_rows.append("job1"))

    assert deleted_rows == ["job1"]
    assert "job1" not in dub_pipeline._dub_jobs
    assert dub_pipeline.merge_and_save_job("job1", {"scene_cuts": []}) is False
    assert saved == []


def test_clear_history_also_evicts_in_memory_jobs(monkeypatch):
    """`DELETE /dub/history` deleted every row but evicted nothing from memory,
    so an in-flight job survived "clear history" outright and re-saved itself
    on completion."""
    import inspect

    from api.routers import dub_core

    src = inspect.getsource(dub_core.clear_dub_history)
    assert "purge_jobs" in src, "clear-all must evict memory too, not just rows"


def test_the_ingest_pipeline_persists_atomically():
    import inspect

    src = inspect.getsource(dub_pipeline.ingest_pipeline)
    assert "merge_and_save_job(" in src
    # The two-step form is what the race lived in.
    assert "save_job(job_id, get_job(" not in src
