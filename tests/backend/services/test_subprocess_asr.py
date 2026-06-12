"""Crash-isolated ASR (Wave 4.2 / Spec 7).

Validates the SubprocessASRBackend round-trip + crash recovery against the
stdlib-only echo sidecar (no torch, runs everywhere). Mirrors
test_subprocess_backend.py's echo-subclass pattern.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import torch  # noqa: F401 — front-load torch during collection (matches
# test_subprocess_backend.py); transcribe() lazily imports model_manager,
# and a mid-test cold torch import hangs on this dev box's Triton cache.

from services.subprocess_asr import SubprocessASRBackend

REPO_ROOT = Path(__file__).resolve().parents[3]
ECHO_SCRIPT = REPO_ROOT / "backend" / "engines" / "_echo" / "main.py"


class EchoASRBackend(SubprocessASRBackend):
    id = "_echo_asr"
    display_name = "Echo ASR (test)"

    @classmethod
    def is_available(cls):
        return (True, "ready") if ECHO_SCRIPT.is_file() else (False, "missing")

    @classmethod
    def venv_python(cls):
        return Path(sys.executable)

    @classmethod
    def sidecar_script(cls):
        return ECHO_SCRIPT


@pytest.fixture
def asr():
    b = EchoASRBackend()
    yield b
    try:
        b.shutdown()
    except Exception:
        pass


def test_transcribe_round_trip(asr):
    result = asr.transcribe("/tmp/clip.wav", word_timestamps=False)
    assert result["language"] == "en"
    assert result["segments"][0]["text"] == "echo:/tmp/clip.wav"


def test_two_calls_reuse_one_sidecar(asr):
    asr.transcribe("/a.wav")
    proc1 = asr._proc.pid
    asr.transcribe("/b.wav")
    assert asr._proc.pid == proc1  # long-lived sidecar, not respawned per call


def test_crash_mid_transcribe_fails_then_respawns(monkeypatch, asr):
    # The echo sidecar self-exits after one frame when this env is set —
    # simulating a CTranslate2 GPU-teardown segfault mid-transcription.
    monkeypatch.setenv("OMNIVOICE_ECHO_CRASH", "1")
    with pytest.raises(RuntimeError) as ei:
        # First frame handled (returns segments) then the child exits; the
        # crash surfaces on the FOLLOWING transcribe whose reply pipe is dead.
        asr.transcribe("/first.wav")
        asr.transcribe("/second.wav")
    msg = str(ei.value)
    assert "_echo_asr" in msg  # decorated with the engine id
    assert "device=" in msg

    # Backend is still healthy: a fresh call (crash hook now off) respawns.
    monkeypatch.delenv("OMNIVOICE_ECHO_CRASH", raising=False)
    result = asr.transcribe("/after.wav")
    assert result["segments"][0]["text"] == "echo:/after.wav"


def test_registry_exposes_isolated_backend():
    # The lazy registry lists + resolves the crash-isolated backend.
    from services import asr_backend
    assert "faster-whisper-isolated" in asr_backend._REGISTRY
    cls = asr_backend._REGISTRY["faster-whisper-isolated"]
    assert cls.id == "faster-whisper-isolated"
    ok, msg = cls.is_available()
    assert isinstance(ok, bool)  # available iff faster-whisper installed + script present


def test_generate_is_not_supported(asr):
    with pytest.raises(NotImplementedError):
        asr.generate("text")
