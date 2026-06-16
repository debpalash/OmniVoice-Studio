"""Regression tests for #479 — WhisperX transcription must decode audio through
OmniVoice's *validated* ffmpeg, never whisperx.load_audio's bare ``"ffmpeg"``
PATH lookup (which yields ``[WinError 193] -> "no segments"`` on Windows).

These are pure unit tests — no real ffmpeg or whisperx needed — so they run
identically on macOS/Windows/Linux in CI. Placed at top-level ``tests/`` (not
``tests/backend/``) to avoid the sys.modules-isolation collection-order leak.

NOTE: modules are imported at *test runtime* and find_ffmpeg is patched by its
dotted string path, so the patch and the helper's lazy
``from services.ffmpeg_utils import find_ffmpeg`` always resolve the SAME
sys.modules entry even after another test purges ``services.*``.
"""
from __future__ import annotations

import subprocess
import types

import pytest


def _decode():
    import services.asr_backend as asr
    return asr._decode_audio_16k_mono


def test_decode_raises_actionable_error_when_no_ffmpeg(monkeypatch):
    """find_ffmpeg() -> None must raise a clear, actionable error (with the
    locale-independent WinError 193 hint), not silently yield empty audio."""
    monkeypatch.setattr("services.ffmpeg_utils.find_ffmpeg", lambda: None)
    with pytest.raises(RuntimeError) as ei:
        _decode()("/tmp/whatever.wav")
    msg = str(ei.value)
    assert "ffmpeg" in msg.lower()
    assert "WinError 193" in msg  # matched on the code, not the OS-translated text


def test_decode_uses_validated_binary_and_returns_float32(monkeypatch):
    """The decode must invoke the *validated* binary path (not a bare
    ``"ffmpeg"``) with whisperx's exact 16 kHz/mono/s16le args, and return a
    float32 waveform."""
    import numpy as np

    captured = {}
    monkeypatch.setattr("services.ffmpeg_utils.find_ffmpeg", lambda: "/opt/validated/ffmpeg")
    pcm = np.array([0, 16384, -32768, 32767], dtype=np.int16).tobytes()

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        assert kwargs.get("check") is True
        return types.SimpleNamespace(stdout=pcm, stderr=b"")

    monkeypatch.setattr(subprocess, "run", fake_run)

    out = _decode()("/tmp/in.mp4")
    cmd = captured["cmd"]
    assert cmd[0] == "/opt/validated/ffmpeg"          # validated binary, NOT bare "ffmpeg"
    assert "/tmp/in.mp4" in cmd
    for token in ("16000", "s16le", "pcm_s16le", "-ac", "1"):
        assert token in cmd
    assert out.dtype == np.float32
    assert len(out) == 4
    assert out[0] == pytest.approx(0.0)
    assert out[2] == pytest.approx(-1.0)              # -32768 / 32768.0


def test_winerror193_at_decode_becomes_clear_runtimeerror(monkeypatch):
    """If the validated binary still fails to spawn (OSError/WinError 193), it
    must surface as a clear RuntimeError, not propagate as the opaque
    'no segments' the dub path would otherwise show."""
    monkeypatch.setattr("services.ffmpeg_utils.find_ffmpeg", lambda: "/opt/validated/ffmpeg")

    def boom(cmd, **kwargs):
        raise OSError("[WinError 193] %1 is not a valid Win32 application")

    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(RuntimeError) as ei:
        _decode()("/tmp/in.mp4")
    assert "could not be executed" in str(ei.value)
