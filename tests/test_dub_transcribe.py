"""Integration test for POST /dub/transcribe/{job_id}.

Covers the full `_transcribe` closure inside `dub_core.py` with a recorded
Whisper output. No GPU, no model, no pyannote — just the real transcription
post-processing + segmentation pipeline exercised through the API.
"""

from __future__ import annotations

import io
import json
import os
import struct
import uuid
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_wav(path: Path, seconds: float = 1.0, sr: int = 16000) -> None:
    n = int(seconds * sr)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(struct.pack(f"<{n}h", *([0] * n)))


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def app_client(tmp_path, monkeypatch):
    """TestClient w/ isolated data dir; seeded fake model + no diarization."""
    monkeypatch.setenv("OMNIVOICE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HF_TOKEN", raising=False)

    # Force module reloads so core.config rebinds DATA_DIR to the tmp dir.
    import importlib
    import core.config as _cfg
    importlib.reload(_cfg)
    from api.routers import dub_core as _dc
    importlib.reload(_dc)
    import main as _main
    importlib.reload(_main)

    from fastapi.testclient import TestClient

    fake_model = MagicMock()
    fake_model.sampling_rate = 24000
    fake_model._asr_pipe = MagicMock()  # truthy — not-None passes preflight

    async def _get_model_stub():
        return fake_model

    monkeypatch.setattr(_main, "idle_worker", lambda: _noop_forever())
    monkeypatch.setattr(_dc, "get_model", _get_model_stub)
    monkeypatch.setattr(_dc, "get_diarization_pipeline", lambda: None)

    with TestClient(_main.app) as client:
        yield client, _dc, tmp_path


async def _noop_forever():
    import asyncio
    while True:
        await asyncio.sleep(3600)


def _seed_job(dc_module, tmp_path: Path, duration: float, scene_cuts=None) -> str:
    job_id = f"test_{uuid.uuid4().hex[:8]}"
    job_dir = tmp_path / "dub_jobs" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    audio_path = job_dir / "audio.wav"
    vocals_path = job_dir / "vocals.wav"
    _make_wav(audio_path, seconds=max(0.5, duration / 8))  # small stub
    _make_wav(vocals_path, seconds=max(0.5, duration / 8))

    dc_module._dub_jobs[job_id] = {
        "video_path": str(job_dir / "original.mp4"),
        "audio_path": str(audio_path),
        "vocals_path": str(vocals_path),
        "no_vocals_path": None,
        "duration": duration,
        "filename": "fixture.mp4",
        "segments": None,
        "dubbed_tracks": {},
        "scene_cuts": scene_cuts or [],
    }
    return job_id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_transcribe_stream_surfaces_model_load_failure(tmp_path, monkeypatch):
    """Regression #255: when the model fails to load, the SSE transcribe stream
    must emit a structured `error` event carrying the real cause — not silently
    drop the connection (the UI renders a dropped stream as a misleading generic
    "Transcribe stream dropped … Likely ASR backend failed to load").

    Drives the route's async generator directly (no TestClient/lifespan) — the
    preflight-error path yields a single event with no executor/Queue, so it
    stays isolated from the app event loop.
    """
    import asyncio
    from api.routers import dub_core as dc

    job_id = "t_modelfail"
    dc._dub_jobs[job_id] = {"audio_path": str(tmp_path / "a.wav"), "vocals_path": None}

    async def _boom():
        raise RuntimeError("CUDA driver init failed: simulated")

    monkeypatch.setattr(dc, "get_model", _boom)

    async def _collect():
        resp = await dc.dub_transcribe_stream(job_id)
        parts = []
        async for chunk in resp.body_iterator:
            parts.append(chunk.decode() if isinstance(chunk, (bytes, bytearray)) else str(chunk))
        return "".join(parts)

    try:
        body = asyncio.run(_collect())
    finally:
        dc._dub_jobs.pop(job_id, None)

    assert "event: error" in body, body
    assert "CUDA driver init failed: simulated" in body, body


