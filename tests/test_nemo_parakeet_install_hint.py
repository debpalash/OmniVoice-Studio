"""Regression test for issue #974.

The nemo-parakeet install hint used to tell users to run
`pip install nemo_toolkit[asr]` directly into OmniVoice's shared venv.
nemo_toolkit[asr]==2.7.3 hard-pins transformers>=4.57,<4.58, which is
UNSATISFIABLE alongside the app's own transformers>=5.3 requirement (needed
by omnivoice/models/omnivoice.py for HiggsAudioV2TokenizerModel). A user who
followed the old hint ended up with a backend that wouldn't even start
(ImportError: cannot import name 'HiggsAudioV2TokenizerModel').

nemo-parakeet has no isolated-venv option yet (unlike dots-tts /
moss-tts-v15 / confucius4-tts, which do), so the hint must not imply a safe
one-line fix — it must say plainly that installing into the shared venv
will break the backend.
"""
from __future__ import annotations

from services.asr_backend import _INSTALL_HINTS, list_backends


def test_nemo_parakeet_hint_does_not_recommend_shared_venv_install():
    hint = _INSTALL_HINTS["nemo-parakeet"]
    # The literal old, destructive recommendation must never reappear.
    assert "pip install nemo_toolkit[asr]" not in hint, (
        f"nemo-parakeet install_hint regressed to the shared-venv-breaking "
        f"bare pip install: {hint!r}"
    )


def test_nemo_parakeet_hint_warns_about_transformers_conflict():
    hint = _INSTALL_HINTS["nemo-parakeet"]
    assert "transformers" in hint
    lowered = hint.lower()
    assert "conflict" in lowered or "break" in lowered


def test_nemo_parakeet_hint_does_not_imply_isolated_venv_exists():
    """Unlike dots-tts/moss-tts-v15/confucius4-tts, nemo-parakeet has no
    isolated-venv env var yet — the hint must not invent one."""
    hint = _INSTALL_HINTS["nemo-parakeet"]
    assert "OMNIVOICE_NEMO_PARAKEET_DIR" not in hint


def test_nemo_parakeet_hint_surfaced_in_list_backends():
    rows = list_backends()
    row = next(r for r in rows if r["id"] == "nemo-parakeet")
    assert row["install_hint"] == _INSTALL_HINTS["nemo-parakeet"]
