"""Second-pass ASR QC scoring (Wave 3.3 / Spec 5) — pure, no ASR/main import."""

import pytest

from services.dub_qc import score_dub, word_error_rate


# ── word_error_rate ──────────────────────────────────────────────────────────

def test_wer_identical_is_zero():
    assert word_error_rate("hello there world", "hello there world") == 0.0


def test_wer_case_and_punctuation_insensitive():
    assert word_error_rate("Hello, world!", "hello world") == 0.0


def test_wer_one_substitution():
    # 1 edit over 3 reference tokens.
    assert word_error_rate("the cat sat", "the dog sat") == pytest.approx(1 / 3)


def test_wer_empty_reference_with_hypothesis_is_one():
    assert word_error_rate("", "something") == 1.0


def test_wer_both_empty_is_zero():
    assert word_error_rate("", "") == 0.0


def test_wer_completely_different():
    assert word_error_rate("alpha beta", "x y z") >= 1.0


# ── score_dub ────────────────────────────────────────────────────────────────

def _seg(start, end, text, sid=None):
    d = {"start": start, "end": end, "text": text}
    if sid is not None:
        d["id"] = sid
    return d


def test_clean_dub_no_flags():
    dub = [_seg(0, 3, "hello world", "a"), _seg(3, 6, "good morning", "b")]
    recog = [_seg(0.1, 2.9, "hello world"), _seg(3.0, 5.8, "good morning")]
    out = score_dub(dub, recog)
    assert [q.flagged for q in out] == [False, False]
    assert out[0].seg_id == "a"
    assert all(q.drift == 0.0 for q in out)


def test_drifted_segment_is_flagged():
    dub = [_seg(0, 3, "the quarterly report is ready", "a")]
    # ASR heard something quite different (mispronunciation / bad clone).
    recog = [_seg(0, 3, "the quarter lee deport is read")]
    out = score_dub(dub, recog, drift_threshold=0.5)
    assert out[0].flagged is True
    assert out[0].recognized_text == "the quarter lee deport is read"


def test_measured_timing_from_recognition():
    dub = [_seg(0.0, 5.0, "hello", "a")]
    recog = [_seg(0.4, 1.2, "hello")]
    out = score_dub(dub, recog)
    assert out[0].new_start == pytest.approx(0.4)
    assert out[0].new_end == pytest.approx(1.2)


def test_segment_with_no_overlap_scores_full_drift():
    dub = [_seg(0, 3, "spoken line", "a")]
    recog = [_seg(10, 12, "elsewhere")]  # no time overlap
    out = score_dub(dub, recog)
    assert out[0].recognized_text == ""
    assert out[0].drift == 1.0 and out[0].flagged
    assert out[0].new_start is None


def test_multiple_recognized_segments_concatenate():
    dub = [_seg(0, 6, "one two three four", "a")]
    recog = [_seg(0, 3, "one two"), _seg(3, 6, "three four")]
    out = score_dub(dub, recog)
    assert out[0].recognized_text == "one two three four"
    assert out[0].drift == 0.0


def test_seg_ids_override():
    dub = [_seg(0, 3, "x")]
    out = score_dub(dub, [_seg(0, 3, "x")], seg_ids=["custom"])
    assert out[0].seg_id == "custom"
