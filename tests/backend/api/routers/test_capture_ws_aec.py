"""Capture-WS AEC framing helpers (parity Action 8b).

Unit-tests the pure helpers the ``/ws/transcribe`` AEC path relies on — frame
demux and PCM→WAV muxing — without standing up the WebSocket or the ASR stack
(which pulls torch and segfaults on some dev boxes). The wire integration is
covered indirectly: these are the only AEC-specific branches in the handler.
"""
from __future__ import annotations

import os
import wave

import pytest


@pytest.fixture
def capture_ws():
    from api.routers import capture_ws as module

    return module


def test_demux_near_frame(capture_ws):
    kind, payload = capture_ws._demux_aec_frame(bytes([capture_ws._AEC_NEAR]) + b"abcd")
    assert kind == "near"
    assert payload == b"abcd"


def test_demux_far_frame(capture_ws):
    kind, payload = capture_ws._demux_aec_frame(bytes([capture_ws._AEC_FAR]) + b"xyz")
    assert kind == "far"
    assert payload == b"xyz"


def test_demux_empty_frame(capture_ws):
    assert capture_ws._demux_aec_frame(b"") == ("near", b"")


def test_demux_prefix_only_frame(capture_ws):
    # A bare far-tag with no payload is valid (kind set, payload empty).
    assert capture_ws._demux_aec_frame(bytes([capture_ws._AEC_FAR])) == ("far", b"")


def test_demux_unknown_prefix_degrades_to_near(capture_ws):
    # Any non-0x01 tag is treated as mic audio so a bad tag never drops audio.
    kind, payload = capture_ws._demux_aec_frame(b"\x07hello")
    assert kind == "near"
    assert payload == b"hello"


def test_pcm16_to_wav_roundtrip(capture_ws):
    pcm = (b"\x01\x02" * 2000)  # 2000 int16 samples
    path = capture_ws._pcm16_to_wav(pcm, 16000)
    assert path is not None
    try:
        with wave.open(path, "rb") as wf:
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2
            assert wf.getframerate() == 16000
            assert wf.readframes(wf.getnframes()) == pcm
    finally:
        os.unlink(path)


def test_pcm16_to_wav_rejects_tiny_buffer(capture_ws):
    assert capture_ws._pcm16_to_wav(b"\x00\x01", 16000) is None
    assert capture_ws._pcm16_to_wav(b"", 16000) is None


def test_plain_pcm_transport_negotiates_a_bounded_sample_rate(capture_ws):
    requested = capture_ws._requested_pcm_sample_rate
    assert requested({}) is None
    assert requested({"pcm": "1", "sr": "48000"}) == 48000
    assert requested({"pcm": "true", "sr": "invalid"}) == 16000
    assert requested({"pcm": "on", "sr": "1000000"}) == 16000
    assert requested({"aec": "1", "sr": "8000"}) == 8000
