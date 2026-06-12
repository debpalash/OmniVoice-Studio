"""Capture-WS AEC framing helpers (parity Action 8b).

Unit-tests the pure helpers the ``/ws/transcribe`` AEC path relies on — frame
demux and PCM→WAV muxing — without standing up the WebSocket or the ASR stack
(which pulls torch and segfaults on some dev boxes). The wire integration is
covered indirectly: these are the only AEC-specific branches in the handler.
"""
from __future__ import annotations

import os
import wave

from api.routers.capture_ws import (
    _AEC_FAR,
    _AEC_NEAR,
    _demux_aec_frame,
    _pcm16_to_wav,
)


def test_demux_near_frame():
    kind, payload = _demux_aec_frame(bytes([_AEC_NEAR]) + b"abcd")
    assert kind == "near"
    assert payload == b"abcd"


def test_demux_far_frame():
    kind, payload = _demux_aec_frame(bytes([_AEC_FAR]) + b"xyz")
    assert kind == "far"
    assert payload == b"xyz"


def test_demux_empty_frame():
    assert _demux_aec_frame(b"") == ("near", b"")


def test_demux_prefix_only_frame():
    # A bare far-tag with no payload is valid (kind set, payload empty).
    assert _demux_aec_frame(bytes([_AEC_FAR])) == ("far", b"")


def test_demux_unknown_prefix_degrades_to_near():
    # Any non-0x01 tag is treated as mic audio so a bad tag never drops audio.
    kind, payload = _demux_aec_frame(b"\x07hello")
    assert kind == "near"
    assert payload == b"hello"


def test_pcm16_to_wav_roundtrip():
    pcm = (b"\x01\x02" * 2000)  # 2000 int16 samples
    path = _pcm16_to_wav(pcm, 16000)
    assert path is not None
    try:
        with wave.open(path, "rb") as wf:
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2
            assert wf.getframerate() == 16000
            assert wf.readframes(wf.getnframes()) == pcm
    finally:
        os.unlink(path)


def test_pcm16_to_wav_rejects_tiny_buffer():
    assert _pcm16_to_wav(b"\x00\x01", 16000) is None
    assert _pcm16_to_wav(b"", 16000) is None