def test_transcribe_stream_never_closes_without_terminal_event(tmp_path, monkeypatch):
    """Regression #516: an unanticipated exception INSIDE the stream body (one
    that escapes the per-chunk handler, e.g. segmentation blowing up) must still
    end the stream with a terminal `error` then `done` — never a silent
    disconnect (which the UI can only report as "stream dropped, likely ASR
    failed", hiding the real cause)."""
    import asyncio
    import numpy as np
    from api.routers import dub_core as dc

    job_id = "t_bodycrash"
    audio = tmp_path / "a.wav"
    _make_wav(audio, seconds=1.0)
    dc._dub_jobs[job_id] = {
        "audio_path": str(audio), "vocals_path": None, "scene_cuts": [],
    }

    # Model + ASR backend load fine (preflight passes), so the failure happens
    # mid-body where the terminal-event guard is the only safety net.
    fake_model = MagicMock()
    fake_model._asr_pipe = MagicMock()

    async def _ok_model():
        return fake_model

    class _FakeASR:
        id = "fake"
        def ensure_loaded(self):  # preflight eager-load (no-op for the fake)
            pass
        def transcribe(self, path, *, word_timestamps=True):
            return {"chunks": [{"text": "hi", "timestamp": (0.0, 0.5)}],
                    "segments": [], "language": "en"}
        def unload(self):
            pass

    monkeypatch.setattr(dc, "get_model", _ok_model)
    monkeypatch.setattr(
        "services.asr_backend.get_active_asr_backend",
        lambda *a, **k: _FakeASR(),
    )
    # Make the post-chunk segmentation (outside the per-chunk try/except) blow
    # up — the exact class of "unanticipated escape" the guard must catch.
    def _boom_segment(*a, **k):
        raise RuntimeError("segmentation exploded: simulated")
    monkeypatch.setattr(dc, "segment_transcript", _boom_segment)
    # Don't touch the GPU/TTS during the test.
    monkeypatch.setattr(dc, "offload_tts_for_asr", lambda *a, **k: None)

    async def _collect():
        resp = await dc.dub_transcribe_stream(job_id)
        parts = []
        async for chunk in resp.body_iterator:
            parts.append(chunk.decode() if isinstance(chunk, (bytes, bytearray)) else str(chunk))
        return "".join(parts)

    try:
        body = asyncio.run(_collect())
    finally:
        dc._dub_jobs.pop(job_id, None)

    # The stream must end with a terminal error followed by done.
    assert "event: error" in body, body
    assert "segmentation exploded: simulated" in body, body
    err_idx = body.rfind("event: error")
    done_idx = body.rfind("event: done")
    assert done_idx > err_idx >= 0, f"error must precede the terminal done: {body}"


