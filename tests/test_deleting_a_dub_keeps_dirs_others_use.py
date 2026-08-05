"""Deleting a dub must not destroy files another saved dub still renders from.

The deletion half of #1331. The content-hash cache legitimately points a newer
job's ``vocals_path`` — and, for jobs created before the job-scoped-clones fix,
its clone reference paths — into an older job's directory. Deleting that older
history entry ``rmtree``'d the dir regardless: the newer job kept loading, but
every single-segment regen silently fell back to the default voice and stems
exports lost their sources.

The guard is deliberately on the DELETE side even though new jobs no longer
write clone refs into neighbour dirs: existing users' jobs, created before that
fix, still carry cross-directory paths, and vocals are shared by design either
way. The history row still goes — the entry disappears from the UI — only the
directory survives while someone else needs it. Disk is the cheap thing here.
"""
from __future__ import annotations

import importlib
import json
import os
import sys

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))


@pytest.fixture
def dp(tmp_path, monkeypatch):
    """dub_pipeline with DUB_DIR + the history DB isolated to tmp_path."""
    mod = importlib.import_module("services.dub_pipeline")
    dub_dir = tmp_path / "dub"
    dub_dir.mkdir()
    monkeypatch.setattr(mod, "DUB_DIR", str(dub_dir))
    monkeypatch.setattr(mod, "_DUB_DIR_REAL", os.path.realpath(str(dub_dir)))

    import sqlite3

    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE dub_history (id TEXT PRIMARY KEY, job_data TEXT)")

    class _Conn:
        def __enter__(self):
            return db

        def __exit__(self, *a):
            db.commit()

    monkeypatch.setattr(mod, "db_conn", lambda: _Conn())
    return mod, db, dub_dir


def _add_job(db, job_id, job_data: dict):
    db.execute(
        "INSERT INTO dub_history (id, job_data) VALUES (?, ?)",
        (job_id, json.dumps(job_data)),
    )


def test_a_dir_no_other_job_references_reports_no_holders(dp):
    mod, db, dub_dir = dp
    (dub_dir / "job-a").mkdir()
    _add_job(db, "job-a", {"vocals_path": str(dub_dir / "job-a" / "vocals.wav")})
    _add_job(db, "job-b", {"vocals_path": str(dub_dir / "job-b" / "vocals.wav")})
    assert mod.job_dir_referenced_by_others("job-a") == []


def test_a_cache_sharing_job_is_detected_as_a_holder(dp):
    """The reported shape: job B's vocals live in job A's directory."""
    mod, db, dub_dir = dp
    (dub_dir / "job-a").mkdir()
    _add_job(db, "job-a", {"vocals_path": str(dub_dir / "job-a" / "vocals.wav")})
    _add_job(db, "job-b", {"vocals_path": str(dub_dir / "job-a" / "vocals.wav")})
    assert mod.job_dir_referenced_by_others("job-a") == ["job-b"]


def test_pre_fix_clone_refs_are_detected_too(dp):
    """Jobs created before the job-scoped-clones fix carry clone reference
    paths — not vocals — into the neighbour dir. The scan is textual over the
    whole job_data precisely so it does not care which key holds the path."""
    mod, db, dub_dir = dp
    (dub_dir / "job-a").mkdir()
    _add_job(db, "job-a", {"vocals_path": str(dub_dir / "job-a" / "vocals.wav")})
    _add_job(db, "job-b", {
        "vocals_path": str(dub_dir / "job-b" / "vocals.wav"),
        "segment_clones": {
            "7": {"ref_audio": str(dub_dir / "job-a" / "seg_7.wav")},
        },
    })
    assert mod.job_dir_referenced_by_others("job-a") == ["job-b"]


def test_the_job_being_deleted_does_not_count_as_its_own_holder(dp):
    mod, db, dub_dir = dp
    (dub_dir / "job-a").mkdir()
    _add_job(db, "job-a", {"vocals_path": str(dub_dir / "job-a" / "vocals.wav")})
    assert mod.job_dir_referenced_by_others("job-a") == []


