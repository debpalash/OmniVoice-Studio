"""#281 — re-dub must honor transcript edits.

Root cause: the per-segment fingerprint stored after a generate run was
computed from the pydantic-parsed request (defaults filled in: `instruct=""`,
`profile_id=""`, `effect_preset="broadcast"`, `direction` silently dropped),
while the frontend recomputed it from raw editor state (unset keys omitted,
`preset:` voices unexpanded). The two representations never hashed the same,
so after every run EVERY segment was reported "changed" — a 1-line edit
re-dubbed all N lines, and the incremental plan was useless.

Covers:
  - fingerprint parity between the server-side (pydantic) view and the
    client-side (raw dict) view of the same logical segment;
  - back-compat: hashes stored by previous builds still match;
  - `DubSegment.direction` is a real schema field (was silently dropped);
  - end-to-end regen with a mocked TTS engine: an edited line produces a
    DIFFERENT cached seg WAV, an untouched line's cached WAV is reused
    byte-for-byte.
"""
from __future__ import annotations

import os
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import asyncio
import hashlib
import json

import pytest
import torch

from services import incremental
from schemas.requests import DubRequest, DubSegment


fp = incremental.segment_fingerprint


# ── Fingerprint parity (server-side vs client-side payload shapes) ─────────


def _server_view(seg: DubSegment) -> dict:
    """What dub_generate hashes: pydantic-parsed segment, defaults filled."""
    return {
        "text": seg.text,
        "target_lang": seg.target_lang,
        "profile_id": seg.profile_id,
        "instruct": seg.instruct,
        "speed": seg.speed,
        "direction": seg.direction,
        "effect_preset": seg.effect_preset,
    }


def test_parity_minimal_segment():
    """A segment with only text set must hash identically whether it went
    through pydantic (defaults filled in) or came raw from the editor."""
    server = _server_view(DubSegment(start=0.0, end=1.0, text="Hola"))
    client = {"text": "Hola"}  # frontend omits unset keys
    assert fp(server) == fp(client)


def test_parity_with_null_and_empty_string_defaults():
    server = _server_view(DubSegment(start=0.0, end=1.0, text="Hola"))
    client = {
        "text": "Hola",
        "target_lang": None,
        "profile_id": "",
        "instruct": "",
        "speed": None,
        "direction": None,
    }
    assert fp(server) == fp(client)


def test_parity_int_vs_float_speed():
    """JS sends `speed: 1`, pydantic parses `1.0` — same fingerprint."""
    assert fp({"text": "x", "speed": 1}) == fp({"text": "x", "speed": 1.0})


def test_effect_preset_change_is_still_detected():
    """Canonicalisation must not erase real preset changes."""
    assert fp({"text": "x", "effect_preset": "cinematic"}) != fp({"text": "x"})
    assert fp({"text": "x", "effect_preset": "broadcast"}) == fp({"text": "x"})


