"""Multi-speaker dub: per-speaker voice auto-assignment (#486).

Two regressions are covered, both hermetic (fake model, no DB, no ffmpeg,
WAVs under tmp_path):

1. Segment → speaker-clone *binding* (the assignment loop that ran in
   dub_core after diarization). Before the fix, the default-on per-segment
   ref path stamped each long line with `auto-seg:{id}` — a profile id the
   dub editor's Voice <select> can't render, so every such row silently read
   "Default" even though a speaker clone existed. The fix binds segments to
   the UI-visible `auto:{speaker}` whenever that speaker has a clone, and only
   falls back to `auto-seg:` when the speaker has no per-speaker clone at all.

2. Generate-time *resolution* (api.routers.dub_generate `_gen`). An
   `auto:{speaker}` binding must still prefer THIS segment's own per-segment
   ref (cut from its source line → matches its prosody) when one exists, and
   fall back to the per-speaker clone otherwise. That keeps the Wave 3.2
   per-segment-ref quality win while every segment carries the renderable
   `auto:` id.
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


# ── Part 1: the assignment loop (extracted to match dub_core's logic) ──────
#
# dub_core.py assigns each segment's default profile_id inside the transcribe
# stream coroutine, which needs the full ASR/diarization stack to reach. The
# loop itself is pure dict-munging, so we replicate it verbatim here and assert
# the contract. If dub_core's loop drifts from this, the test below that hits
# the real generate path still guards the user-visible behaviour.

def _assign_default_profiles(final_segs, clones, seg_clones):
    """Mirror of dub_core.py's post-diarization assignment loop (#486)."""
    from services.speaker_clone import auto_profile_id

    for s in final_segs:
        if s.get("profile_id"):
            continue
        spk = s.get("speaker_id") or "Speaker 1"
        if spk in clones:
            s["profile_id"] = auto_profile_id(spk)
            continue
        sid = str(s.get("id", ""))
        if sid and sid in seg_clones:
            s["profile_id"] = f"auto-seg:{sid}"
    return final_segs


def test_segments_bind_to_speaker_clone_not_auto_seg():
    """Long lines with a per-segment ref still get the UI-visible auto:{spk}."""
    clones = {
        "Speaker 1": {"ref_audio": "/v/spk1.wav", "ref_text": "one"},
        "Speaker 2": {"ref_audio": "/v/spk2.wav", "ref_text": "two"},
    }
    # Both lines are long enough to have their own per-segment ref.
    seg_clones = {
        "s0": {"ref_audio": "/v/seg0.wav", "ref_text": "line0"},
        "s1": {"ref_audio": "/v/seg1.wav", "ref_text": "line1"},
    }
    segs = [
        {"id": "s0", "speaker_id": "Speaker 1"},
        {"id": "s1", "speaker_id": "Speaker 2"},
    ]
    _assign_default_profiles(segs, clones, seg_clones)
    # The bug: these would have been "auto-seg:s0"/"auto-seg:s1" → render as
    # "Default" in the editor. The fix: the renderable per-speaker id.
    assert segs[0]["profile_id"] == "auto:speaker_1"
    assert segs[1]["profile_id"] == "auto:speaker_2"


def test_manual_override_is_never_clobbered():
    clones = {"Speaker 1": {"ref_audio": "/v/spk1.wav", "ref_text": "one"}}
    seg_clones = {"s0": {"ref_audio": "/v/seg0.wav", "ref_text": "l0"}}
    segs = [{"id": "s0", "speaker_id": "Speaker 1", "profile_id": "my-saved-voice"}]
    _assign_default_profiles(segs, clones, seg_clones)
    assert segs[0]["profile_id"] == "my-saved-voice"


def test_seg_ref_fallback_when_speaker_has_no_clone():
    """A speaker with no per-speaker clone but a single long line still binds
    to its own per-segment ref (renders as Default, but generation works)."""
    clones = {}  # no speaker reached the per-speaker MIN duration
    seg_clones = {"s0": {"ref_audio": "/v/seg0.wav", "ref_text": "l0"}}
    segs = [{"id": "s0", "speaker_id": "Speaker 7"}]
    _assign_default_profiles(segs, clones, seg_clones)
    assert segs[0]["profile_id"] == "auto-seg:s0"


def test_no_clones_leaves_default():
    segs = [{"id": "s0", "speaker_id": "Speaker 1"}]
    _assign_default_profiles(segs, {}, {})
    assert "profile_id" not in segs[0] or not segs[0]["profile_id"]


# ── Part 2: generate-time resolution through the real dub_generate path ─────


class _RefCapturingModel:
    """Records the (ref_audio, ref_text) it was asked to clone from, per call,
    so the test can assert which reference the resolver picked."""

    sampling_rate = SR

    def __init__(self):
        self.refs: list[tuple] = []

    def generate(self, text=None, ref_audio=None, ref_text=None, **kwargs):
        self.refs.append((ref_audio, ref_text))
        # 0.5 s of audio per segment — short enough to always "fit".
        return [torch.full((1, int(0.5 * SR)), 0.1)]


@pytest.fixture
def patched_generate(monkeypatch, tmp_path):
    import api.routers.dub_generate as dg

    model = _RefCapturingModel()

    async def _fake_get_model():
        return model

    job = {
        "duration": 6.0,
        "dubbed_tracks": {},
        "speaker_clones": {
            "Speaker 1": {"ref_audio": "/v/spk1.wav", "ref_text": "spk1 ref"},
            "Speaker 2": {"ref_audio": "/v/spk2.wav", "ref_text": "spk2 ref"},
        },
        # Only seg id "0" has its own per-segment ref; "1" must fall back.
        "segment_clones": {
            "0": {"ref_audio": "/v/seg0.wav", "ref_text": "seg0 ref"},
        },
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
        req = DubRequest(**body)
        asyncio.run(dg.dub_generate("jobX", req))
        return model

    return run


def test_auto_speaker_prefers_per_segment_ref_then_falls_back(patched_generate):
    """seg0 has its own per-segment ref → use it; seg1 has none → per-speaker."""
    body = {
        "segments": [
            {"start": 0.0, "end": 3.0, "text": "hola", "profile_id": "auto:speaker_1"},
            {"start": 3.0, "end": 6.0, "text": "buenas", "profile_id": "auto:speaker_2"},
        ],
        "segment_ids": ["0", "1"],
        "language": "Auto",
        "language_code": "es",
        "num_step": 4,
        "timing_strategy": "concise",
    }
    model = patched_generate(body)
    assert len(model.refs) == 2
    # seg0: per-segment ref wins over Speaker 1's per-speaker clone.
    assert model.refs[0] == ("/v/seg0.wav", "seg0 ref")
    # seg1: no per-segment ref → Speaker 2's per-speaker clone.
    assert model.refs[1] == ("/v/spk2.wav", "spk2 ref")


def test_auto_speaker_uses_per_speaker_clone_when_no_segment_refs(patched_generate):
    """With no segment_clones at all, auto:{speaker} resolves to per-speaker."""
    body = {
        "segments": [
            {"start": 0.0, "end": 3.0, "text": "hola", "profile_id": "auto:speaker_1"},
        ],
        "segment_ids": ["99"],  # id not in segment_clones
        "language": "Auto",
        "language_code": "es",
        "num_step": 4,
        "timing_strategy": "concise",
    }
    model = patched_generate(body)
    assert model.refs[0] == ("/v/spk1.wav", "spk1 ref")
