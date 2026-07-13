"""Degraded ≠ failed: a skipped polish pass must not disable downstream passes.

The cinematic reflect/adapt chain is optional polish — on any failure (rate
limit, budget, divergent reply, no LLM) the segment keeps its literal
translation and is fully usable. Those degradations used to be reported under
the same ``error`` key as real translation failures, which had three
consequences, each pinned here or in test_translator.py:

  1. the UI toasted "N/N segment(s) failed" over a translate that succeeded
     (frontend counts ``error`` rows);
  2. the speech-rate / rate-ratio prediction skipped the row;
  3. duration planning and the fit pass skipped the row — overlong lines then
     hit heavy time-compression at generation, audibly degrading the dub
     (observed live: 4/4 reflect 429s → no fit pass → compressed segments).

``error`` now means "no usable text" (base translation failed); optional-pass
fallbacks ride a separate ``degraded`` key.
"""
from __future__ import annotations

from schemas.requests import TranslateRequest, TranslateSegment


def _req(n=2, slot=3.0):
    return TranslateRequest(
        segments=[
            TranslateSegment(id=str(i), text=f"line {i}", slot_seconds=slot)
            for i in range(1, n + 1)
        ],
        target_lang="bn",
    )


def test_degraded_rows_still_get_rate_ratio_prediction():
    from api.routers.dub_translate import _stamp_predicted_rate_ratio

    rows = [
        {"id": "1", "text": "একটি অনুবাদিত লাইন", "degraded": "reflect: 429"},
        {"id": "2", "text": "another line", "error": "llm-failed"},
    ]
    _stamp_predicted_rate_ratio(rows, _req())
    assert "rate_ratio" in rows[0], (
        "a degraded row (usable literal text) was excluded from rate-ratio "
        "prediction — degraded is being treated as failed again"
    )
    assert "rate_ratio" not in rows[1]  # real failures stay excluded


def test_degraded_rows_still_get_duration_plan():
    from api.routers.dub_translate import _stamp_duration_plan

    req = TranslateRequest(
        segments=[
            TranslateSegment(id="1", text="a", slot_seconds=3.0, start=0.0, end=3.0),
            TranslateSegment(id="2", text="b", slot_seconds=3.0, start=3.5, end=6.5),
        ],
        target_lang="bn",
    )
    rows = [
        {"id": "1", "text": "একটি অনুবাদিত লাইন", "degraded": "cinematic-budget"},
        {"id": "2", "text": "another line", "error": "llm-failed"},
    ]
    _stamp_duration_plan(rows, req)
    assert "plan" in rows[0], "degraded row skipped by the duration planner"
    assert "plan" not in rows[1]
