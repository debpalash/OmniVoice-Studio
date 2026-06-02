"""Offline proof that the spec engine parses, resolves $.refs, and renders a
correct blocking/advisory verdict — end-to-end, with a FakeTranscriber.
"""

from __future__ import annotations

import os

import numpy as np
import pytest
import soundfile as sf

from . import spec as probe_spec
from .judges.transcription import FakeTranscriber

_SPECS = os.path.join(os.path.dirname(__file__), "specs")
_SPEC = os.path.join(_SPECS, "tts_smoke.probe.yaml")
_CLONE_SPEC = os.path.join(_SPECS, "voice_clone.probe.yaml")
_SENTENCE = "The quick brown fox jumps over the lazy dog."


@pytest.fixture
def generated_audio(tmp_path):
    """A 2s tone standing in for the Actor's /generate output."""
    t = np.linspace(0, 2.0, 48000, endpoint=False)
    path = str(tmp_path / "out.wav")
    sf.write(path, (0.4 * np.sin(2 * np.pi * 180 * t)).astype(np.float32), 24000, subtype="FLOAT")
    return path


def test_load_spec_parses_fields():
    s = probe_spec.load_spec(_SPEC)
    assert s.feature == "tts-synthesis"
    assert s.layer == "media"
    assert s.subject == "$.audio"
    names = [name for name, _ in s.checks]
    assert "artifact_exists" in names and "asr_wer_below" in names
    assert s.advisory == []  # advisory lane present but empty


def test_full_verdict_all_pass(generated_audio, probe_report):
    s = probe_spec.load_spec(_SPEC)
    results = probe_spec.run_judges(
        s,
        context={"audio": generated_audio},
        backends={"transcriber": FakeTranscriber(fixed=_SENTENCE)},
    )
    probe_report.record(s, results)
    failures = probe_spec.blocking_failures(results)
    assert failures == [], "\n".join(str(r) for r in results)
    # subject ($.audio) was injected into every audio judge's `path`
    assert any(r.name == "asr_wer_below" and r.passed for r in results)


def test_voice_clone_spec_skips_and_advises(generated_audio, probe_report):
    """The clone spec passes its correctness checks, SKIPS speaker-similarity
    (no embedder installed), and reports a non-blocking advisory row — exercising
    every report state at once."""
    s = probe_spec.load_spec(_CLONE_SPEC)
    results = probe_spec.run_judges(
        s,
        context={"audio": generated_audio, "ref": generated_audio},
        backends={"transcriber": FakeTranscriber(fixed="Cloning my voice from a short reference.")},
    )
    probe_report.record(s, results)
    assert probe_spec.blocking_failures(results) == []
    assert any(r.name == "speaker_similarity_above" and r.skipped for r in results)
    assert any(r.advisory for r in results)


def test_verdict_fails_on_gibberish(generated_audio):
    s = probe_spec.load_spec(_SPEC)
    results = probe_spec.run_judges(
        s,
        context={"audio": generated_audio},
        backends={"transcriber": FakeTranscriber(fixed="zzz nonsense unrelated")},
    )
    failures = probe_spec.blocking_failures(results)
    assert any(f.name == "asr_wer_below" for f in failures)


def test_missing_context_ref_is_reported(generated_audio):
    s = probe_spec.load_spec(_SPEC)
    # No `audio` in context → $.audio is unresolvable → judges fail, never crash.
    results = probe_spec.run_judges(s, context={}, backends={"transcriber": FakeTranscriber(fixed="x")})
    assert all(not r.advisory for r in results)
    assert probe_spec.blocking_failures(results), "unresolved $.ref must surface as failures"


def test_unknown_judge_fails_cleanly():
    s = probe_spec.Spec(feature="x", layer="media", subject="$.a",
                        checks=[("no_such_judge", None)])
    results = probe_spec.run_judges(s, context={"a": "/tmp/x.wav"})
    assert results[0].passed is False and "unknown judge" in results[0].detail


def test_advisory_never_gates():
    # An advisory check that fails must NOT appear in blocking_failures.
    s = probe_spec.Spec(feature="x", layer="media",
                        advisory=[("sample_rate_eq", {"path": "/no/file.wav", "expected": 1})])
    results = probe_spec.run_judges(s, context={})
    assert any(r.advisory for r in results)
    assert probe_spec.blocking_failures(results) == []
