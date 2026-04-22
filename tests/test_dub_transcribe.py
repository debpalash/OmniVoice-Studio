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
