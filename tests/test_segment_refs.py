"""Per-segment clone references (Wave 3.2 / Spec 4).

Pure tests over a synthetic vocals wav — no model, no main import.
"""
import os

import numpy as np
import pytest
import soundfile as sf

from services import speaker_clone
from services.speaker_clone import (
    MIN_SEGMENT_REF_DURATION_S,
    extract_segment_refs,
)

SR = 16000


@pytest.fixture
def vocals(tmp_path):
    # 20 s of non-silent audio so every segment slice has content.
    path = tmp_path / "vocals.wav"
    sf.write(str(path), np.float32(np.sin(np.linspace(0, 6000, 20 * SR))), SR)
    return str(path)


def test_long_segments_get_their_own_ref(tmp_path, vocals):
    segs = [
        {"start": 0.0, "end": 4.0, "text": "primera linea", "text_original": "first line"},
        {"start": 5.0, "end": 9.5, "text": "segunda", "text_original": "second line"},
    ]
    out = extract_segment_refs(vocals, segs, str(tmp_path), seg_ids=["a", "b"])
    assert set(out) == {"a", "b"}
    assert os.path.exists(out["a"]["ref_audio"])
    # Reference transcript is the SOURCE text, not the translation.
    assert out["a"]["ref_text"] == "first line"
    assert out["a"]["duration"] == pytest.approx(4.0, abs=0.05)
    assert out["b"]["duration"] == pytest.approx(4.5, abs=0.05)


def test_short_segment_is_omitted_for_fallback(tmp_path, vocals):
    segs = [
        {"start": 0.0, "end": 1.5, "text": "x", "text_original": "short"},   # < 3.0 floor
        {"start": 2.0, "end": 6.0, "text": "y", "text_original": "long enough"},
    ]
    out = extract_segment_refs(vocals, segs, str(tmp_path), seg_ids=["s", "l"])
    assert "s" not in out  # too short → caller falls back to per-speaker ref
    assert "l" in out


def test_default_seg_ids_when_unspecified(tmp_path, vocals):
    segs = [{"start": 0.0, "end": 4.0, "text": "a", "text_original": "a"}]
    out = extract_segment_refs(vocals, segs, str(tmp_path))
    assert "seg_0" in out


def test_text_falls_back_to_translation_without_original(tmp_path, vocals):
    segs = [{"start": 0.0, "end": 4.0, "text": "only translated"}]
    out = extract_segment_refs(vocals, segs, str(tmp_path), seg_ids=["k"])
    assert out["k"]["ref_text"] == "only translated"


def test_clip_clamped_to_audio_bounds(tmp_path, vocals):
    # end beyond the 20 s file → clamped, still produced.
    segs = [{"start": 18.0, "end": 25.0, "text": "t", "text_original": "tail"}]
    out = extract_segment_refs(vocals, segs, str(tmp_path), seg_ids=["t"])
    assert out["t"]["duration"] == pytest.approx(2.0, abs=0.05)  # 18→20


def test_missing_vocals_returns_empty(tmp_path):
    assert extract_segment_refs("/no/such.wav", [{"start": 0, "end": 5}], str(tmp_path)) == {}
    assert extract_segment_refs("", [], str(tmp_path)) == {}


def test_floor_boundary(tmp_path, vocals):
    # exactly at the floor is kept; just under is dropped.
    segs = [
        {"start": 0.0, "end": MIN_SEGMENT_REF_DURATION_S, "text_original": "at floor"},
        {"start": 6.0, "end": 6.0 + MIN_SEGMENT_REF_DURATION_S - 0.1, "text_original": "under"},
    ]
    out = extract_segment_refs(vocals, segs, str(tmp_path), seg_ids=["at", "under"])
    assert "at" in out and "under" not in out
