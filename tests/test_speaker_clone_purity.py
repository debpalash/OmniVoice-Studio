"""Clone-purity guards in services.speaker_clone (speaker-hint fix).

A per-speaker auto-clone reference cut from mislabeled or boundary-adjacent
audio mixes two people's voices — the field-reported "made up" clone voices.
These tests pin the three guards:

  * per-slice minimum duration (MIN_SLICE_DURATION_S),
  * non-adjacency scoring preference (ADJACENT_TURN_GUARD_S) — a preference,
    never a hard filter,
  * labels_source="heuristic" skips extraction entirely.

Pure tests over a synthetic vocals wav — no model, no main import.
"""
import numpy as np
import pytest
import soundfile as sf

from services.speaker_clone import (
    ADJACENT_TURN_GUARD_S,
    MIN_REF_DURATION_S,
    MIN_SLICE_DURATION_S,
    _pick_reference_slices,
    extract_speaker_clones,
)

SR = 16000


@pytest.fixture
def vocals(tmp_path):
    # 60 s of non-silent audio so every segment slice has content.
    path = tmp_path / "vocals.wav"
    sf.write(str(path), np.float32(np.sin(np.linspace(0, 18000, 60 * SR))), SR)
    return str(path)


def _seg(start, end, speaker="Speaker 1", text="hello there"):
    return {"start": start, "end": end, "speaker_id": speaker, "text": text}


class TestPickReferenceSlices:
    def test_rejects_slices_below_minimum_duration(self):
        # Six 1.0 s fragments total 6 s (> MIN_REF_DURATION_S) — pre-fix they
        # were all picked; now every one is under MIN_SLICE_DURATION_S so the
        # speaker yields no reference at all (default voice beats a bad clone).
        items = [(i, _seg(i * 3.0, i * 3.0 + 1.0)) for i in range(6)]
        assert MIN_SLICE_DURATION_S > 1.0  # test premise
        assert 6 * 1.0 > MIN_REF_DURATION_S  # pre-fix these WOULD have passed
        assert _pick_reference_slices(items) == []

    def test_prefers_slice_not_adjacent_to_other_speaker(self):
        # Two equal-length candidates for Speaker 1; the first is 0.1 s away
        # from a Speaker 2 turn (< ADJACENT_TURN_GUARD_S), the second is far
        # from everyone. The clean one must win the ranking.
        adjacent = _seg(0.0, 8.0, "Speaker 1")
        other = _seg(8.1, 10.0, "Speaker 2")
        clean = _seg(20.0, 28.0, "Speaker 1")
        all_segments = [adjacent, other, clean]
        items = [(0, adjacent), (2, clean)]
        chosen = _pick_reference_slices(
            items, speaker_id="Speaker 1", all_segments=all_segments,
        )
        assert [seg for _, seg in chosen] == [clean]

    def test_adjacency_is_a_preference_not_a_hard_filter(self):
        # Dense dialogue: every Speaker 1 slice borders a Speaker 2 turn.
        # Extraction must still succeed using the adjacent slices.
        s1a = _seg(0.0, 6.0, "Speaker 1")
        s2a = _seg(6.1, 8.0, "Speaker 2")
        s1b = _seg(8.2, 12.0, "Speaker 1")
        all_segments = [s1a, s2a, s1b]
        items = [(0, s1a), (2, s1b)]
        chosen = _pick_reference_slices(
            items, speaker_id="Speaker 1", all_segments=all_segments,
        )
        assert chosen, "dense dialogue must still produce a reference"

    def test_heuristic_labels_source_returns_nothing(self):
        items = [(0, _seg(0.0, 8.0))]
        assert _pick_reference_slices(items, labels_source="heuristic") == []

    def test_legacy_call_without_kwargs_still_picks_long_slice(self):
        # Backward compat: positional-only invocation (the pre-fix signature)
        # keeps working and picks the long slice.
        long_seg = _seg(0.0, 8.0)
        chosen = _pick_reference_slices([(0, long_seg)])
        assert [seg for _, seg in chosen] == [long_seg]

    def test_overlapping_other_speaker_counts_as_adjacent(self):
        # Negative gap (overlap) must also be flagged — that is the worst
        # mixed-audio case of all.
        overlapped = _seg(0.0, 8.0, "Speaker 1")
        other = _seg(4.0, 6.0, "Speaker 2")
        clean = _seg(20.0, 28.0, "Speaker 1")
        chosen = _pick_reference_slices(
            [(0, overlapped), (2, clean)],
            speaker_id="Speaker 1",
            all_segments=[overlapped, other, clean],
        )
        assert [seg for _, seg in chosen] == [clean]


class TestExtractSpeakerClones:
    def test_heuristic_labels_source_skips_extraction(self, tmp_path, vocals):
        segs = [_seg(0.0, 8.0), _seg(10.0, 18.0, "Speaker 2")]
        out = extract_speaker_clones(
            vocals, segs, str(tmp_path), labels_source="heuristic",
        )
        assert out == {}

    @pytest.mark.parametrize("source", [None, "pyannote", "turns"])
    def test_trusted_labels_still_extract(self, tmp_path, vocals, source):
        # None (legacy caller, missing kwarg) and real diarization sources
        # keep the current behavior: clones are produced.
        segs = [_seg(0.0, 8.0), _seg(10.0, 18.0, "Speaker 2")]
        kwargs = {} if source is None else {"labels_source": source}
        out = extract_speaker_clones(vocals, segs, str(tmp_path), **kwargs)
        assert set(out) == {"Speaker 1", "Speaker 2"}
        for info in out.values():
            assert info["duration"] >= MIN_REF_DURATION_S

    def test_adjacency_guard_constant_sane(self):
        # The guard must stay tighter than the heuristic's own gap threshold,
        # or every real turn boundary would be flagged.
        from services.segmentation import SPEAKER_GAP
        assert 0 < ADJACENT_TURN_GUARD_S < SPEAKER_GAP
