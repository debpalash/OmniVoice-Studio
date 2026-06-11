"""Smart Fit generate path — integration tests with a mocked TTS engine.

Exercises the `timing_strategy="smart_fit"` branch of
api.routers.dub_generate end-to-end (TTS loop → planner → mix →
persistence), hermetically: fake model, no DB, no ffmpeg (the atempo pipe
is replaced by deterministic linear interpolation), WAVs under tmp_path.

Covers:
  - audio-only stretch: a segment whose natural audio modestly overflows
    its slot is sped up in place, the track keeps the original duration;
  - hybrid: caps split the burden, the fitted track grows, fit_plans[lang]
    is persisted in the exact filter-graph dict shape with truthful
    fitted_segments cue times and a fit_fp;
  - video_stretch_plans stays untouched by smart_fit runs;
  - strategy-transition guard: strict_slot leaves slot-squeezed WAVs on
    disk (seg_wav_kind="slotted"); the next smart_fit partial regen forces
    one full re-TTS, after which fit-only re-mixes (regen_only=[]) reuse
    the natural WAVs without touching the model;
  - old-strategy back-compat: concise runs never write fit_plans.
"""
from __future__ import annotations

import os
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import asyncio
import json

import pytest
import torch

from schemas.requests import DubRequest


SR = 24000


class _FakeModel:
    """Deterministic 'TTS engine': the text encodes its own natural duration
    as a `<seconds>:` prefix (e.g. "1.5:hola") so each test controls how
    much the dub overflows its slot."""

    sampling_rate = SR

    def __init__(self):
        self.calls: list[str] = []

    def generate(self, text=None, **kwargs):
        self.calls.append(text)
        dur = float(text.split(":", 1)[0])
        n = int(dur * SR)
        return [torch.full((1, n), 0.25)]


async def _fake_stretch(wav, target_samples, sr):
    """Stand-in for the ffmpeg atempo pipe: deterministic linear interp."""
    if target_samples <= 0 or wav.shape[-1] == target_samples:
        return wav
    return torch.nn.functional.interpolate(
        wav.unsqueeze(0), size=target_samples, mode="linear", align_corners=False,
    ).squeeze(0)


