"""assign_speakers_from_turns — inline-ASR diarization (FunASR cam++, #182 Phase 2)."""
from services.segmentation import assign_speakers_from_turns


def test_overlap_winner():
    segs = [{"start": 0.0, "end": 2.0}, {"start": 2.0, "end": 4.0}]
    turns = [
        {"start": 0.0, "end": 2.1, "speaker": "Speaker 1"},
        {"start": 2.1, "end": 4.0, "speaker": "Speaker 2"},
    ]
    out = assign_speakers_from_turns(segs, turns)
    assert out[0]["speaker_id"] == "Speaker 1"   # 2.0s overlap vs 0
    assert out[1]["speaker_id"] == "Speaker 2"   # 1.9s overlap vs 0.1


def test_assigns_from_containing_turn():
    segs = [{"start": 5.0, "end": 6.0}]
    turns = [{"start": 4.0, "end": 7.0, "speaker": "Speaker 3"}]
    assert assign_speakers_from_turns(segs, turns)[0]["speaker_id"] == "Speaker 3"


def test_drops_malformed_turns():
    segs = [{"start": 0.0, "end": 1.0}]
    turns = [{"start": 0.0, "end": 1.0}, {"speaker": "X"}, {"start": 0.0, "end": 1.0, "speaker": "Speaker 2"}]
    assert assign_speakers_from_turns(segs, turns)[0]["speaker_id"] == "Speaker 2"


def test_empty_turns_falls_back_to_heuristic():
    # >1.2s gap → the silence-gap heuristic alternates speakers.
    segs = [{"start": 0.0, "end": 1.0}, {"start": 5.0, "end": 6.0}]
    out = assign_speakers_from_turns(segs, [])
    assert out[0]["speaker_id"] == "Speaker 1"
    assert out[1]["speaker_id"] == "Speaker 2"
