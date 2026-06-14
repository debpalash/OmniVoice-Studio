"""#34 runtime-verify — Layer 1 e2e for the longform chapterized renderer.

Drives the REAL `_render_longform_sse` generator and REAL ffmpeg, but injects a
stub synth (a CPU tone) so no GPU/model is needed. Proves the SSE event
sequence AND that ffmpeg actually muxes a playable, chapter-tagged file — the
cheap regression net over the audiobook/stories convergence (#21-era work).

Gated on ffmpeg being present so it's a no-op on a runner without it; it MUST
run in CI (where ffmpeg is installed). Exercises the non-happy states too:
empty plan, no-ffmpeg, per-chapter partial failure, total failure.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess

import pytest
import torch

from services.ffmpeg_utils import find_ffmpeg

pytestmark = pytest.mark.skipif(
    find_ffmpeg() is None, reason="ffmpeg required for the longform e2e",
)

_FFPROBE = shutil.which("ffprobe")


# ── stubs + drivers ─────────────────────────────────────────────────────────

def _resolve(_voice_id):
    # The four keys the chapter-signature build reads (audiobook.py).
    return {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}


def _stub_build_synth(*, fail_on=None):
    """Return a drop-in for `audiobook._build_synth` whose `synth` emits 0.1s of
    silence per span. `fail_on(text)` → raise, to exercise per-chapter faults."""
    def _factory(default_voice=None):
        def synth(text, voice_id, speed=None):
            if fail_on is not None and fail_on(text):
                raise RuntimeError("stub synth deliberately failed")
            return torch.zeros(2400)  # 0.1s @ 24k, 1-D float32
        return {"mode": "generic", "resolve": _resolve, "engine_id": "stub",
                "synth": synth, "sample_rate": 24000}
    return _factory


def _plan(*chapters):
    """chapters: (title, body) pairs → AudiobookPlan."""
    from services.audiobook import AudiobookPlan, Chapter, Span
    return AudiobookPlan(chapters=[
        Chapter(title=title, spans=[Span(voice_id=None, text=body)])
        for title, body in chapters
    ])


def _collect_events(plan, monkeypatch, outputs_dir, *, fail_on=None, **kw):
    """Patch the synth + OUTPUTS_DIR, drive the real generator, return parsed
    SSE events (list of dicts)."""
    from api.routers import audiobook
    monkeypatch.setattr(audiobook, "_build_synth", _stub_build_synth(fail_on=fail_on))
    monkeypatch.setattr("core.config.OUTPUTS_DIR", str(outputs_dir))

    async def _run():
        out = []
        async for frame in audiobook._render_longform_sse(plan, default_voice=None, **kw):
            assert frame.startswith("data:") and frame.endswith("\n\n")
            out.append(json.loads(frame[len("data:"):].strip()))
        return out

    return asyncio.run(_run())


def _ffprobe(path):
    assert _FFPROBE, "ffprobe not found"
    out = subprocess.run(
        [_FFPROBE, "-v", "quiet", "-print_format", "json",
         "-show_format", "-show_streams", "-show_chapters", path],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


# ── happy paths ─────────────────────────────────────────────────────────────

def test_m4b_two_chapters_muxes_and_emits_full_sequence(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    events = _collect_events(
        _plan(("One", "Hello world."), ("Two", "Second chapter.")),
        monkeypatch, out, fmt="m4b",
    )
    types = [e["type"] for e in events]
    assert types == ["started", "chapter", "chapter", "assembling", "done"]
    done = events[-1]
    assert done["chapters"] == 2 and done["failed_chapters"] == []

    out_path = out / done["output"]
    assert out_path.exists()
    if _FFPROBE:
        probe = _ffprobe(str(out_path))
        assert "mp4" in probe["format"]["format_name"]
        assert len(probe.get("chapters", [])) == 2  # both chapters tagged


def test_mp3_format_produces_mp3_container(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    events = _collect_events(_plan(("One", "Hi.")), monkeypatch, out, fmt="mp3")
    done = events[-1]
    assert done["type"] == "done"
    out_path = out / done["output"]
    assert out_path.suffix == ".mp3" and out_path.exists()
    if _FFPROBE:
        assert "mp3" in _ffprobe(str(out_path))["format"]["format_name"]


# ── partial / total failure ─────────────────────────────────────────────────

def test_partial_failure_isolates_bad_chapter(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    # Fail only the first chapter's text.
    events = _collect_events(
        _plan(("Bad", "FAILME please"), ("Good", "this one is fine")),
        monkeypatch, out, fmt="m4b", fail_on=lambda t: "FAILME" in t,
    )
    types = [e["type"] for e in events]
    assert "chapter_error" in types and "done" in types
    err = next(e for e in events if e["type"] == "chapter_error")
    assert err["index"] == 0
    done = events[-1]
    assert done["chapters"] == 1 and done["failed_chapters"] == [0]
    assert (out / done["output"]).exists()  # the surviving chapter still muxed


def test_all_chapters_fail_emits_error_and_no_file(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    events = _collect_events(
        _plan(("A", "x"), ("B", "y")), monkeypatch, out,
        fmt="m4b", fail_on=lambda t: True,
    )
    assert events[-1] == {"type": "error", "error": "all chapters failed to render"}
    # No output file was produced.
    assert not any(p.suffix in (".m4b", ".mp3") for p in out.iterdir())


# ── degenerate / environment ────────────────────────────────────────────────

def test_empty_plan_errors_cleanly(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    events = _collect_events(_plan(), monkeypatch, out)
    assert events == [{"type": "error", "error": "nothing to render (no chapters)"}]


def test_no_ffmpeg_errors_before_synth(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    # Force the no-ffmpeg branch even though the suite is gated on ffmpeg present.
    monkeypatch.setattr("services.ffmpeg_utils.find_ffmpeg", lambda: None)
    events = _collect_events(_plan(("One", "hi")), monkeypatch, out)
    assert events[-1]["type"] == "error" and "ffmpeg" in events[-1]["error"]
    assert not list(p for p in out.iterdir() if p.is_file())


def test_acx_emits_mastering_event_and_loudness_block(tmp_path, monkeypatch):
    """#28: a known loudness preset fires a `mastering` event and adds a
    `loudness` block to `done` (two-pass on real signal; silent stub → fallback,
    two_pass False — either way the wiring + event shape are exercised)."""
    out = tmp_path / "outputs"
    out.mkdir()
    events = _collect_events(_plan(("One", "hi")), monkeypatch, out, fmt="m4b", loudness="acx")
    types = [e["type"] for e in events]
    assert "mastering" in types
    done = events[-1]
    assert done["type"] == "done"
    assert done["loudness"]["preset"] == "acx"
    assert "two_pass" in done["loudness"]


def test_off_path_emits_no_loudness_block(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    events = _collect_events(_plan(("One", "hi")), monkeypatch, out, fmt="m4b")  # no loudness
    assert "mastering" not in [e["type"] for e in events]
    assert "loudness" not in events[-1]  # legacy done shape preserved
