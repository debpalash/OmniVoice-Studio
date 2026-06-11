"""Tests for speech-onset alignment (#280, item 1).

Whisper-family ASR often stretches the first segment's start back over
leading music/silence (speech at 0:03, transcript says 0.0 → the dub
plays 3 s early). `services.onset_align.snap_segment_starts` post-snaps
segment starts forward to the first speech-like frame in the audio.

All tests use synthetic audio — pure NumPy, no models, no platform code.
"""
from __future__ import annotations

import numpy as np
import pytest

from services.onset_align import (
    MIN_SEG_DUR_S,
    PRE_ROLL_S,
    detect_speech_onset,
    detect_speech_onsets,
    snap_segment_starts,
)

SR = 16000


def _tone(duration_s: float, sr: int = SR, freq: float = 220.0, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(duration_s * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _silence(duration_s: float, sr: int = SR) -> np.ndarray:
    return np.zeros(int(duration_s * sr), dtype=np.float32)


def _speech_after_silence(lead_s: float, speech_s: float = 2.0) -> np.ndarray:
    """`lead_s` of silence, then `speech_s` of loud tone."""
    return np.concatenate([_silence(lead_s), _tone(speech_s)])


# ── detect_speech_onset ─────────────────────────────────────────────────────


def test_detect_onset_finds_speech_after_leading_silence():
    audio = _speech_after_silence(2.5)
    onset = detect_speech_onset(audio, SR, 0.0, 4.5)
    assert onset == pytest.approx(2.5, abs=0.06)


def test_detect_onset_silent_window_returns_none():
    audio = _silence(3.0)
    assert detect_speech_onset(audio, SR, 0.0, 3.0) is None


def test_detect_onset_empty_or_invalid_window():
    audio = _tone(1.0)
    assert detect_speech_onset(audio, SR, 2.0, 1.0) is None   # end < start
    assert detect_speech_onset(audio, SR, 5.0, 6.0) is None   # past audio end
    assert detect_speech_onset(audio, 0, 0.0, 1.0) is None    # bad sr


# ── snap_segment_starts ─────────────────────────────────────────────────────


def test_snap_shifts_first_segment_to_speech_onset():
    """The issue-280 case: speech starts at 3.0 s but the transcript's first
    segment claims start=0.0 — the dub then plays 3 s early."""
    audio = _speech_after_silence(3.0, speech_s=3.0)
    segs = [{"start": 0.0, "end": 6.0, "text": "It's a nice day today"}]
    n = snap_segment_starts(segs, audio, SR)
    assert n == 1
    # Snapped to just before the onset (pre-roll keeps breaths/plosives).
    assert segs[0]["start"] == pytest.approx(3.0 - PRE_ROLL_S, abs=0.08)
    assert segs[0]["end"] == 6.0  # ends are untouched


def test_snap_never_moves_start_backward():
    # Segment starts mid-speech: onset is at/before seg start → no change.
    audio = _speech_after_silence(1.0, speech_s=5.0)
    segs = [{"start": 2.0, "end": 5.5, "text": "x"}]
    n = snap_segment_starts(segs, audio, SR)
    assert n == 0
    assert segs[0]["start"] == 2.0


def test_snap_ignores_sub_threshold_shift():
    # Speech begins 0.1 s into the segment — below MIN_SHIFT_S, leave alone.
    audio = _speech_after_silence(1.1, speech_s=3.0)
    segs = [{"start": 1.0, "end": 4.0, "text": "x"}]
    n = snap_segment_starts(segs, audio, SR)
    assert n == 0
    assert segs[0]["start"] == 1.0


def test_snap_skips_silent_segment():
    audio = _silence(5.0)
    segs = [{"start": 0.5, "end": 4.0, "text": "x"}]
    assert snap_segment_starts(segs, audio, SR) == 0
    assert segs[0]["start"] == 0.5


def test_snap_preserves_minimum_duration():
    # Onset is very late in the slot: shift is capped so the segment keeps
    # at least MIN_SEG_DUR_S of audio.
    audio = np.concatenate([_silence(3.8), _tone(0.4)])
    segs = [{"start": 0.0, "end": 4.0, "text": "x"}]
    n = snap_segment_starts(segs, audio, SR)
    assert n == 1
    assert segs[0]["start"] <= 4.0 - MIN_SEG_DUR_S + 1e-6
    assert segs[0]["end"] - segs[0]["start"] >= MIN_SEG_DUR_S - 1e-6


def test_snap_skips_too_short_segments():
    audio = _speech_after_silence(0.2, speech_s=0.4)
    segs = [{"start": 0.0, "end": 0.3, "text": "x"}]
    assert snap_segment_starts(segs, audio, SR) == 0


def test_snap_handles_multiple_segments_independently():
    # seg A: 2 s silence then speech; seg B: speech immediately.
    audio = np.concatenate([
        _silence(2.0), _tone(2.0),   # 0–4 s   (speech at 2.0)
        _tone(3.0),                  # 4–7 s   (speech immediately)
    ])
    segs = [
        {"start": 0.0, "end": 4.0, "text": "a"},
        {"start": 4.0, "end": 7.0, "text": "b"},
    ]
    n = snap_segment_starts(segs, audio, SR)
    assert n == 1
    assert segs[0]["start"] == pytest.approx(2.0 - PRE_ROLL_S, abs=0.08)
    assert segs[1]["start"] == 4.0


def test_snap_accepts_stereo_audio():
    mono = _speech_after_silence(2.0, speech_s=2.0)
    stereo = np.stack([mono, mono], axis=1)
    segs = [{"start": 0.0, "end": 4.0, "text": "x"}]
    assert snap_segment_starts(segs, stereo, SR) == 1
    assert segs[0]["start"] == pytest.approx(2.0 - PRE_ROLL_S, abs=0.08)


def test_snap_no_audio_is_noop():
    segs = [{"start": 0.0, "end": 4.0, "text": "x"}]
    assert snap_segment_starts(segs, np.zeros(0, dtype=np.float32), SR) == 0
    assert snap_segment_starts(segs, None, SR) == 0
    assert segs[0]["start"] == 0.0


def test_snap_tolerates_malformed_segment_entries():
    audio = _speech_after_silence(2.0)
    segs = [
        {"start": "bogus", "end": 4.0},
        {"end": 4.0},  # missing start → defaults to 0.0, still valid
        {"start": 0.0, "end": 4.0, "text": "ok"},
    ]
    # Must not raise; the well-formed entries still get processed.
    n = snap_segment_starts(segs, audio, SR)
    assert n >= 1
    assert segs[2]["start"] == pytest.approx(2.0 - PRE_ROLL_S, abs=0.08)


# ── detect_speech_onsets (full-track, #280 item 3) ──────────────────────────


def test_onsets_silence_returns_empty():
    assert detect_speech_onsets(_silence(3.0), SR) == []


def test_onsets_empty_or_invalid_audio():
    assert detect_speech_onsets(np.zeros(0, dtype=np.float32), SR) == []
    assert detect_speech_onsets(_tone(1.0), 0) == []


def test_onsets_two_bursts_yield_two_onsets():
    # 1 s silence, 1 s tone, 1 s silence, 1 s tone — exactly two rises.
    audio = np.concatenate([_silence(1.0), _tone(1.0), _silence(1.0), _tone(1.0)])
    onsets = detect_speech_onsets(audio, SR)
    assert len(onsets) == 2
    assert onsets[0] == pytest.approx(1.0, abs=0.06)
    assert onsets[1] == pytest.approx(3.0, abs=0.06)


def test_onsets_speech_at_t0_registers():
    audio = np.concatenate([_tone(1.0), _silence(2.0)])
    onsets = detect_speech_onsets(audio, SR)
    assert len(onsets) == 1
    assert onsets[0] == pytest.approx(0.0, abs=0.06)


def test_onsets_hysteresis_ignores_short_dip():
    # A 60 ms dip inside a burst (< MIN_ONSET_GAP_S of 150 ms below the
    # threshold) must NOT register a second onset.
    audio = np.concatenate([
        _silence(1.0), _tone(0.5), _silence(0.06), _tone(0.5),
    ])
    onsets = detect_speech_onsets(audio, SR)
    assert len(onsets) == 1
    assert onsets[0] == pytest.approx(1.0, abs=0.06)


def test_onsets_hysteresis_long_gap_registers_new_onset():
    # A 400 ms gap (> MIN_ONSET_GAP_S) re-arms the detector.
    audio = np.concatenate([
        _silence(1.0), _tone(0.5), _silence(0.4), _tone(0.5),
    ])
    onsets = detect_speech_onsets(audio, SR)
    assert len(onsets) == 2
    assert onsets[1] == pytest.approx(1.9, abs=0.06)


def test_onsets_stereo_audio_accepted():
    mono = np.concatenate([_silence(1.0), _tone(1.0)])
    stereo = np.stack([mono, mono], axis=1)
    onsets = detect_speech_onsets(stereo, SR)
    assert len(onsets) == 1
    assert onsets[0] == pytest.approx(1.0, abs=0.06)


def test_onsets_sorted_ascending():
    audio = np.concatenate(
        [_silence(0.5), _tone(0.3)] * 4
    )
    onsets = detect_speech_onsets(audio, SR)
    assert onsets == sorted(onsets)
    assert len(onsets) == 4
