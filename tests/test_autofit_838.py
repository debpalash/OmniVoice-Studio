"""Autofit translation style — strict fit-to-slot (v0.3.8).

Autofit = Cinematic + a hard "never exceed the segment time" bound. In the
speech-rate fit pass that means the accepted upper ratio is 1.0 (fit within the
slot) instead of Cinematic's looser TOL_HIGH (1.08). Verifies the strict mode
keeps trimming past the loose tolerance and that the no-LLM path still degrades
gracefully.
"""
from __future__ import annotations

import pytest


class _FakeTrimmer:
    """Minimal non-Off LLM stand-in that trims any line to a short fixed length
    so the fit loop converges deterministically."""
    def chat(self, *, system, user, timeout=None):
        return "A" * 14  # ratio 0.93 for slot 1.0s @ en 15 cps → inside [0.92, 1.0]


@pytest.fixture
def speech_rate(monkeypatch):
    from services import speech_rate as _sr
    monkeypatch.setattr(_sr, "get_active_llm_backend", lambda: _FakeTrimmer())
    return _sr


def test_loose_accepts_slight_overrun_without_llm(speech_rate):
    # 16 chars @ 15 cps over a 1.0s slot → ratio ~1.067: within Cinematic's
    # TOL_HIGH (1.08), so it's accepted as-is with no LLM call.
    res = speech_rate.adjust_for_slot("A" * 16, slot_seconds=1.0, target_lang="en", strict=False)
    assert res["attempts"] == 0
    assert res["rate_ratio"] > 1.0  # it overran the slot but was tolerated


def test_autofit_strict_trims_until_within_slot(speech_rate):
    # Same overrun, but Autofit must not accept > 1.0 — it trims via the LLM.
    res = speech_rate.adjust_for_slot("A" * 16, slot_seconds=1.0, target_lang="en", strict=True)
    assert res["rate_ratio"] <= 1.0 + 1e-6
    assert res["attempts"] >= 1  # the loose path would have been 0


def test_strict_no_llm_degrades_gracefully(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_LLM_BACKEND", "off")
    from services import speech_rate as _sr
    res = _sr.adjust_for_slot("A" * 30, slot_seconds=1.0, target_lang="en", strict=True)
    assert res.get("error") == "no-llm"
    assert res["text"] == "A" * 30  # unchanged, no crash


def test_strict_within_tolerance_is_noop(speech_rate):
    # A line already at ratio ~1.0 needs no work even in strict mode.
    res = speech_rate.adjust_for_slot("A" * 15, slot_seconds=1.0, target_lang="en", strict=True)
    assert res["attempts"] == 0
    assert res["rate_ratio"] == pytest.approx(1.0, abs=0.01)
