"""Destructive endpoints must not report success when file cleanup fails."""
from contextlib import contextmanager
import importlib
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


@pytest.fixture
def app_modules():
    """Resolve application modules at test time to avoid stale import state."""
    file_cleanup = importlib.import_module("core.file_cleanup")
    return SimpleNamespace(
        batch=importlib.import_module("api.routers.batch"),
        gallery=importlib.import_module("api.routers.gallery"),
        system=importlib.import_module("api.routers.system"),
        FileCleanupError=file_cleanup.FileCleanupError,
        unlink_if_present=file_cleanup.unlink_if_present,
    )


class _Result:
    def __init__(self, row=None):
        self._row = row

    def fetchone(self):
        return self._row


class _Connection:
    def __init__(self, audio_path):
        self.audio_path = audio_path
        self.deleted = False

    def execute(self, query, _params=()):
        if query.startswith("SELECT"):
            return _Result({"audio_path": self.audio_path})
        if query.startswith("DELETE"):
            self.deleted = True
        return _Result()


def test_unlink_missing_file_is_idempotent(tmp_path, app_modules):
    assert app_modules.unlink_if_present(tmp_path / "already-gone.wav") is False


def test_gallery_delete_keeps_record_when_audio_cannot_be_removed(monkeypatch, app_modules):
    gallery = app_modules.gallery
    conn = _Connection("locked.wav")

    @contextmanager
    def fake_db():
        yield conn

    monkeypatch.setattr(gallery, "db_conn", fake_db)
    monkeypatch.setattr(
        gallery,
        "unlink_if_present",
        lambda _path: (_ for _ in ()).throw(app_modules.FileCleanupError("locked")),
    )

    with pytest.raises(HTTPException) as caught:
        gallery.delete_voice("voice-1")

    assert caught.value.status_code == 500
    assert conn.deleted is False
    assert "locked.wav" not in caught.value.detail


def test_batch_delete_keeps_job_when_video_cannot_be_removed(monkeypatch, app_modules):
    batch = app_modules.batch
    job = {"video_path": "locked.mp4"}
    monkeypatch.setitem(batch._jobs, "job-1", job)
    monkeypatch.setattr(
        batch,
        "unlink_if_present",
        lambda _path: (_ for _ in ()).throw(app_modules.FileCleanupError("locked")),
    )

    with pytest.raises(HTTPException) as caught:
        batch.delete_batch_job("job-1")

    assert caught.value.status_code == 500
    assert batch._jobs["job-1"] is job
    assert "locked.mp4" not in caught.value.detail


def test_gallery_batch_delete_reports_failure_and_keeps_failed_record(monkeypatch, app_modules):
    gallery = app_modules.gallery
    conn = _Connection("locked.wav")

    @contextmanager
    def fake_db():
        yield conn

    monkeypatch.setattr(gallery, "db_conn", fake_db)
    monkeypatch.setattr(
        gallery,
        "unlink_if_present",
        lambda _path: (_ for _ in ()).throw(app_modules.FileCleanupError("locked")),
    )

    assert gallery.batch_delete_voices({"ids": ["voice-1"]}) == {
        "deleted": 0,
        "failed": 1,
    }
    assert conn.deleted is False


@pytest.mark.asyncio
async def test_tauri_log_clear_reports_truncate_failure(monkeypatch, tmp_path, app_modules):
    system = app_modules.system
    log = tmp_path / "webview.log"
    log.write_text("data", encoding="utf-8")
    monkeypatch.setattr(system, "_tauri_log_candidates", lambda: [str(log)])
    monkeypatch.setattr(
        system,
        "_truncate_file",
        lambda _path: (_ for _ in ()).throw(PermissionError("locked")),
    )

    with pytest.raises(HTTPException) as caught:
        await system.clear_tauri_logs()

    assert caught.value.status_code == 500
    assert str(log) not in caught.value.detail
