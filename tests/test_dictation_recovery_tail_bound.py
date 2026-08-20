"""Silent-model recovery audio must be bounded (#1610 review).

Both dictation WebSocket paths retained every PCM byte of a session so the
silent-model fallback could re-transcribe it. Nothing capped that: an open mic
at 16 kHz mono int16 added ~115 MB per hour, held for the life of the session
and only ever read when the fallback actually fired. Streaming and offline
both did it.

The tail is what matters — recovery re-transcribes what the user just said —
while the silent-model gate measures how much audio the session carried, so
the true total is tracked separately and stays truthful after trimming.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def ws():
    return importlib.import_module("api.routers.capture_ws")


SR = 16000
BYTES_PER_S = SR * 2


def test_a_long_session_stops_growing(ws):
    tail = ws.RecoveryTail(SR, seconds=2.0)
    for _ in range(600):  # 60 s of 100 ms frames
        tail.extend(b"\x01\x02" * (SR // 10))
    assert len(tail.tail()) == 2 * BYTES_PER_S


def test_the_true_total_survives_trimming(ws):
    """is_model_silent gates on how much audio the session carried; capping
    the buffer must not make a long session look too short to be recoverable."""
    tail = ws.RecoveryTail(SR, seconds=1.0)
    for _ in range(30):
        tail.extend(b"\x00\x01" * SR)  # 1 s each
    assert tail.total_bytes == 30 * BYTES_PER_S
    assert len(tail.tail()) == BYTES_PER_S
    assert ws.is_model_silent("", True, tail.total_bytes) is True


def test_the_retained_audio_is_the_most_recent(ws):
    """Head-trimming, not head-keeping — the useful speech is the latest."""
    tail = ws.RecoveryTail(SR, seconds=1.0)
    tail.extend(b"\xaa\xaa" * SR)   # older
    tail.extend(b"\xbb\xbb" * SR)   # newer
    assert tail.tail() == b"\xbb\xbb" * SR


def test_a_short_session_is_kept_whole(ws):
    tail = ws.RecoveryTail(SR, seconds=120.0)
    tail.extend(b"\x01\x02" * SR)
    assert tail.tail() == b"\x01\x02" * SR
    assert tail.total_bytes == BYTES_PER_S


@pytest.mark.parametrize("sample_rate,seconds", [(0, 120.0), (16000, 0.0), (-1, -1.0)])
def test_a_nonsense_bound_still_yields_a_usable_buffer(ws, sample_rate, seconds):
    """A bad sr query param or env override must not produce a zero-length
    buffer that silently disables recovery."""
    tail = ws.RecoveryTail(sample_rate, seconds=seconds)
    tail.extend(b"\x01\x02" * 100)
    assert len(tail.tail()) >= 2


def test_both_socket_paths_use_the_bounded_buffer(ws):
    """Structural: the streaming path and the offline path both had the leak,
    so a fix applied to only one of them is not a fix."""
    import inspect

    src = inspect.getsource(ws)
    assert src.count("RecoveryTail(pcm_sr)") == 2
    assert "session_pcm = bytearray()" not in src
