"""Duration planning on the dub API surface.

Two halves of the pre-synthesis planning loop (services/duration_planner.py):

  - /dub/translate stamps a per-segment ``plan`` verdict (fits/tight/
    impossible + estimated overrun) on the rows the segment table consumes,
    self-calibrated from the job's synthesized-segment records when present,
    and — opt-in via ``condense`` (default OFF) — attaches an LLM
    shorter-rewrite suggestion to impossible rows;
  - dub_generate records the (chars, natural duration) calibration samples
    those verdicts feed on, for every natural-rate strategy but never for
    strict_slot (whose slot-forced WAVs would poison the observed rate).
"""
from __future__ import annotations

import os
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import asyncio
import json

import pytest
import torch

from schemas.requests import DubRequest, TranslateRequest, TranslateSegment


def _install_fake_argos(monkeypatch):
    """Fake `argostranslate` translating en→es to `[es]<text>` offline."""
    import sys
    import types

    class _Pkg:
        from_code = "en"
        to_code = "es"

    pkg = types.ModuleType("argostranslate.package")
    pkg.get_installed_packages = lambda: [_Pkg()]
    pkg.update_package_index = lambda: None
    pkg.get_available_packages = lambda: []
    pkg.install_from_path = lambda p: None
    tr = types.ModuleType("argostranslate.translate")
    tr.translate = lambda text, frm, to: f"[{to}]{text}"
    root = types.ModuleType("argostranslate")
    root.package = pkg
    root.translate = tr
    monkeypatch.setitem(sys.modules, "argostranslate", root)
    monkeypatch.setitem(sys.modules, "argostranslate.package", pkg)
    monkeypatch.setitem(sys.modules, "argostranslate.translate", tr)


# Three slots sized so the fake-argos output ("[es]" + text, es ≈ 15.5 cps)
# lands squarely in each verdict bucket:
#   s1: 24 chars / 2.0s  → need ~0.8  → fits
#   s2: 44 chars / 1.0s  → need ~2.8  → tight (hybrid caps absorb ≤ 3.0)
#   s3: 84 chars / 0.5s  → need ~10.8 → impossible
def _timed_segments():
    return [
        TranslateSegment(id="s1", text="A" * 20, slot_seconds=2.0, start=0.0, end=2.0),
        TranslateSegment(id="s2", text="B" * 40, slot_seconds=1.0, start=2.05, end=3.05),
        TranslateSegment(id="s3", text="C" * 80, slot_seconds=0.5, start=3.1, end=3.6),
    ]


def _rows_by_id(resp):
    return {r["id"]: r for r in resp["translated"]}


@pytest.mark.asyncio
async def test_translate_stamps_plan_per_segment(monkeypatch):
    """The response the segment table consumes carries one plan per row,
    with statuses aligned to fit_planner's caps and a truthful overrun."""
    from api.routers import dub_translate
    _install_fake_argos(monkeypatch)

    req = TranslateRequest(
        segments=_timed_segments(),
        target_lang="es", provider="argos", source_lang="en", quality="fast",
    )
    rows = _rows_by_id(await dub_translate.dub_translate(req))

    assert rows["s1"]["plan"]["status"] == "fits"
    assert rows["s2"]["plan"]["status"] == "tight"
    assert rows["s3"]["plan"]["status"] == "impossible"
    p3 = rows["s3"]["plan"]
    # Shape contract for the UI badge + tooltip.
    assert set(p3) >= {"status", "est_dur_s", "available_s", "est_overrun_s", "calibrated"}
    assert p3["calibrated"] is False        # no job → static table
    assert p3["est_overrun_s"] > 0
    assert "suggested_text" not in p3       # condense is opt-in, default OFF


@pytest.mark.asyncio
async def test_translate_plan_uses_job_calibration(monkeypatch):
    """With synthesized-segment records on the job, the estimate calibrates
    to THIS voice's observed rate — a fast voice flips s2 tight → fits."""
    from api.routers import dub_translate
    _install_fake_argos(monkeypatch)

    job = {
        "duration": 4.0,
        "seg_natural_durs_by_lang": {"es": {
            "a": {"chars": 40, "dur": 1.0},   # 40 cps — a very fast voice
            "b": {"chars": 80, "dur": 2.0},
            "c": {"chars": 120, "dur": 3.0},
        }},
    }
    monkeypatch.setattr(dub_translate, "_get_job", lambda job_id: job)

    req = TranslateRequest(
        segments=_timed_segments(), job_id="j1",
        target_lang="es", provider="argos", source_lang="en", quality="fast",
    )
    rows = _rows_by_id(await dub_translate.dub_translate(req))

    assert rows["s2"]["plan"]["status"] == "fits"       # 44 chars / 40 cps ≈ 1.1s
    assert rows["s2"]["plan"]["calibrated"] is True
    # s3: 84/40 = 2.1s over 0.9s available (0.5s slot + 0.4s video tail from
    # job duration) → need ~2.3: the caps absorb it now — impossible → tight.
    assert rows["s3"]["plan"]["status"] == "tight"
    assert rows["s3"]["plan"]["available_s"] == pytest.approx(0.9)


