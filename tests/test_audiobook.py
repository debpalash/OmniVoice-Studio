"""Audiobook creator core (parity Wave 5).

Pure tests for the parser + ffmpeg builders, plus a stub-backend test of the
synthesis orchestration (torch, but no model / GPU / main import).
"""
from __future__ import annotations

import pytest

from services.audiobook import (
    AudiobookPlan,
    build_chapter_ffmetadata,
    build_concat_list,
    build_m4b_cmd,
    parse_audiobook_script,
    synthesize_chapter,
)


# ── Parser ───────────────────────────────────────────────────────────────────

def test_no_headings_single_chapter():
    plan = parse_audiobook_script("Hello world. This is a test.")
    assert isinstance(plan, AudiobookPlan)
    assert len(plan.chapters) == 1
    assert plan.chapters[0].title == "Chapter 1"
    assert plan.chapters[0].spans[0].text == "Hello world. This is a test."


def test_h1_headings_become_chapters():
    plan = parse_audiobook_script("# Prologue\nOnce upon a time.\n# Chapter One\nThe end.")
    assert [c.title for c in plan.chapters] == ["Prologue", "Chapter One"]
    assert plan.chapters[0].spans[0].text == "Once upon a time."
    assert plan.chapters[1].spans[0].text == "The end."


def test_intro_before_first_heading_is_untitled_chapter():
    plan = parse_audiobook_script("Front matter.\n# Real Chapter\nBody.")
    assert plan.chapters[0].title == "Chapter 1"      # synthesised title
    assert plan.chapters[0].spans[0].text == "Front matter."
    assert plan.chapters[1].title == "Real Chapter"


def test_voice_tag_switches_narrator():
    plan = parse_audiobook_script("Narrator speaks. [voice:alice]Alice speaks.", default_voice="narrator")
    spans = plan.chapters[0].spans
    assert spans[0].voice_id == "narrator"
    assert spans[0].text == "Narrator speaks."
    assert spans[1].voice_id == "alice"
    assert spans[1].text == "Alice speaks."


def test_default_voice_applied_without_tag():
    plan = parse_audiobook_script("Just text.", default_voice="bob")
    assert plan.chapters[0].spans[0].voice_id == "bob"


def test_pause_marker_delegated():
    plan = parse_audiobook_script("Before. [pause 500ms] After.")
    spans = plan.chapters[0].spans
    assert spans[0].text == "Before."
    assert spans[0].pause_ms_after == 500
    assert spans[1].text == "After."
    assert spans[1].pause_ms_after == 0


def test_empty_chapters_dropped():
    plan = parse_audiobook_script("# Empty\n   \n# Real\nWords.")
    assert [c.title for c in plan.chapters] == ["Real"]


def test_plan_to_dict_shape():
    d = parse_audiobook_script("# A\nHi there.").to_dict()
    assert d["chapter_count"] == 1
    assert d["char_count"] == len("Hi there.")
    assert d["chapters"][0]["spans"][0]["text"] == "Hi there."


def test_plan_chapter_count_property():
    # Regression for #543: the /audiobook/import endpoint reads plan.chapter_count
    # directly (not via to_dict), so the attribute must exist and stay in lockstep
    # with the serialized key.
    plan = parse_audiobook_script("# A\nHi.\n# B\nBye.")
    assert plan.chapter_count == 2
    assert plan.chapter_count == plan.to_dict()["chapter_count"]


# ── FFMETADATA ───────────────────────────────────────────────────────────────

def test_ffmetadata_cumulative_offsets():
    meta = build_chapter_ffmetadata([("Intro", 1000), ("Chapter 1", 2500)])
    assert meta.startswith(";FFMETADATA1\n")
    assert "TIMEBASE=1/1000" in meta
    # First chapter 0..1000, second 1000..3500.
    assert "START=0\nEND=1000\ntitle=Intro" in meta
    assert "START=1000\nEND=3500\ntitle=Chapter 1" in meta


def test_ffmetadata_escapes_special_chars():
    meta = build_chapter_ffmetadata([("A=B; C#1", 100)])
    assert r"title=A\=B\; C\#1" in meta


# ── m4b argv ─────────────────────────────────────────────────────────────────

def test_m4b_cmd_shape():
    cmd = build_m4b_cmd("ffmpeg", "list.txt", "meta.txt", "out.m4b", bitrate="192k")
    assert cmd[0] == "ffmpeg"
    assert "-f" in cmd and "concat" in cmd
    assert cmd[cmd.index("-map_metadata") + 1] == "1"
    assert cmd[cmd.index("-b:a") + 1] == "192k"
    assert "+faststart" in cmd
    assert cmd[-1] == "out.m4b"