def test_transcribe_stream_surfaces_asr_load_failure_at_preflight(tmp_path, monkeypatch):
    """Regression #578: the reported failure mode is the *ASR model* failing to
    load (WhisperX: faster-whisper weights / CTranslate2-cuDNN mismatch / the
    torch-2.6 weights-only VAD regression), not the TTS model. Because WhisperX
    loads lazily inside ``transcribe()``, that failure used to be buried in N
    per-chunk errors (and the bare error event raced the browser's native
    connection-drop, so the UI showed the misleading generic "stream dropped …
    ASR backend failed to load").

    The preflight now eagerly calls ``backend.ensure_loaded()`` so the *real*
    cause surfaces once, as a structured ``error`` event, ALWAYS followed by a
    terminal ``done`` (so the stream closes via a named event, never a raw
    drop the client can only render generically).
    """
    import asyncio
    from api.routers import dub_core as dc

    job_id = "t_asrload"
    audio = tmp_path / "a.wav"
    _make_wav(audio, seconds=1.0)
    dc._dub_jobs[job_id] = {
        "audio_path": str(audio), "vocals_path": None, "scene_cuts": [],
    }

    # TTS model loads fine; the *ASR backend* fails to load — the #578 case.
    fake_model = MagicMock()
    fake_model._asr_pipe = None

    async def _ok_model():
        return fake_model

    class _BoomASR:
        id = "whisperx"
        def ensure_loaded(self):
            raise RuntimeError(
                "Could not load library libcudnn_ops_infer.so.8: simulated"
            )
        def transcribe(self, path, *, word_timestamps=True):  # pragma: no cover
            raise AssertionError("transcribe must not run when load fails")
        def unload(self):
            pass

    monkeypatch.setattr(dc, "get_model", _ok_model)
    monkeypatch.setattr(
        "services.asr_backend.get_active_asr_backend",
        lambda *a, **k: _BoomASR(),
    )

    async def _collect():
        resp = await dc.dub_transcribe_stream(job_id)
        parts = []
        async for chunk in resp.body_iterator:
            parts.append(chunk.decode() if isinstance(chunk, (bytes, bytearray)) else str(chunk))
        return "".join(parts)

    try:
        body = asyncio.run(_collect())
    finally:
        dc._dub_jobs.pop(job_id, None)

    # Real cause surfaced as a structured error, not the generic "stream dropped".
    assert "event: error" in body, body
    assert "ASR backend initialization failed" in body, body
    assert "libcudnn_ops_infer.so.8: simulated" in body, body
    assert "stream dropped" not in body, body
    # And it must be followed by a terminal `done` so the client closes via a
    # named event — never a bare error+connection-drop (which races the
    # browser's native EventSource error and loses the real cause).
    err_idx = body.find("event: error")
    done_idx = body.find("event: done")
    assert done_idx > err_idx >= 0, f"error must be followed by terminal done: {body}"


def test_reset_pool_on_wedge_resets_resilient_pool():
    """#730: a chunk transcribe that times out wedges its GPU-pool worker. The
    chunked stream must abandon the pool so the next chunk / a concurrent TTS
    generate gets a fresh worker instead of starving behind it. dub_core now
    shares asr_backend.reset_pool_after_wedge with the whole-file guards — one
    mechanism, no drift."""
    from api.routers import dub_core as dc

    class _Pool:
        def __init__(self):
            self.resets = 0

        def reset(self):
            self.resets += 1

    pool = _Pool()
    assert dc.reset_pool_after_wedge(pool) is True
    assert pool.resets == 1


def test_reset_pool_on_wedge_is_a_noop_without_reset():
    """A plain executor has no reset(); the helper must no-op, never raise —
    it runs on the failure path it's recovering from."""
    from concurrent.futures import ThreadPoolExecutor

    from api.routers import dub_core as dc

    pool = ThreadPoolExecutor(max_workers=1)
    try:
        assert dc.reset_pool_after_wedge(pool) is False  # must not raise
    finally:
        pool.shutdown(wait=False)