def test_backcompat_with_hashes_stored_by_previous_builds():
    """Old builds hashed `{field: value or ""}` with pydantic defaults
    (effect_preset="broadcast"). Stored seg_hashes in existing
    omnivoice_data/ projects must stay valid for unchanged segments."""
    legacy_payload = {
        "text": "Hola", "target_lang": "", "profile_id": "", "instruct": "",
        "speed": "", "direction": "", "effect_preset": "broadcast",
    }
    legacy_hash = hashlib.sha1(
        json.dumps(legacy_payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    assert fp({"text": "Hola"}) == legacy_hash


def test_one_edit_marks_exactly_one_segment_stale():
    """The #281 scenario: generate stored server-side hashes; the editor
    recomputes with client-side payloads; ONE text edit → ONE stale line."""
    server_segs = [
        DubSegment(start=0.0, end=1.0, text="Line one"),
        DubSegment(start=1.0, end=2.0, text="Line two"),
        DubSegment(start=2.0, end=3.0, text="Line three"),
    ]
    stored = {str(i): fp(_server_view(s)) for i, s in enumerate(server_segs)}

    client_segs = [
        {"id": "0", "text": "Line one"},
        {"id": "1", "text": "Line two EDITED"},
        {"id": "2", "text": "Line three"},
    ]
    plan = incremental.plan_incremental(client_segs, stored_hashes=stored)
    assert plan["stale"] == ["1"]
    assert plan["fresh"] == ["0", "2"]


# ── DubSegment.direction (was silently dropped by pydantic) ────────────────


def test_dubsegment_accepts_direction():
    seg = DubSegment(start=0.0, end=1.0, text="hi", direction="urgent, whispered")
    assert seg.direction == "urgent, whispered"
    # default stays None so old payloads parse unchanged
    assert DubSegment(start=0.0, end=1.0, text="hi").direction is None


def test_direction_change_flips_fingerprint():
    base = _server_view(DubSegment(start=0.0, end=1.0, text="hi"))
    directed = _server_view(DubSegment(start=0.0, end=1.0, text="hi", direction="urgent"))
    assert fp(base) != fp(directed)


# ── End-to-end regen with a mocked TTS engine ──────────────────────────────


class _FakeModel:
    """Deterministic 'TTS engine': output amplitude depends on the text, so
    a text edit provably changes the rendered audio bytes."""

    sampling_rate = 24000

    def __init__(self):
        self.calls: list[str] = []

    def generate(self, text=None, **kwargs):
        self.calls.append(text)
        h = int(hashlib.sha1(text.encode("utf-8")).hexdigest()[:8], 16)
        val = 0.1 + (h % 1000) / 2000.0
        n = int(0.5 * self.sampling_rate)
        return [torch.full((1, n), val)]


@pytest.fixture
def patched_generate(monkeypatch, tmp_path):
    """Patch api.routers.dub_generate so `_stream` runs hermetically:
    fake model, no DB, no watermark/DSP, WAVs under tmp_path."""
    import api.routers.dub_generate as dg

    model = _FakeModel()

    async def _fake_get_model():
        return model

    job = {
        "duration": 2.0,
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


def test_edited_line_produces_different_cached_output(patched_generate):
    run, model, job, job_dir = patched_generate

    segs = [
        {"start": 0.0, "end": 1.0, "text": "Buenos dias"},
        {"start": 1.0, "end": 2.0, "text": "Hasta luego"},
    ]

    # ── First full run: both lines rendered, hashes stored ──
    parsed = run(_body(segs))
    done = [p for p in parsed if p.get("type") == "done"]
    assert done, f"no done event in {parsed}"
    seg_hashes = done[0]["seg_hashes"]
    assert set(seg_hashes) == {"0", "1"}
    assert model.calls == ["Buenos dias", "Hasta luego"]

    wav0_v1 = (job_dir / "seg_0.wav").read_bytes()
    wav1_v1 = (job_dir / "seg_1.wav").read_bytes()

    # ── User edits line 0; client-side recompute marks ONLY it stale ──
    edited = [
        {"start": 0.0, "end": 1.0, "text": "Buenas noches"},
        {"start": 1.0, "end": 2.0, "text": "Hasta luego"},
    ]
    plan = incremental.plan_incremental(
        [{"id": "0", "text": "Buenas noches"}, {"id": "1", "text": "Hasta luego"}],
        stored_hashes=seg_hashes,
    )
    assert plan["stale"] == ["0"]
    assert plan["fresh"] == ["1"]

    # ── Regen only the stale line ──
    model.calls.clear()
    parsed = run(_body(edited, regen_only=plan["stale"]))
    done = [p for p in parsed if p.get("type") == "done"]
    assert done, f"no done event in {parsed}"

    # TTS ran exactly once, with the edited text
    assert model.calls == ["Buenas noches"]

    wav0_v2 = (job_dir / "seg_0.wav").read_bytes()
    wav1_v2 = (job_dir / "seg_1.wav").read_bytes()
    # the edited line's cached audio changed…
    assert wav0_v2 != wav0_v1
    # …and the untouched line's cached audio was reused as-is
    assert wav1_v2 == wav1_v1

    # stored hash for the edited line was refreshed to the new content
    new_hashes = done[0]["seg_hashes"]
    assert new_hashes["0"] != seg_hashes["0"]
    assert new_hashes["1"] == seg_hashes["1"]

    # the final dubbed track was rebuilt
    assert (job_dir / "dubbed_es.wav").exists()


def test_full_rerun_rerenders_edited_text(patched_generate):
    """Plain 'Generate Dub' (no regen_only) must always use the new text."""
    run, model, job, job_dir = patched_generate

    run(_body([{"start": 0.0, "end": 1.0, "text": "primero"}]))
    first = (job_dir / "seg_0.wav").read_bytes()

    run(_body([{"start": 0.0, "end": 1.0, "text": "segundo"}]))
    second = (job_dir / "seg_0.wav").read_bytes()

    assert model.calls == ["primero", "segundo"]
    assert first != second
