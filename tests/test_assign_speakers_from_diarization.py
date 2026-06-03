"""`assign_speakers_from_diarization` overlap-weighting + label handling (#274).

When pyannote returns multiple speakers, each transcript segment must get the
speaker whose turns overlap it most — so a 2-speaker diarization yields two
distinct `Speaker N` ids, NOT a collapse to one. (The single-speaker collapse
users see comes from pyannote's *auto-detect*, which the new `num_speakers`
hint addresses; this test pins that the consumption side is correct.)
"""
from dataclasses import dataclass

from services.segmentation import assign_speakers_from_diarization


@dataclass
class _Turn:
    start: float
    end: float


class _FakeDiarization:
    """Mimics pyannote's `Annotation.itertracks(yield_label=True)`."""
    def __init__(self, turns):
        self._turns = turns  # list of (Turn, track_name, speaker_label)

    def itertracks(self, yield_label=False):
        for turn, track, spk in self._turns:
            yield (turn, track, spk) if yield_label else (turn, track)


def _segs(*spans):
    return [{"start": a, "end": b, "speaker_id": "Speaker 1"} for a, b in spans]


def test_two_speakers_yield_two_distinct_ids():
    # Speaker_0 owns 0–5s, Speaker_1 owns 5–10s.
    diar = _FakeDiarization([
        (_Turn(0.0, 5.0), "A", "SPEAKER_00"),
        (_Turn(5.0, 10.0), "B", "SPEAKER_01"),
    ])
    segs = _segs((0.5, 2.0), (6.0, 9.0))
    out = assign_speakers_from_diarization(segs, diar)
    assert out[0]["speaker_id"] == "Speaker 1"   # SPEAKER_00 -> idx 1
    assert out[1]["speaker_id"] == "Speaker 2"   # SPEAKER_01 -> idx 2
    assert out[0]["speaker_id"] != out[1]["speaker_id"]


def test_overlap_weighted_winner():
    # Segment 2–8 overlaps SPEAKER_00 for 3s (2–5) and SPEAKER_01 for 3s...
    # but SPEAKER_01 owns 5–9 so overlap is 3s each — tie broken by max(); make
    # SPEAKER_01 clearly dominant by extending its turn.
    diar = _FakeDiarization([
        (_Turn(0.0, 5.0), "A", "SPEAKER_00"),
        (_Turn(5.0, 12.0), "B", "SPEAKER_01"),
    ])
    out = assign_speakers_from_diarization(_segs((4.0, 11.0)), diar)
    # overlap: SPEAKER_00 = 1s (4–5), SPEAKER_01 = 6s (5–11) → winner SPEAKER_01
    assert out[0]["speaker_id"] == "Speaker 2"


def test_midpoint_fallback_when_no_overlap():
    # Segment sits fully inside a single turn; overlap path still catches it,
    # but a zero-length segment exercises the midpoint fallback.
    diar = _FakeDiarization([(_Turn(0.0, 10.0), "A", "SPEAKER_02")])
    out = assign_speakers_from_diarization([{"start": 3.0, "end": 3.0, "speaker_id": "Speaker 1"}], diar)
    assert out[0]["speaker_id"] == "Speaker 3"


def test_non_underscore_label_kept_verbatim():
    # A label that isn't `<prefix>_<int>` must not crash — kept as-is.
    diar = _FakeDiarization([(_Turn(0.0, 5.0), "A", "narrator")])
    out = assign_speakers_from_diarization(_segs((1.0, 2.0)), diar)
    assert out[0]["speaker_id"] == "narrator"


def test_empty_diarization_leaves_segment_untouched():
    # No turns → no winner → segment keeps whatever it had (heuristic fallback
    # upstream owns that case).
    diar = _FakeDiarization([])
    out = assign_speakers_from_diarization(_segs((1.0, 2.0)), diar)
    assert out[0]["speaker_id"] == "Speaker 1"
