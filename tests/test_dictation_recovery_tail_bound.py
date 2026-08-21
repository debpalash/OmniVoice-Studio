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


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, 120.0), ("bad", 120.0), ("nan", 120.0), ("inf", 120.0),
        ("-1", 120.0), ("0", 120.0), ("60", 60.0), ("999999", 300.0),
    ],
)
def test_recovery_tail_environment_override_is_finite_and_bounded(ws, value, expected):
    assert ws._bounded_recovery_tail_seconds(value) == expected


@pytest.mark.parametrize("sample_rate,seconds", [(0, 120.0), (16000, 0.0), (-1, -1.0)])
def test_a_nonsense_bound_still_yields_a_usable_buffer(ws, sample_rate, seconds):
    """A bad sr query param or env override must not produce a zero-length
    buffer that silently disables recovery."""
    tail = ws.RecoveryTail(sample_rate, seconds=seconds)
    tail.extend(b"\x01\x02" * 100)
    assert len(tail.tail()) >= 2


@pytest.mark.parametrize("sr", ["1000000000", "4000", "0", "-16000", "junk", ""])
def test_an_absurd_client_sample_rate_is_not_believed(ws, sr):
    """`?sr=` sizes RecoveryTail's byte ceiling (rate × RECOVERY_TAIL_SECONDS),
    so an unclamped client value re-opens the unbounded-memory path (#1610
    review). Out-of-range and garbage rates fall back to 16 kHz."""
    assert ws._bounded_sample_rate({"sr": sr}) == 16000


def test_supported_client_sample_rates_pass_through(ws):
    for sr in (8000, 16000, 44100, 48000, 96000):
        assert ws._bounded_sample_rate({"sr": str(sr)}) == sr


def test_the_sherpa_paths_use_the_bounded_rate(ws):
    """Structural: both sherpa handlers get their rate from _sherpa_session,
    which must parse via the clamped helper — a raw int() of the query param
    is exactly the bug."""
    import inspect

    src = inspect.getsource(ws._sherpa_session)
    assert "_bounded_sample_rate(" in src
    assert 'int(websocket.query_params.get("sr"' not in src


def test_both_socket_paths_use_the_bounded_buffer(ws):
    """Structural: the streaming path and the offline path both had the leak,
    so a fix applied to only one of them is not a fix."""
    import inspect

    src = inspect.getsource(ws)
    assert src.count("RecoveryTail(pcm_sr)") == 2
    assert "session_pcm = bytearray()" not in src


def test_trimming_never_splits_a_sample(ws):
    """int16 mono PCM: transport frames can carry odd byte counts (a sample
    split across two WebSocket messages), but the *stream* stays aligned — a
    sample starts at every even global offset. Trimming must remove an even
    number of bytes so the retained tail still starts on a sample boundary.

    The failure needs a stream that ends mid-sample (the session closed on a
    torn frame): with an odd total, an odd-trimming buffer ends with an odd
    cumulative removal, the tail starts mid-sample, and every decoded value
    is byte-shifted garbage. (An even total self-rebalances across trims,
    which is why the obvious version of this test cannot fail.)
    """
    import struct

    n = SR * 2  # 2 s of samples; sample k holds the value k
    stream = b"".join(struct.pack("<h", k % 32000) for k in range(n)) + b"\x7f"

    tail = ws.RecoveryTail(SR, seconds=1.0)
    # Odd-sized chunks so extend() boundaries never align with samples.
    i = 0
    for size in (1, 3331, 7777, 32001):
        tail.extend(stream[i:i + size])
        i += size
    tail.extend(stream[i:])

    kept = tail.tail()
    whole = kept[: (len(kept) // 2) * 2]  # the torn final byte is half a sample
    values = [v for (v,) in struct.iter_unpack("<h", whole)]
    # Sample-aligned ⟺ the decoded values are a contiguous ascending run; a
    # mid-sample start turns them into byte-shifted noise.
    assert values == list(range(values[0], values[0] + len(values))), values[:5]
    assert values[-1] == (n - 1) % 32000
