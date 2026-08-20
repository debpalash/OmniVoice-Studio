"""Regression coverage for conservative phrase-level speaker recovery."""

from __future__ import annotations

import importlib

import numpy as np


PHRASES = [
    {"start": 0.0, "end": 1.0, "text": "first speaker one"},
    {"start": 1.0, "end": 2.0, "text": "second speaker one"},
    {"start": 2.0, "end": 3.0, "text": "first speaker two"},
    {"start": 3.0, "end": 4.0, "text": "second speaker two"},
]
SEGMENTS = [
    {"id": str(index), "start": phrase["start"], "end": phrase["end"],
     "text": phrase["text"], "speaker_id": "Speaker 1"}
    for index, phrase in enumerate(PHRASES)
]


class _Audio:
    def __init__(self):
        self.crops = []

    def crop(self, target, segment, *, duration, mode):
        self.crops.append((target, segment.start, segment.end, duration, mode))
        return np.zeros((1, 16), dtype=np.float32), 16_000


class _Pipeline:
    def __init__(self, vectors):
        self._audio = _Audio()
        iterator = iter(vectors)
        self._embedding = lambda _waveform: next(iterator)


def _recover(pipeline, *, diarized=None, requested=None):
    recover = importlib.import_module(
        "api.routers.dub_core"
    )._recover_from_phrase_embeddings
    return recover(
        pipeline,
        [dict(item) for item in (diarized or SEGMENTS)],
        phrases=PHRASES,
        requested_speakers=requested,
        audio_target="recording.wav",
        segments=[dict(item) for item in SEGMENTS],
        words=[],
    )


def test_distinct_balanced_phrase_embeddings_recover_two_speakers():
    pipeline = _Pipeline([
        [1.0, 0.0], [0.0, 1.0], [0.99, 0.01], [0.01, 0.99],
    ])

    recovered, separation = _recover(pipeline)

    assert separation > 0.9
    assert [item[1:4] for item in pipeline._audio.crops] == [
        (0.0, 1.0, 1.0), (1.0, 2.0, 1.0),
        (2.0, 3.0, 1.0), (3.0, 4.0, 1.0),
    ]
    assert {item["speaker_id"] for item in recovered} == {"Speaker 1", "Speaker 2"}


def test_existing_multi_speaker_result_is_never_reclustered():
    pipeline = _Pipeline([])
    diarized = [dict(item) for item in SEGMENTS]
    diarized[1]["speaker_id"] = "Speaker 2"

    assert _recover(pipeline, diarized=diarized) is None
    assert pipeline._audio.crops == []


def test_explicit_non_two_speaker_request_is_never_reclustered():
    pipeline = _Pipeline([])

    assert _recover(pipeline, requested=3) is None
    assert pipeline._audio.crops == []


def test_rejected_assignment_does_not_mutate_original_segments():
    pipeline = _Pipeline([
        [1.0, 0.0], [0.0, 1.0], [0.99, 0.01], [0.01, 0.99],
    ])
    original = [{
        "id": "merged", "start": 0.0, "end": 4.0,
        "text": "one merged segment", "speaker_id": "Speaker 1",
    }]

    recover = importlib.import_module(
        "api.routers.dub_core"
    )._recover_from_phrase_embeddings
    result = recover(
        pipeline,
        [dict(item) for item in original],
        phrases=PHRASES,
        requested_speakers=None,
        audio_target="recording.wav",
        segments=original,
        words=[],
    )

    assert result is None
    assert original[0]["speaker_id"] == "Speaker 1"
