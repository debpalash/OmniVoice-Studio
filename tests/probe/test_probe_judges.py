"""Offline proof that every L4 judge's pass/fail logic is correct.

Uses synthetic audio (silence / tone / clipped) and a FakeTranscriber, so it
runs in milliseconds in the base venv with no models and no GPU. This is the
harness testing *itself* — if these pass, the judges can be trusted to gate.
"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from .judges import audio, speaker, transcription
from .judges.transcription import FakeTranscriber, word_error_rate
from .spec import JudgeResult


def _write(path, signal, sr=24000):
    sf.write(str(path), np.asarray(signal, dtype=np.float32), sr, subtype="FLOAT")
    return str(path)


@pytest.fixture
def tone(tmp_path):
    t = np.linspace(0, 1.0, 24000, endpoint=False)
    return _write(tmp_path / "tone.wav", 0.5 * np.sin(2 * np.pi * 220 * t))


@pytest.fixture
def silence(tmp_path):
    return _write(tmp_path / "silence.wav", np.zeros(24000))


# ── audio judges ──────────────────────────────────────────────────────────────


def test_artifact_exists(tone, tmp_path):
    assert audio.artifact_exists(tone).passed is True
    assert audio.artifact_exists(str(tmp_path / "nope.wav")).passed is False


def test_decodes(tone, tmp_path):
    assert audio.decodes(tone).passed is True
    bogus = tmp_path / "bogus.wav"
    bogus.write_bytes(b"not audio")
    assert audio.decodes(str(bogus)).passed is False


def test_sample_rate_eq(tone):
    assert audio.sample_rate_eq(tone, 24000).passed is True
    assert audio.sample_rate_eq(tone, 44100).passed is False


def test_duration_between(tone):
    assert audio.duration_between(tone, 0.9, 1.1).passed is True
    assert audio.duration_between(tone, 2.0, 3.0).passed is False


def test_not_silent(tone, silence):
    assert audio.not_silent(tone).passed is True
    assert audio.not_silent(silence).passed is False


def test_not_clipping(tone, tmp_path):
    assert audio.not_clipping(tone).passed is True
    clipped = _write(tmp_path / "clip.wav", np.ones(24000))
    assert audio.not_clipping(clipped).passed is False


def test_no_nan(tone, tmp_path):
    assert audio.no_nan(tone).passed is True
    nan_sig = np.zeros(24000, dtype=np.float32)
    nan_sig[100] = np.nan
    bad = _write(tmp_path / "nan.wav", nan_sig)
    assert audio.no_nan(bad).passed is False


# ── transcription / WER ────────────────────────────────────────────────────────


def test_wer_math():
    assert word_error_rate("the quick brown fox", "the quick brown fox") == 0.0
    assert word_error_rate("the quick brown fox", "the quick brown dog") == pytest.approx(0.25)
    # normalization: case + punctuation are stripped before comparison
    assert word_error_rate("Hello, World!", "hello world") == 0.0
    assert word_error_rate("a b c d", "") == 1.0


def test_asr_wer_below_with_fake_transcriber(tone):
    expected = "the quick brown fox"
    good = transcription.asr_wer_below(
        tone, expected=expected, max=0.15, transcriber=FakeTranscriber(fixed=expected)
    )
    assert good.passed is True and good.measured == 0.0

    bad = transcription.asr_wer_below(
        tone, expected=expected, max=0.15,
        transcriber=FakeTranscriber(fixed="totally different words here"),
    )
    assert bad.passed is False


# ── speaker similarity ─────────────────────────────────────────────────────────


class _FakeEmbedder:
    """Returns a fixed vector per path so we can test the cosine gate offline."""

    def __init__(self, vectors):
        self._v = vectors

    def embed(self, path):
        return np.asarray(self._v[path], dtype=np.float32)


def test_cosine_similarity():
    assert speaker.cosine_similarity([1, 0], [1, 0]) == pytest.approx(1.0)
    assert speaker.cosine_similarity([1, 0], [0, 1]) == pytest.approx(0.0)


def test_speaker_similarity_gate():
    emb = _FakeEmbedder({"ref.wav": [1, 0, 0], "same.wav": [0.99, 0.01, 0], "diff.wav": [0, 1, 0]})
    assert speaker.speaker_similarity_above("ref.wav", "same.wav", min=0.7, embedder=emb).passed is True
    assert speaker.speaker_similarity_above("ref.wav", "diff.wav", min=0.7, embedder=emb).passed is False


def test_speaker_similarity_skips_without_backend(monkeypatch):
    # Force "no backend installed" → judge SKIPS (passed is None), never fails.
    monkeypatch.setattr(speaker, "_default_embedder", lambda: None)
    res = speaker.speaker_similarity_above("ref.wav", "gen.wav", min=0.7)
    assert res.passed is None and res.skipped is True


def test_judge_result_str():
    assert str(JudgeResult("x", True, "ok")).startswith("[PASS]")
    assert str(JudgeResult("x", False, "no")).startswith("[FAIL]")
    assert "advisory" in str(JudgeResult("x", None, "skip", advisory=True))
