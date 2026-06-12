"""NLMS echo canceller (parity Action 8b).

Validates the ported ``NlmsEchoCanceller`` against synthetic far-end +
echo-contaminated near-end signals: the steady-state echo must attenuate, the
user's own speech (double-talk) must survive, and cold/stale references must
pass through untouched. Pure-numpy — no torch, no ASR stack.
"""
from __future__ import annotations

import numpy as np
import pytest

from services.aec import NlmsEchoCanceller

SR = 16000
FRAME = 320  # 20 ms @ 16 kHz


def _pcm(x: np.ndarray) -> bytes:
    """float32 [-1, 1] → int16 LE PCM bytes."""
    return np.clip(x * 32768.0, -32768.0, 32767.0).astype(np.int16).tobytes()


def _f32(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x ** 2))) if x.size else 0.0


def _tone(freq: float, n: int, *, amp: float = 0.5, phase: float = 0.0) -> np.ndarray:
    t = np.arange(n, dtype=np.float32) / SR
    return amp * np.sin(2 * np.pi * freq * t + phase).astype(np.float32)


# ── Construction / validation ────────────────────────────────────────────────

def test_rejects_unsupported_sample_rate():
    with pytest.raises(ValueError):
        NlmsEchoCanceller(sample_rate=44100)


@pytest.mark.parametrize("kw", [
    {"filter_taps": 32},
    {"step_size": 0},
    {"step_size": 1.5},
    {"warmup_step_size": 0},
    {"leakage": 0},
    {"leakage": 2},
    {"warmup_seconds": -1},
])
def test_rejects_bad_params(kw):
    with pytest.raises(ValueError):
        NlmsEchoCanceller(sample_rate=SR, **kw)


# ── Pass-through guards ──────────────────────────────────────────────────────

def test_passthrough_before_any_far_end():
    """No playback primed → mic returns byte-identical."""
    aec = NlmsEchoCanceller(sample_rate=SR)
    mic = _pcm(_tone(300, FRAME))
    assert aec.process_near_end(mic) == mic


def test_passthrough_when_far_end_stale(monkeypatch):
    """Far reference older than the staleness window → no cancellation."""
    aec = NlmsEchoCanceller(sample_rate=SR)
    clock = {"t": 1000.0}
    monkeypatch.setattr("services.aec.time.monotonic", lambda: clock["t"])
    # Prime far-end so the ring is full, then let the clock jump forward.
    for _ in range(4):
        aec.push_far_end(_pcm(_tone(440, FRAME)))
    clock["t"] += 1.0  # > _FAR_STALE_S (0.25 s)
    mic = _pcm(_tone(300, FRAME))
    assert aec.process_near_end(mic) == mic


def test_empty_frames_are_noops():
    aec = NlmsEchoCanceller(sample_rate=SR)
    aec.push_far_end(b"")
    assert aec.process_near_end(b"") == b""


# ── Core behaviour ───────────────────────────────────────────────────────────

def test_attenuates_steady_state_echo(monkeypatch):
    """With the mic carrying a scaled, delayed copy of the playback signal and
    no local speech, the residual after convergence is far quieter than the
    echo it removed."""
    aec = NlmsEchoCanceller(sample_rate=SR)
    clock = {"t": 0.0}
    monkeypatch.setattr("services.aec.time.monotonic", lambda: clock["t"])

    echo_gain = 0.6
    delay = 80  # samples (5 ms) — within the 512-tap window
    prev_tail = np.zeros(delay, dtype=np.float32)

    residual_rms = []
    for k in range(200):
        clock["t"] += FRAME / SR
        far = _tone(500, FRAME, amp=0.5, phase=k)  # vary phase so it's not periodic-identical
        # Echo = delayed, attenuated far-end (mic hears only the echo here).
        src = np.concatenate((prev_tail, far))
        echo = echo_gain * src[:FRAME]
        prev_tail = far[-delay:]

        aec.push_far_end(_pcm(far))
        out = _f32(aec.process_near_end(_pcm(echo)))
        residual_rms.append(_rms(out))

    early = np.mean(residual_rms[5:15])   # just after warm-up starts
    late = np.mean(residual_rms[-20:])    # converged
    assert late < early                    # it is learning the echo path
    assert late < 0.10 * echo_gain * 0.5   # residual well below the echo level


def test_double_talk_preserves_user_speech(monkeypatch):
    """When the user speaks over playback, the Geigel detector freezes
    adaptation so the user's voice is not modelled as echo and survives."""
    aec = NlmsEchoCanceller(sample_rate=SR)
    clock = {"t": 0.0}
    monkeypatch.setattr("services.aec.time.monotonic", lambda: clock["t"])

    # Converge the filter on echo-only frames first.
    echo_gain = 0.5
    for k in range(60):
        clock["t"] += FRAME / SR
        far = _tone(500, FRAME, amp=0.5, phase=k)
        aec.push_far_end(_pcm(far))
        aec.process_near_end(_pcm(echo_gain * far))

    # Now the user talks (distinct frequency, loud) over the same playback.
    user = _tone(180, FRAME, amp=0.6)
    clock["t"] += FRAME / SR
    far = _tone(500, FRAME, amp=0.5, phase=999)
    aec.push_far_end(_pcm(far))
    out = _f32(aec.process_near_end(_pcm(echo_gain * far + user)))

    assert aec.double_talk_frames >= 1       # detector fired
    assert _rms(out) > 0.5 * _rms(user)      # user energy is largely retained


def test_reset_clears_state(monkeypatch):
    aec = NlmsEchoCanceller(sample_rate=SR)
    clock = {"t": 0.0}
    monkeypatch.setattr("services.aec.time.monotonic", lambda: clock["t"])
    for k in range(10):
        clock["t"] += FRAME / SR
        aec.push_far_end(_pcm(_tone(440, FRAME, phase=k)))
        aec.process_near_end(_pcm(_tone(300, FRAME)))
    aec.reset()
    assert aec.frames_processed == 0
    assert aec._far_filled == 0
    assert not np.any(aec._w)
    # After reset, a cold mic frame passes straight through again.
    mic = _pcm(_tone(300, FRAME))
    assert aec.process_near_end(mic) == mic
