"""A dub must not load the TTS model just to throw it away.

The transcribe preflight in ``dub_core`` called ``get_model()`` — pulling the full
~3 GB TTS core into memory — for exactly one reason: to read a preloaded
``_asr_pipe`` off it. But that attribute is only ever set by
``OmniVoice.from_pretrained`` under ``OMNIVOICE_PRELOAD_TTS_ASR``, which is off by
default ("intentionally false", model_manager.should_preload_tts_asr).

So in the default configuration every dub:
  1. loaded the TTS core,
  2. harvested ``None`` from it,
  3. had ``offload_tts_for_asr()`` free it again a few lines later — on unified
     memory (Apple Silicon) that offload is a full UNLOAD (#1119),
  4. and then cold-reloaded the very same model in dub_generate (~8 s).

Load → unload → reload, once per dub, for an attribute that was always None.
These tests pin the model load to the only case that can actually use it.
"""
from __future__ import annotations

import asyncio
import struct
import uuid
import wave
from pathlib import Path

import pytest


def _make_wav(path: Path, seconds: float = 0.5, sr: int = 16000) -> None:
    n = int(seconds * sr)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(struct.pack(f"<{n}h", *([0] * n)))


class _FakeASR:
    id = "fake"

    def ensure_loaded(self):
        pass

    def transcribe(self, path, *, word_timestamps=True):
        return {"chunks": [{"text": "hi", "timestamp": (0.0, 0.5)}],
                "segments": [], "language": "en"}

    def unload(self):
        pass


@pytest.fixture()
def dub(tmp_path, monkeypatch):
    """dub_core rebound to an isolated data dir, with a job seeded and every
    heavy dependency stubbed. Yields (module, job_id, load_counter)."""
    monkeypatch.setenv("OMNIVOICE_DATA_DIR", str(tmp_path))

    import importlib
    import core.config as _cfg
    importlib.reload(_cfg)
    from api.routers import dub_core as dc
    importlib.reload(dc)

    calls = {"get_model": 0}

    async def _counting_get_model():
        calls["get_model"] += 1
        raise AssertionError(
            "dub loaded the TTS core model during the ASR preflight — it only has "
            "an _asr_pipe to harvest when OMNIVOICE_PRELOAD_TTS_ASR is set"
        )

    monkeypatch.setattr(dc, "get_model", _counting_get_model)
    monkeypatch.setattr(dc, "get_diarization_pipeline", lambda *a, **k: None)
    monkeypatch.setattr(dc, "offload_tts_for_asr", lambda *a, **k: None)
    monkeypatch.setattr(dc, "restore_tts_after_asr", lambda *a, **k: None)
    monkeypatch.setattr(
        "services.asr_backend.get_active_asr_backend", lambda *a, **k: _FakeASR()
    )

    job_id = f"test_{uuid.uuid4().hex[:8]}"
    job_dir = tmp_path / "dub_jobs" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    audio = job_dir / "audio.wav"
    vocals = job_dir / "vocals.wav"
    _make_wav(audio)
    _make_wav(vocals)
    dc._dub_jobs[job_id] = {
        "video_path": str(job_dir / "original.mp4"),
        "audio_path": str(audio), "vocals_path": str(vocals),
        "no_vocals_path": None, "duration": 1.0, "filename": "f.mp4",
        "segments": None, "dubbed_tracks": {}, "scene_cuts": [],
    }
    return dc, job_id, calls


def _drain(dc, job_id) -> str:
    async def _collect():
        resp = await dc.dub_transcribe_stream(job_id)
        parts = []
        async for c in resp.body_iterator:
            parts.append(c.decode() if isinstance(c, bytes) else c)
        return "".join(parts)
    return asyncio.run(_collect())


def test_transcribe_does_not_load_the_tts_model(dub):
    """The regression: default config must never touch the TTS core to transcribe."""
    dc, job_id, calls = dub
    body = _drain(dc, job_id)
    assert calls["get_model"] == 0, "dub loaded the TTS core it was about to free"
    # And the stream still worked — we didn't just break the preflight.
    assert "error" not in body or "segment" in body or "done" in body


def test_transcribe_still_loads_the_model_when_preload_is_on(dub, monkeypatch):
    """The one case the load is for: an _asr_pipe actually exists to harvest."""
    dc, job_id, calls = dub
    monkeypatch.setattr(dc, "should_preload_tts_asr", lambda: True)

    class _Model:
        _asr_pipe = object()

    async def _get_model():
        calls["get_model"] += 1
        return _Model()

    monkeypatch.setattr(dc, "get_model", _get_model)
    _drain(dc, job_id)
    assert calls["get_model"] == 1


def test_preflight_error_does_not_leave_asr_on_vocals_unbound(dub, monkeypatch):
    """`asr_on_vocals` was assigned only inside the model-loaded branch but read
    from _gen_body — an early preflight bail raised NameError over the real error."""
    dc, job_id, calls = dub
    dc._dub_jobs[job_id]["audio_path"] = "/nonexistent/audio.wav"
    dc._dub_jobs[job_id]["vocals_path"] = "/nonexistent/vocals.wav"
    body = _drain(dc, job_id)
    assert "NameError" not in body
    assert "No audio available" in body
