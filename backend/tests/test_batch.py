"""Tests for batch dubbing API endpoints.

These tests create a minimal FastAPI app with only the batch router,
avoiding the heavy main app import chain. The batch module is
lightweight — it only imports os, uuid, time, asyncio, logging,
fastapi, and pydantic at module level.
"""
import io
import os
import sys
import pytest

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub core.config before batch imports it
import types
config_mod = types.ModuleType("core.config")
config_mod.DATA_DIR = "/tmp/omnivoice_test_data"
sys.modules["core.config"] = config_mod

from fastapi import FastAPI
from fastapi.testclient import TestClient
from api.routers.batch import router, _jobs, _set_progress


@pytest.fixture(autouse=True)
def reset_state():
    """Clear in-memory state between tests and disable the worker."""
    import api.routers.batch as batch
    batch._jobs.clear()
    batch._queue = None
    if batch._worker_task and not batch._worker_task.done():
        batch._worker_task.cancel()
    batch._worker_task = None

    # Monkey-patch _ensure_queue to use a no-op worker so jobs stay queued
    original_ensure = batch._ensure_queue

    def _test_ensure_queue():
        if batch._queue is None:
            import asyncio

            async def _noop():
                while True:
                    job_id = await batch._queue.get()
                    batch._queue.task_done()

            batch._queue = asyncio.Queue()
            batch._worker_task = asyncio.ensure_future(_noop())

    batch._ensure_queue = _test_ensure_queue
    yield
    batch._ensure_queue = original_ensure
    batch._jobs.clear()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def fake_video():
    return b"\x00\x00\x00\x1c\x66\x74\x79\x70" + b"\x00" * 1016  # 1KB


def _enqueue(client, video_bytes, langs="es", voice_id="", preserve_bg="true"):
    return client.post(
        "/batch/enqueue",
        files={"video": ("test.mp4", io.BytesIO(video_bytes), "video/mp4")},
        data={"langs": langs, "preserve_bg": preserve_bg, **({"voice_id": voice_id} if voice_id else {})},
    )


class TestEnqueue:
    def test_returns_job_id(self, client, fake_video):
        resp = _enqueue(client, fake_video, "es,fr")
        assert resp.status_code == 200
        body = resp.json()
        assert "job_id" in body
        assert body["status"] == "queued"

    def test_empty_langs_fails(self, client, fake_video):
        """Empty langs string should return 400."""
        # Send with no langs field at all
        resp = client.post(
            "/batch/enqueue",
            files={"video": ("test.mp4", io.BytesIO(fake_video), "video/mp4")},
            data={"langs": ",,,", "preserve_bg": "true"},
        )
        assert resp.status_code == 400

    def test_multi_lang_splits(self, client, fake_video):
        resp = _enqueue(client, fake_video, "es,fr,de")
        job_id = resp.json()["job_id"]
        job = client.get(f"/batch/jobs/{job_id}").json()
        assert job["langs"] == ["es", "fr", "de"]

    def test_preserves_filename(self, client, fake_video):
        resp = _enqueue(client, fake_video)
        job_id = resp.json()["job_id"]
        job = client.get(f"/batch/jobs/{job_id}").json()
        assert job["filename"] == "test.mp4"


class TestListJobs:
    def test_empty(self, client):
        resp = client.get("/batch/jobs")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_enqueued(self, client, fake_video):
        _enqueue(client, fake_video)
        _enqueue(client, fake_video)
        jobs = client.get("/batch/jobs").json()
        assert len(jobs) == 2

    def test_filter_active(self, client, fake_video):
        r1 = _enqueue(client, fake_video).json()
        r2 = _enqueue(client, fake_video).json()
        client.post(f"/batch/jobs/{r2['job_id']}/cancel")

        active = client.get("/batch/jobs?status=active").json()
        assert len(active) == 1
        assert active[0]["id"] == r1["job_id"]

    def test_filter_cancelled(self, client, fake_video):
        r = _enqueue(client, fake_video).json()
        client.post(f"/batch/jobs/{r['job_id']}/cancel")

        cancelled = client.get("/batch/jobs?status=cancelled").json()
        assert len(cancelled) == 1


class TestGetJob:
    def test_not_found(self, client):
        assert client.get("/batch/jobs/nope").status_code == 404

    def test_found(self, client, fake_video):
        r = _enqueue(client, fake_video).json()
        job = client.get(f"/batch/jobs/{r['job_id']}").json()
        assert job["id"] == r["job_id"]
        assert job["status"] == "queued"


class TestCancelJob:
    def test_cancel_queued(self, client, fake_video):
        r = _enqueue(client, fake_video).json()
        resp = client.post(f"/batch/jobs/{r['job_id']}/cancel")
        assert resp.json()["cancelled"] is True
        job = client.get(f"/batch/jobs/{r['job_id']}").json()
        assert job["status"] == "cancelled"

    def test_cancel_already_done(self, client, fake_video):
        r = _enqueue(client, fake_video).json()
        _jobs[r["job_id"]]["status"] = "done"
        resp = client.post(f"/batch/jobs/{r['job_id']}/cancel")
        assert resp.json()["already"] == "done"

    def test_cancel_not_found(self, client):
        assert client.post("/batch/jobs/nope/cancel").status_code == 404


class TestDeleteJob:
    def test_delete_cancelled(self, client, fake_video):
        r = _enqueue(client, fake_video).json()
        client.post(f"/batch/jobs/{r['job_id']}/cancel")
        resp = client.delete(f"/batch/jobs/{r['job_id']}")
        assert resp.json()["deleted"] is True
        assert client.get(f"/batch/jobs/{r['job_id']}").status_code == 404

    def test_delete_not_found(self, client):
        assert client.delete("/batch/jobs/nope").status_code == 404


class TestSetProgress:
    def test_basic(self):
        job = {}
        _set_progress(job, "transcribe", 50, segments_count=10)
        assert job["progress"]["stage"] == "transcribe"
        assert job["progress"]["percent"] == 50
        assert job["progress"]["segments_count"] == 10

    def test_overwrite(self):
        job = {"progress": {"stage": "extract", "percent": 100}}
        _set_progress(job, "generate", 25, current_lang="es")
        assert job["progress"]["stage"] == "generate"
        assert job["progress"]["current_lang"] == "es"