@pytest.mark.asyncio
async def test_translate_without_timing_stamps_no_plan(monkeypatch):
    """Old clients that only send slot_seconds keep the exact pre-feature
    response shape — rate_ratio badge yes, plan no."""
    from api.routers import dub_translate
    _install_fake_argos(monkeypatch)

    req = TranslateRequest(
        segments=[TranslateSegment(id="s1", text="Hello", slot_seconds=2.0)],
        target_lang="es", provider="argos", source_lang="en", quality="fast",
    )
    row = _rows_by_id(await dub_translate.dub_translate(req))["s1"]
    assert "rate_ratio" in row
    assert "plan" not in row


@pytest.mark.asyncio
async def test_condense_toggle_attaches_suggestion_to_impossible_only(monkeypatch):
    """condense=true + a configured LLM → impossible rows get a shorter
    suggested_text; the row's text itself is never rewritten."""
    from api.routers import dub_translate
    from services import duration_planner as dp
    _install_fake_argos(monkeypatch)

    class _Shortener:
        def chat(self, *, system, user, timeout=None, temperature=None):
            return "D" * 36  # shorter than s3's 84 chars, passes the guard

    monkeypatch.setattr(dp, "get_active_llm_backend", lambda: _Shortener())

    req = TranslateRequest(
        segments=_timed_segments(), condense=True,
        target_lang="es", provider="argos", source_lang="en", quality="fast",
    )
    rows = _rows_by_id(await dub_translate.dub_translate(req))

    assert rows["s3"]["plan"]["suggested_text"] == "D" * 36
    assert rows["s3"]["text"] == "[es]" + "C" * 80    # untouched — user applies it
    assert "suggested_text" not in rows["s1"]["plan"]  # fits: no suggestion
    assert "suggested_text" not in rows["s2"]["plan"]  # tight: no suggestion


@pytest.mark.asyncio
async def test_condense_llm_failure_degrades_to_no_suggestion(monkeypatch):
    from api.routers import dub_translate
    from services import duration_planner as dp
    _install_fake_argos(monkeypatch)

    class _Broken:
        def chat(self, **kw):
            raise RuntimeError("provider down")

    monkeypatch.setattr(dp, "get_active_llm_backend", lambda: _Broken())

    req = TranslateRequest(
        segments=_timed_segments(), condense=True,
        target_lang="es", provider="argos", source_lang="en", quality="fast",
    )
    rows = _rows_by_id(await dub_translate.dub_translate(req))
    assert rows["s3"]["plan"]["status"] == "impossible"
    assert "suggested_text" not in rows["s3"]["plan"]  # no-op, translate intact


@pytest.mark.asyncio
async def test_cinematic_path_plans_the_refined_text(monkeypatch):
    """The cinematic/autofit merge path stamps plans too — on the FINAL
    (refined) text, after the fit pass."""
    from api.routers import dub_translate
    _install_fake_argos(monkeypatch)

    async def fake_refine_many(pairs, **kw):
        return [{"id": sid, "text": f"CINE:{lit}", "literal": lit, "critique": ""}
                for sid, _src, lit in pairs]

    monkeypatch.setattr(dub_translate, "cinematic_available", lambda: True)
    monkeypatch.setattr(dub_translate, "cinematic_refine_many", fake_refine_many)

    req = TranslateRequest(
        segments=_timed_segments(),
        target_lang="es", provider="argos", source_lang="en", quality="cinematic",
    )
    rows = _rows_by_id(await dub_translate.dub_translate(req))
    for sid in ("s1", "s2", "s3"):
        assert rows[sid]["plan"]["status"] in ("fits", "tight", "impossible")
    # 5 extra "CINE:" chars push s3 even further past its 0.5s slot.
    assert rows["s3"]["plan"]["status"] == "impossible"


# ── dub_generate calibration recording ──────────────────────────────────

SR = 24000


