"""Issue #502 (partial) — the duration estimator must be Unicode-normalization
-form independent.

``RuleDurationEstimator`` weights combining marks (U+0300–036F, category Mn) at
0.0. Decomposed (NFD) text — a base letter followed by combining tone/diacritic
marks, the canonical on-disk form for Vietnamese and many diacritic scripts —
therefore mis-allocates frames versus the precomposed (NFC) form of the *same*
text, producing rushed/garbled audio for the affected syllables.

The fix NFC-normalizes at the estimator's text entry point
(``calculate_total_weight``), so NFC and NFD inputs always yield the *same*
estimate. These tests fail before the fix (NFD diverges) and pass after.
"""
import unicodedata

import pytest

from omnivoice.utils.duration import RuleDurationEstimator


def _raw_weight(est, text):
    """Pre-fix weighting: sum per-char weights WITHOUT NFC normalization.

    Calls the lru_cache-wrapped ``_get_char_weight`` via ``__wrapped__`` so the
    fix's normalization step is bypassed — this reproduces the *old*
    ``calculate_total_weight`` behavior to prove the bug existed.
    """
    return sum(est._get_char_weight.__wrapped__(est, c) for c in text)


# A single Korean Hangul syllable: precomposed (1 syllable block, weight 2.5)
# vs decomposed (lead/vowel/tail jamo). This is the clearest member of the
# normalization-divergence *class* — the bug is not Vietnamese-specific.
_KOREAN = "한"  # 한
# A Vietnamese phrase exercising stacked tone + vowel-quality marks — the
# issue's named script. Stays stable across forms once normalized.
_VIETNAMESE = "Tiếng Việt nặng hỏi ngã sắc huyền"


def test_combining_marks_weigh_zero():
    """Guards the precondition the bug rests on: combining marks contribute 0.0,
    so NFD text that splits a syllable into base+marks loses that weight."""
    est = RuleDurationEstimator()
    for cp in (0x0300, 0x0301, 0x0302, 0x0303, 0x0309, 0x0323):  # Vietnamese tone marks
        assert est._get_char_weight(chr(cp)) == 0.0


def test_nfd_diverges_from_nfc_before_normalization():
    """Fail-before guard: the OLD (un-normalized) weighting gives NFD a
    different weight than NFC, which is exactly the defect."""
    est = RuleDurationEstimator()
    nfc = unicodedata.normalize("NFC", _KOREAN)
    nfd = unicodedata.normalize("NFD", _KOREAN)
    assert nfc != nfd  # the syllable really does have distinct forms
    assert _raw_weight(est, nfc) != _raw_weight(est, nfd)


@pytest.mark.parametrize("sample", [_KOREAN, _VIETNAMESE, "한국어 문장입니다"])
def test_calculate_total_weight_is_normalization_independent(sample):
    """After the fix, NFC and NFD inputs weigh identically (the fix normalizes
    to NFC first). Non-zero, so the estimate stays meaningful."""
    est = RuleDurationEstimator()
    nfc = unicodedata.normalize("NFC", sample)
    nfd = unicodedata.normalize("NFD", sample)
    w_nfc = est.calculate_total_weight(nfc)
    w_nfd = est.calculate_total_weight(nfd)
    assert w_nfc == w_nfd
    assert w_nfc > 0


@pytest.mark.parametrize("sample", [_KOREAN, _VIETNAMESE])
def test_estimate_duration_is_normalization_independent(sample):
    """End-to-end: the public estimate is identical for NFC vs NFD input.

    Before the fix the Hangul case diverges ~3x (NFD over-counts as jamo);
    after the fix both forms produce the same, correct estimate."""
    est = RuleDurationEstimator()
    ref_text, ref_dur = "Hello, world.", 1.5
    nfc = unicodedata.normalize("NFC", sample)
    nfd = unicodedata.normalize("NFD", sample)
    est_nfc = est.estimate_duration(nfc, ref_text, ref_dur)
    est_nfd = est.estimate_duration(nfd, ref_text, ref_dur)
    assert est_nfc == est_nfd
    assert est_nfc > 0