def test_wedged_chunk_goes_through_guarded_reset_with_actionable_error(tmp_path, monkeypatch):
    """Residual A on #730: a chunk that WEDGES (hangs past its timeout) must get
    the SAME guarded-timeout + pool-reset semantics as the whole-file paths
    (#851) — run_transcribe_guarded resets the pool once per wedged attempt and
    the user sees the actionable ASRTimeoutError, not the old dead-end "Try
    restarting the server". And because the retry (#867) wedges too, the second
    consecutive timeout must surface the crash-isolated engine recommendation
    (Residual B) in the stream error the user sees.
    """
    import asyncio
    import threading
    from concurrent.futures import Executor, ThreadPoolExecutor

    from api.routers import dub_core as dc
    from services import asr_backend

    class _RecordingPool(Executor):
        """Executor with a #851-style reset(): swap the inner pool, count calls."""

        def __init__(self):
            self.resets = 0
            self._inner = ThreadPoolExecutor(max_workers=1)

        def submit(self, fn, /, *args, **kwargs):
            return self._inner.submit(fn, *args, **kwargs)

        def reset(self):
            self.resets += 1
            old, self._inner = self._inner, ThreadPoolExecutor(max_workers=1)
            old.shutdown(wait=False, cancel_futures=True)

        def shutdown(self, wait=True, *, cancel_futures=False):
            self._inner.shutdown(wait=False, cancel_futures=True)

    release_wedge = threading.Event()

    class _WedgedASR:
        id = "whisperx"

        def ensure_loaded(self):
            pass

        def transcribe(self, path, *, word_timestamps=True):
            release_wedge.wait(timeout=30)  # wedge far past the tiny chunk timeout
            return {"chunks": [], "segments": [], "language": "en"}

        def unload(self):
            pass

    job_id = "t_wedge"
    audio = tmp_path / "a.wav"
    _make_wav(audio, seconds=1.0)
    dc._dub_jobs[job_id] = {
        "audio_path": str(audio), "vocals_path": None, "scene_cuts": [],
    }

    fake_model = MagicMock()
    fake_model._asr_pipe = MagicMock()

    async def _ok_model():
        return fake_model

    pool = _RecordingPool()
    monkeypatch.setattr(dc, "get_model", _ok_model)
    monkeypatch.setattr(dc, "_gpu_pool", pool)
    monkeypatch.setattr(dc, "TRANSCRIBE_CHUNK_TIMEOUT_S", 0.2)
    monkeypatch.setattr(dc, "_CHUNK_TRANSCRIBE_ATTEMPTS", 2)
    monkeypatch.setattr(dc, "offload_tts_for_asr", lambda *a, **k: None)
    monkeypatch.setattr(
        "services.asr_backend.get_active_asr_backend",
        lambda *a, **k: _WedgedASR(),
    )
    # Deterministic streak + recommendation: start at 0, active engine is not
    # already the isolated one (prefs on the dev box must not leak in).
    monkeypatch.setattr(asr_backend, "_timeout_streak", 0)
    monkeypatch.setattr(asr_backend, "active_backend_id", lambda: "whisperx")

    async def _collect():
        resp = await dc.dub_transcribe_stream(job_id)
        parts = []
        async for chunk in resp.body_iterator:
            parts.append(chunk.decode() if isinstance(chunk, (bytes, bytearray)) else str(chunk))
        return "".join(parts)

    try:
        body = asyncio.run(_collect())
    finally:
        release_wedge.set()  # let the wedged worker threads exit
        pool.shutdown()
        dc._dub_jobs.pop(job_id, None)

    # Pool reset exactly once per wedged attempt, inside run_transcribe_guarded
    # (no double-reset from the retry branch).
    assert pool.resets == 2, f"expected one guarded reset per attempt, got {pool.resets}"
    # The user-facing chunk error is the guard's actionable message …
    assert "backend is running" in body, body
    assert "OMNIVOICE_TRANSCRIBE_CHUNK_TIMEOUT_S" in body, body
    # … not the old parallel mechanism's dead-end advice.
    assert "Try restarting the server" not in body, body
    # Second consecutive timeout-with-reset → the crash-isolated engine
    # recommendation surfaces in the error the user sees (Residual B).
    assert "faster-whisper-isolated" in body, body
    # Terminal error followed by done — stream still closes via named events.
    err_idx = body.rfind("event: error")
    done_idx = body.rfind("event: done")
    assert done_idx > err_idx >= 0, body


