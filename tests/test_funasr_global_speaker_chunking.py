"""FunASR CAM++ speaker IDs must be clustered over the whole recording."""

from __future__ import annotations

import asyncio
import json
import struct
import wave
from pathlib import Path

import pytest

from api.routers import dub_core as dc
from services.asr_backend import FunASRBackend


def _make_wav(path: Path, seconds: float, sr: int = 16000) -> None:
    samples = int(seconds * sr)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sr)
        wav.writeframes(struct.pack(f"<{samples}h", *([0] * samples)))


def _wav_duration(path: str) -> float:
    with wave.open(path, "rb") as wav:
        return wav.getnframes() / float(wav.getframerate())


def _events(body: str) -> list[tuple[str, dict]]:
    events = []
    for block in body.strip().split("\n\n"):
        lines = block.splitlines()
        event = next(
            (
                line.removeprefix("event: ")
                for line in lines
                if line.startswith("event: ")
            ),
            None,
        )
        data = next(
            (
                line.removeprefix("data: ")
                for line in lines
                if line.startswith("data: ")
            ),
            None,
        )
        if event and data:
            events.append((event, json.loads(data)))
    return events


class _RecordingASR:
    id = "recording"

    def __init__(self, *, whole_file: bool):
        self.requires_full_audio_for_speaker_consistency = whole_file
        self.durations = []

    def ensure_loaded(self):
        pass

    def transcribe(self, path, *, word_timestamps=True):
        duration = _wav_duration(path)
        self.durations.append(duration)
        return {
            "chunks": [
                {
                    "text": "A complete recording with enough words.",
                    "timestamp": (0.0, duration),
                }
            ],
            "segments": [
                {
                    "text": "A complete recording with enough words.",
                    "start": 0.0,
                    "end": duration,
                    "speaker": "Speaker 1",
                }
            ],
            "language": "en",
        }

    def unload(self):
        pass


def _run_stream(tmp_path, monkeypatch, *, job_id: str, backend: _RecordingASR):
    audio = tmp_path / f"{job_id}.wav"
    _make_wav(audio, seconds=65.0)
    dc._dub_jobs[job_id] = {
        "audio_path": str(audio),
        "vocals_path": None,
        "scene_cuts": [],
    }

    monkeypatch.setattr(dc, "should_preload_tts_asr", lambda: False)
    monkeypatch.setattr(
        "services.asr_backend.get_active_asr_backend",
        lambda *args, **kwargs: backend,
    )
    monkeypatch.setattr(dc, "offload_tts_for_asr", lambda *args, **kwargs: None)
    monkeypatch.setattr(dc, "restore_tts_after_asr", lambda *args, **kwargs: None)
    monkeypatch.setattr(dc, "_save_job", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "services.speaker_clone.extract_speaker_clones",
        lambda *args, **kwargs: {},
    )
    monkeypatch.setattr(
        dc,
        "get_diarization_pipeline",
        lambda *args, **kwargs: pytest.fail("inline turns must skip pyannote"),
    )

    guarded_calls = []

    async def _run_guarded(executor, fn, **kwargs):
        guarded_calls.append(kwargs)
        return fn()

    monkeypatch.setattr(dc, "run_transcribe_guarded", _run_guarded)
    monkeypatch.setattr(dc, "ASR_TRANSCRIBE_TIMEOUT_S", 321.0, raising=False)
    monkeypatch.setattr(dc, "TRANSCRIBE_CHUNK_TIMEOUT_S", 123.0)

    async def _collect():
        response = await dc.dub_transcribe_stream(job_id, per_segment_refs=False)
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else str(chunk))
        return "".join(chunks)

    try:
        return asyncio.run(_collect()), guarded_calls
    finally:
        dc._dub_jobs.pop(job_id, None)


def test_funasr_campp_requires_one_global_transcription(monkeypatch):
    monkeypatch.setenv("ASR_FUNASR_SPK", "cam++")
    assert FunASRBackend().requires_full_audio_for_speaker_consistency is True

    monkeypatch.setenv("ASR_FUNASR_SPK", "")
    assert FunASRBackend().requires_full_audio_for_speaker_consistency is False


def test_global_speaker_backend_receives_the_whole_recording(tmp_path, monkeypatch):
    backend = _RecordingASR(whole_file=True)
    body, guarded_calls = _run_stream(
        tmp_path,
        monkeypatch,
        job_id="global_speakers",
        backend=backend,
    )

    assert backend.durations == pytest.approx([65.0], abs=0.01)
    assert guarded_calls == [
        {
            "what": "Dub chunk 1/1",
            "timeout": 321.0,
            "timeout_env": "OMNIVOICE_ASR_TRANSCRIBE_TIMEOUT_S",
        }
    ]
    start = next(data for event, data in _events(body) if event == "start")
    assert start["chunks"] == 1
    assert start["chunk_s"] == pytest.approx(65.0)


def test_ordinary_backend_keeps_bounded_chunks(tmp_path, monkeypatch):
    backend = _RecordingASR(whole_file=False)
    body, guarded_calls = _run_stream(
        tmp_path,
        monkeypatch,
        job_id="ordinary_chunks",
        backend=backend,
    )

    assert backend.durations == pytest.approx([30.0, 30.0, 5.0], abs=0.01)
    assert [call["timeout"] for call in guarded_calls] == [123.0, 123.0, 123.0]
    assert {call["timeout_env"] for call in guarded_calls} == {
        "OMNIVOICE_TRANSCRIBE_CHUNK_TIMEOUT_S",
    }
    start = next(data for event, data in _events(body) if event == "start")
    assert start["chunks"] == 3
    assert start["chunk_s"] == pytest.approx(30.0)