class _FakeBackend:
    """TTS stand-in: text encodes its natural duration as '<seconds>:'."""

    applies_own_mastering = False
    sample_rate = SR

    def generate(self, text=None, **kwargs):
        dur = float(text.split(":", 1)[0])
        return torch.full((1, int(dur * SR)), 0.25)


async def _fake_stretch(wav, target_samples, sr):
    if target_samples <= 0 or wav.shape[-1] == target_samples:
        return wav
    return torch.nn.functional.interpolate(
        wav.unsqueeze(0), size=target_samples, mode="linear", align_corners=False,
    ).squeeze(0)


@pytest.fixture
def patched_generate(monkeypatch, tmp_path):
    import api.routers.dub_generate as dg

    async def _fake_resolve(**kwargs):
        return _FakeBackend()

    job = {"duration": 6.0, "dubbed_tracks": {}, "speaker_clones": {}}
    job_dir = tmp_path / "jobX"
    job_dir.mkdir()

    monkeypatch.setattr(dg, "resolve_generation_backend", _fake_resolve)
    monkeypatch.setattr(dg, "_get_job", lambda job_id: job)
    monkeypatch.setattr(dg, "_save_job", lambda job_id, j: None)
    monkeypatch.setattr(dg, "DUB_DIR", str(tmp_path))
    monkeypatch.setattr(
        dg, "dub_seg_path", lambda job_id, seg_id: str(job_dir / f"seg_{seg_id}.wav"),
    )
    monkeypatch.setattr(dg, "rvc_is_enabled", lambda: False)
    monkeypatch.setattr(dg, "embed_watermark", lambda wav, sr: wav)
    monkeypatch.setattr(dg, "apply_mastering", lambda a, sample_rate=None: a)
    monkeypatch.setattr(dg, "get_effect_chain", lambda preset: None)
    monkeypatch.setattr(dg, "apply_effects_chain", lambda a, **k: a)
    monkeypatch.setattr(dg, "normalize_audio", lambda a, target_dBFS=None: a)
    monkeypatch.setattr(dg, "_pitch_preserving_stretch", _fake_stretch)

    events: list[str] = []

    class _StubTaskManager:
        def is_cancelled(self, task_id):
            return False

        async def add_task(self, task_id, task_type, func, *args, **kwargs):
            async for evt in func(*args):
                events.append(evt)

    monkeypatch.setattr(dg, "task_manager", _StubTaskManager())

    def run(body: dict):
        events.clear()
        asyncio.run(dg.dub_generate("jobX", DubRequest(**body)))
        parsed = [
            json.loads(e.strip()[len("data: "):])
            for e in events if e.strip().startswith("data: ")
        ]
        assert any(p.get("type") == "done" for p in parsed), parsed
        return parsed

    return run, job


def _body(segments, **extra):
    return {
        "segments": segments,
        "segment_ids": [str(i) for i in range(len(segments))],
        "language": "Auto",
        "language_code": "es",
        "num_step": 4,
        **extra,
    }


def test_generate_records_natural_durations_for_calibration(patched_generate):
    """Natural-rate strategies persist (chars, natural dur) per segment —
    the raw material calibration_from_job turns into a chars/sec rate."""
    run, job = patched_generate
    run(_body(
        [
            {"start": 0.0, "end": 2.0, "text": "1.5:hola"},
            {"start": 3.0, "end": 4.0, "text": "2.0:adios"},
        ],
        timing_strategy="concise",
    ))
    recs = job["seg_natural_durs_by_lang"]["es"]
    assert recs["0"] == {"chars": len("1.5:hola"), "dur": 1.5}
    assert recs["1"] == {"chars": len("2.0:adios"), "dur": 2.0}

    # The records feed a usable calibration once enough samples exist.
    from services.duration_planner import calibration_from_job
    run(_body(
        [
            {"start": 0.0, "end": 2.0, "text": "1.5:hola"},
            {"start": 3.0, "end": 4.0, "text": "2.0:adios"},
            {"start": 4.5, "end": 5.0, "text": "1.0:si"},
        ],
        timing_strategy="smart_fit",
    ))
    assert len(job["seg_natural_durs_by_lang"]["es"]) == 3  # merged, not replaced
    assert calibration_from_job(job, "es") is not None


def test_strict_slot_never_records_calibration(patched_generate):
    """strict_slot pads/trims the audio to the slot — recording those
    durations would poison the observed chars-per-second."""
    run, job = patched_generate
    run(_body(
        [{"start": 0.0, "end": 2.0, "text": "1.5:hola"}],
        timing_strategy="strict_slot",
    ))
    assert "seg_natural_durs_by_lang" not in job