@pytest.mark.xfail(
    reason="dub_core._transcribe was refactored to route through "
           "services.asr_backend.get_active_asr_backend; the MagicMock fixture "
           "no longer satisfies the new bytes-path contract. Re-enable after "
           "updating mocks to the new backend interface.",
    strict=False,
)
class TestTranscribeRoute:
    def test_screenshot_regression_consolidates_fragments(self, app_client):
        """18 garbled Whisper chunks → clean segments, no mid-word stubs."""
        client, dc, tmp = app_client
        job_id = _seed_job(dc, tmp, duration=18.0)

        with patch("mlx_whisper.transcribe", return_value=_load_fixture("whisper_screenshot.json")), \
             patch("torch.backends.mps.is_available", return_value=True):
            res = client.post(f"/dub/transcribe/{job_id}")

        assert res.status_code == 200, res.text
        payload = res.json()
        assert payload["job_id"] == job_id
        assert payload["source_lang"] == "en"

        segs = payload["segments"]
        assert 1 < len(segs) < 8, f"expected consolidation, got {len(segs)}"

        # No fragment survives past the floor (except possibly the trailing one).
        from services.segmentation import MIN_DUR, MIN_CHARS
        for s in segs[:-1]:
            assert (s["end"] - s["start"]) >= MIN_DUR
            assert len(s["text"]) >= MIN_CHARS

        # The original bug was that "stru", "c", "tured" were their OWN rows in
        # the segments table. Assert none of those appear as standalone segments.
        for frag in ("stru", "c", "tured", "ge", "The AI", "Then you"):
            assert frag not in [s["text"].strip() for s in segs], (
                f"{frag!r} leaked as a standalone segment"
            )

        # Every segment ends on a real word boundary.
        for s in segs:
            assert s["text"].strip(), "empty text"
            last = s["text"].rstrip()[-1]
            assert last.isalnum() or last in ".,!?;:'\")", f"trailing char {last!r}"

    def test_clean_input_preserves_sentence_structure(self, app_client):
        client, dc, tmp = app_client
        job_id = _seed_job(dc, tmp, duration=14.0)

        with patch("mlx_whisper.transcribe", return_value=_load_fixture("whisper_clean.json")), \
             patch("torch.backends.mps.is_available", return_value=True):
            res = client.post(f"/dub/transcribe/{job_id}")

        assert res.status_code == 200, res.text
        segs = res.json()["segments"]
        # Every seg ends with sentence terminator (clean-input property).
        for s in segs:
            assert s["text"].rstrip().endswith((".", "!", "?"))

    def test_heuristic_speaker_assignment_without_diarization(self, app_client):
        client, dc, tmp = app_client
        job_id = _seed_job(dc, tmp, duration=18.0)

        with patch("mlx_whisper.transcribe", return_value=_load_fixture("whisper_screenshot.json")), \
             patch("torch.backends.mps.is_available", return_value=True):
            res = client.post(f"/dub/transcribe/{job_id}")

        segs = res.json()["segments"]
        for s in segs:
            assert s["speaker_id"].startswith("Speaker ")

    def test_missing_job_returns_404(self, app_client):
        client, _, _ = app_client
        res = client.post("/dub/transcribe/does_not_exist")
        assert res.status_code == 404

    def test_source_lang_detected_and_persisted(self, app_client):
        client, dc, tmp = app_client
        job_id = _seed_job(dc, tmp, duration=18.0)

        fixture = _load_fixture("whisper_screenshot.json")
        fixture["language"] = "es_ES"  # simulate Whisper dialect output

        with patch("mlx_whisper.transcribe", return_value=fixture), \
             patch("torch.backends.mps.is_available", return_value=True):
            res = client.post(f"/dub/transcribe/{job_id}")

        assert res.status_code == 200
        assert res.json()["source_lang"] == "es"
        # In-memory job was updated.
        assert dc._dub_jobs[job_id]["source_lang"] == "es"

    def test_scene_cuts_applied_when_viable(self, app_client):
        client, dc, tmp = app_client
        job_id = _seed_job(dc, tmp, duration=14.0, scene_cuts=[5.5])

        with patch("mlx_whisper.transcribe", return_value=_load_fixture("whisper_clean.json")), \
             patch("torch.backends.mps.is_available", return_value=True):
            res = client.post(f"/dub/transcribe/{job_id}")

        segs = res.json()["segments"]
        # At least one segment boundary should land at/near the scene cut.
        near_cut = [s for s in segs if abs(s["end"] - 5.5) < 0.2 or abs(s["start"] - 5.5) < 0.2]
        assert near_cut, f"no segment boundary near scene cut 5.5; got {[(s['start'], s['end']) for s in segs]}"