def test_m4b_cmd_rejects_bad_bitrate():
    cmd = build_m4b_cmd("ffmpeg", "l", "m", "o", bitrate="; rm -rf /")
    assert cmd[cmd.index("-b:a") + 1] == "128k"   # falls back, no injection


def test_concat_list_format_and_escaping():
    out = build_concat_list(["/a/ch0.wav", "/weird/it's here.wav"])
    lines = out.strip().split("\n")
    assert lines[0] == "file '/a/ch0.wav'"
    # Single quote escaped the ffmpeg way: ' -> '\''
    assert lines[1] == r"file '/weird/it'\''s here.wav'"


# ── Orchestration (stub synth) ───────────────────────────────────────────────

def test_synthesize_chapter_stitches_spans_and_silence():
    torch = pytest.importorskip("torch")
    sr = 16000
    calls = []

    def synth(text, voice_id, speed=None):
        calls.append((text, voice_id, speed))
        return torch.ones(1000, dtype=torch.float32)  # 1000 samples per chunk

    plan = parse_audiobook_script("First. [pause 1s] Second.", default_voice="v")
    audio, dur = synthesize_chapter(plan.chapters[0].spans, synth, sr)
    # Two text spans (1000 each) + 1 s silence (16000) = 18000 samples.
    assert audio.shape[-1] == 1000 + sr + 1000
    assert dur == pytest.approx((2000 + sr) / sr)
    assert [c[1] for c in calls] == ["v", "v"]  # voice threaded to synth


def test_synthesize_empty_spans_is_silent():
    torch = pytest.importorskip("torch")
    audio, dur = synthesize_chapter([], lambda t, v, s=None: torch.ones(10), 16000)
    assert audio.shape[-1] == 0
    assert dur == 0.0


def test_synthesize_chapter_2d_engine_output_with_pause():
    # #897 regression: real engines return (1, samples) (TTSBackend contract)
    # while inter-span pause silence was built as 1-D zeros — the final hard
    # concat crashed a longform chapter render with
    # "RuntimeError: Tensors must have same number of dimensions: got 1 and 2".
    torch = pytest.importorskip("torch")
    sr = 16000

    def synth(text, voice_id, speed=None):
        return torch.ones(1, 1000, dtype=torch.float32)

    plan = parse_audiobook_script("First. [pause 1s] Second.", default_voice="v")
    audio, dur = synthesize_chapter(plan.chapters[0].spans, synth, sr)
    assert audio.shape == (1, 1000 + sr + 1000)
    assert dur == pytest.approx((2000 + sr) / sr)


def test_synthesize_chapter_silence_rank_matches_engine_output(monkeypatch):
    # The producer half of the #897 fix: pause silence is materialized with
    # the rendered audio's rank, so the parts reaching the final concat are
    # rank-homogeneous even without concatenate_audio_chunks' normalization.
    torch = pytest.importorskip("torch")
    import services.chunked_tts as ct

    seen: list[list[int]] = []
    real = ct.concatenate_audio_chunks

    def spy(chunks, sr, crossfade_ms=50):
        seen.append([c.dim() for c in chunks])
        return real(chunks, sr, crossfade_ms=crossfade_ms)

    monkeypatch.setattr(ct, "concatenate_audio_chunks", spy)
    plan = parse_audiobook_script("First. [pause 500ms] Second.", default_voice="v")
    synthesize_chapter(plan.chapters[0].spans,
                       lambda t, v, s=None: torch.ones(1, 100), 16000)
    assert seen, "the stitcher never reached the concat"
    assert all(d == 2 for dims in seen for d in dims)


def test_parse_applies_ssml_lite_prosody():
    plan = parse_audiobook_script("[slow]hush[/slow] normal [spell]USA[/spell]")
    spans = plan.chapters[0].spans
    by_text = {s.text: s for s in spans}
    assert by_text["hush"].speed == 0.85       # [slow] → slower rate
    assert by_text["normal"].speed is None     # plain → engine default
    assert "U S A" in by_text                   # [spell] spaces the letters


def test_synthesize_chapter_applies_lexicon():
    torch = pytest.importorskip("torch")
    seen = []

    def synth(text, voice_id, speed=None):
        seen.append(text)
        return torch.ones(100, dtype=torch.float32)

    plan = parse_audiobook_script("Meet Dr Smith.", default_voice="v")
    synthesize_chapter(plan.chapters[0].spans, synth, 16000, lexicon={"Dr": "Doctor"})
    # The engine sees the respelled text, never the original "Dr".
    assert any("Doctor" in t for t in seen)
    assert not any("Dr " in t or t.endswith(" Dr") for t in seen)