def test_a_similar_prefix_is_not_a_false_positive(dp):
    """job-a2's own dir starts with the string "job-a" — the needle carries a
    trailing separator so prefix-sharing ids cannot collide."""
    mod, db, dub_dir = dp
    (dub_dir / "job-a").mkdir()
    _add_job(db, "job-a", {"vocals_path": str(dub_dir / "job-a" / "vocals.wav")})
    _add_job(db, "job-a2", {"vocals_path": str(dub_dir / "job-a2" / "vocals.wav")})
    assert mod.job_dir_referenced_by_others("job-a") == []


def test_windows_style_json_escaped_paths_are_detected(dp):
    """job_data is JSON, so Windows separators are stored escaped
    (``C:\\\\...``). The scan must match that spelling as well, or the guard
    silently never fires on the platform with the most reports."""
    mod, db, dub_dir = dp
    (dub_dir / "job-a").mkdir()
    _add_job(db, "job-a", {"vocals_path": "irrelevant"})
    # Simulate a Windows job_data blob referencing job-a's dir with
    # backslash separators, JSON-escaped on disk.
    win_path = str(dub_dir / "job-a").replace("/", "\\") + "\\vocals.wav"
    db.execute(
        "INSERT INTO dub_history (id, job_data) VALUES (?, ?)",
        ("job-b", json.dumps({"vocals_path": win_path})),
    )
    # safe_job_dir uses the real platform separator, so the full scan can't be
    # driven cross-platform from a posix test host — pin the storage-format
    # premise the needle_json branch exists for: JSON escapes backslashes.
    raw = db.execute("SELECT job_data FROM dub_history WHERE id='job-b'").fetchone()[0]
    assert (str(dub_dir / "job-a").replace("/", "\\") + "\\").replace("\\", "\\\\") in raw


def test_the_delete_endpoint_keeps_a_referenced_dir(dp, monkeypatch):
    """End-to-end at the router level: the row goes, the dir stays, and the
    response says for whom."""
    mod, db, dub_dir = dp
    core = importlib.import_module("api.routers.dub_core")

    job_a = dub_dir / "job-a"
    job_a.mkdir(exist_ok=True)
    (job_a / "vocals.wav").write_bytes(b"RIFF")
    _add_job(db, "job-a", {"vocals_path": str(job_a / "vocals.wav")})
    _add_job(db, "job-b", {"vocals_path": str(job_a / "vocals.wav")})

    monkeypatch.setattr(core, "_safe_job_dir", mod.safe_job_dir)
    monkeypatch.setattr(core, "db_conn", mod.db_conn)  # endpoint's own import
    monkeypatch.setattr(core.dub_pipeline, "purge_jobs",
                        lambda ids, delete_rows, **k: delete_rows())

    result = core.delete_single_dub_history("job-a")
    assert result == {"deleted": True, "dir_kept_for": ["job-b"]}
    assert job_a.is_dir(), "the directory job-b renders from was deleted"
    assert (job_a / "vocals.wav").is_file()
    row = db.execute("SELECT id FROM dub_history WHERE id='job-a'").fetchone()
    assert row is None, "the history row must still be removed"


def test_the_delete_endpoint_still_removes_an_unreferenced_dir(dp, monkeypatch):
    """The guard must not turn every delete into a keep — an unshared job's
    directory still dies with its row."""
    mod, db, dub_dir = dp
    core = importlib.import_module("api.routers.dub_core")

    job_c = dub_dir / "job-c"
    job_c.mkdir()
    (job_c / "vocals.wav").write_bytes(b"RIFF")
    _add_job(db, "job-c", {"vocals_path": str(job_c / "vocals.wav")})

    monkeypatch.setattr(core, "_safe_job_dir", mod.safe_job_dir)
    monkeypatch.setattr(core, "db_conn", mod.db_conn)
    monkeypatch.setattr(core.dub_pipeline, "purge_jobs",
                        lambda ids, delete_rows, **k: delete_rows())

    result = core.delete_single_dub_history("job-c")
    assert result == {"deleted": True, "dir_kept_for": []}
    assert not job_c.exists(), "an unreferenced dir must still be cleaned up"