@pytest.fixture
def patched_generate(monkeypatch, tmp_path):
    import api.routers.dub_generate as dg

    model = _FakeModel()

    async def _fake_get_model():
        return model

    job = {
        "duration": 4.0,
        "dubbed_tracks": {},
        "speaker_clones": {},
    }
    job_dir = tmp_path / "jobX"
    job_dir.mkdir()

    monkeypatch.setattr(dg, "get_model", _fake_get_model)
    monkeypatch.setattr(dg, "_get_job", lambda job_id: job)
    monkeypatch.setattr(dg, "_save_job", lambda job_id, j: None)
    monkeypatch.setattr(dg, "DUB_DIR", str(tmp_path))
    monkeypatch.setattr(
        dg, "dub_seg_path",
        lambda job_id, seg_id: str(job_dir / f"seg_{seg_id}.wav"),
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

    def run(body: dict) -> list[dict]:
        events.clear()
        req = DubRequest(**body)
        asyncio.run(dg.dub_generate("jobX", req))
        parsed = []
        for e in events:
            line = e.strip()
            if line.startswith("data: "):
                parsed.append(json.loads(line[len("data: "):]))
        return parsed

    return run, model, job, job_dir


def _body(segments, **extra):
    return {
        "segments": segments,
        "segment_ids": [str(i) for i in range(len(segments))],
        "language": "Auto",
        "language_code": "es",
        "num_step": 4,
        **extra,
    }


def _done(parsed):
    done = [p for p in parsed if p.get("type") == "done"]
    assert done, f"no done event in {parsed}"
    return done[0]


def _track_samples(job_dir):
    import torchaudio
    wav, sr = torchaudio.load(str(job_dir / "dubbed_es.wav"))
    return wav.shape[-1], sr


# ── Audio-only stretch ─────────────────────────────────────────────────


def test_smart_fit_audio_only_stretch_keeps_original_duration(patched_generate):
    run, model, job, job_dir = patched_generate
    # seg0 [0,1] natural 0.5s → fits.  seg1 [2,3] is last → slot extends to
    # 4.0s (2.0s); natural 2.2s → need 1.1 → audio-only 1.1×, no video.
    segs = [
        {"start": 0.0, "end": 1.0, "text": "0.5:hola"},
        {"start": 2.0, "end": 3.0, "text": "2.2:buenos dias"},
    ]
    done = _done(run(_body(segs, timing_strategy="smart_fit")))

    assert done["timing_strategy"] == "smart_fit"
    fs = done["fit_status"]
    assert fs[0] == {"status": "fits"}
    assert fs[1]["status"] == "audio_stretched"
    assert fs[1]["audio_rate"] == pytest.approx(1.1, abs=1e-3)
    assert "video_ratio" not in fs[1]

    # No video retime needed → fitted timeline == original timeline.
    n, sr = _track_samples(job_dir)
    assert n == int(4.0 * sr)
    assert job["dubbed_tracks"]["es"]["duration"] == pytest.approx(4.0, abs=1e-3)

    plan = job["fit_plans"]["es"]
    assert plan["total_duration"] == pytest.approx(4.0, abs=1e-3)
    assert all(e["stretch_ratio"] == pytest.approx(1.0) for e in plan["plan"])
    # Cue end = new_start + stretched length (2.2/1.1 = 2.0s).
    cues = plan["fitted_segments"]
    assert cues[1]["start"] == pytest.approx(2.0, abs=1e-3)
    assert cues[1]["end"] == pytest.approx(4.0, abs=1e-2)

    # smart_fit never touches the stretch_video keyspace.
    assert "video_stretch_plans" not in job
    assert job["seg_wav_kind"] == "natural"
    # The on-disk per-segment WAV stays natural-rate (2.2s, not slot-squeezed).
    import torchaudio
    wav, sr2 = torchaudio.load(str(job_dir / "seg_1.wav"))
    assert wav.shape[-1] == int(2.2 * SR)


# ── Hybrid: audio + video split, fitted timeline grows ─────────────────


def test_smart_fit_hybrid_grows_timeline_and_persists_plan(patched_generate):
    run, model, job, job_dir = patched_generate
    job["duration"] = 1.0
    # One segment covering the whole 1s video, natural 2.0s → need 2.0 →
    # sqrt split: audio 1.4142×, video 1.4142×.
    segs = [{"start": 0.0, "end": 1.0, "text": "2.0:una frase muy larga"}]
    done = _done(run(_body(segs, timing_strategy="smart_fit")))

    fs = done["fit_status"][0]
    assert fs["status"] == "hybrid"
    assert fs["audio_rate"] == pytest.approx(2.0 ** 0.5, abs=1e-3)
    assert fs["video_ratio"] == pytest.approx(2.0 ** 0.5, abs=1e-3)

    plan = job["fit_plans"]["es"]
    assert plan["total_duration"] == pytest.approx(2.0 ** 0.5, abs=1e-2)
    entry = plan["plan"][0]
    assert set(entry) == {"orig_start", "orig_end", "new_start", "new_end", "stretch_ratio"}
    assert entry["stretch_ratio"] == pytest.approx(2.0 ** 0.5, abs=1e-3)
    assert plan["fit_fp"] and isinstance(plan["fit_fp"], str)
    assert plan["params"]["timing_strategy"] == "smart_fit"
    assert job["dubbed_tracks"]["es"]["fit_fp"] == plan["fit_fp"]

    # The plan is consumable by the export filter-graph builder as-is.
    from api.routers.dub_export import _build_video_stretch_filter_graph
    graph, label = _build_video_stretch_filter_graph(plan["plan"], orig_dur=plan["orig_duration"])
    assert label == "[vstretched]"
    assert "setpts=" in graph

    # The fitted dub track is longer than the source video.
    n, sr = _track_samples(job_dir)
    assert n == pytest.approx(int(2.0 ** 0.5 * sr), abs=sr // 100)


def test_smart_fit_fit_options_override(patched_generate):
    run, model, job, job_dir = patched_generate
    job["duration"] = 1.0
    segs = [{"start": 0.0, "end": 1.0, "text": "2.0:texto"}]
    done = _done(run(_body(
        segs,
        timing_strategy="smart_fit",
        fit_options={"allow_video_retime": False},
    )))
    fs = done["fit_status"][0]
    # Audio-only mode: 1.8× hard cap, residual trimmed; timeline unchanged.
    assert fs["status"] == "overflow_trimmed"
    assert fs["audio_rate"] == pytest.approx(1.8, abs=1e-3)
    assert "video_ratio" not in fs
    assert fs["overflow_s"] == pytest.approx(2.0 / 1.8 - 1.0, abs=1e-2)
    n, sr = _track_samples(job_dir)
    assert n == int(1.0 * sr)
    assert job["fit_plans"]["es"]["params"]["allow_video_retime"] is False
    # Different knobs → different fit fingerprint than the defaults.
    from services.incremental import fit_fingerprint
    assert job["fit_plans"]["es"]["fit_fp"] != fit_fingerprint({})


# ── Strategy-transition guard + fit-only re-mix ────────────────────────


def test_strict_slot_to_smart_fit_forces_one_full_regen(patched_generate):
    run, model, job, job_dir = patched_generate
    segs = [
        {"start": 0.0, "end": 1.0, "text": "1.5:uno"},
        {"start": 2.0, "end": 3.0, "text": "1.5:dos"},
    ]

    # strict_slot run → slot-squeezed WAVs on disk.
    run(_body(segs, timing_strategy="strict_slot"))
    assert job["seg_wav_kind"] == "slotted"
    import torchaudio
    wav, _ = torchaudio.load(str(job_dir / "seg_0.wav"))
    assert wav.shape[-1] == int(1.0 * SR)  # squeezed to the 1s slot

    # smart_fit "re-mix only" request — but the disk WAVs are slotted, so
    # the guard must force a full re-TTS instead of double-compressing.
    model.calls.clear()
    run(_body(segs, timing_strategy="smart_fit", regen_only=[]))
    assert model.calls == ["1.5:uno", "1.5:dos"]
    assert job["seg_wav_kind"] == "natural"
    wav, _ = torchaudio.load(str(job_dir / "seg_0.wav"))
    assert wav.shape[-1] == int(1.5 * SR)  # natural-rate now

    # Now a fit-only change (re-mix): natural WAVs are reusable — zero TTS.
    model.calls.clear()
    parsed = run(_body(
        segs,
        timing_strategy="smart_fit",
        regen_only=[],
        fit_options={"allow_video_retime": False},
    ))
    assert model.calls == []
    done = _done(parsed)
    assert done["timing_strategy"] == "smart_fit"
    assert job["fit_plans"]["es"]["params"]["allow_video_retime"] is False


# ── Old-strategy back-compat ───────────────────────────────────────────


def test_concise_run_never_writes_fit_plans(patched_generate):
    run, model, job, job_dir = patched_generate
    segs = [{"start": 0.0, "end": 1.0, "text": "0.5:hola"}]
    done = _done(run(_body(segs, timing_strategy="concise")))
    assert done["timing_strategy"] == "concise"
    assert "fit_plans" not in job
    assert job["seg_wav_kind"] == "natural"
