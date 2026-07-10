"""Per-chapter preview endpoint + the resume cache-hit path.

Validation cases call the handler directly (no synth reached). The cache-hit
test exercises ``_render_chapter_cached`` with a pre-seeded WAV so it returns
the cached chapter without ever invoking synth (no torch/GPU).
"""
from __future__ import annotations

import asyncio
import wave

import pytest
from fastapi import HTTPException

from api.routers.audiobook import (
    AudiobookPreviewRequest,
    _render_chapter_cached,
    audiobook_preview,
)
from services.audiobook import Chapter, Span
from services.longform_render import chapter_cache_key


def test_preview_rejects_empty_script():
    with pytest.raises(HTTPException) as ei:
        asyncio.run(audiobook_preview(AudiobookPreviewRequest(text="", chapter_index=0)))
    assert ei.value.status_code == 400


def test_preview_rejects_out_of_range_index():
    with pytest.raises(HTTPException) as ei:
        asyncio.run(audiobook_preview(AudiobookPreviewRequest(text="# A\nhello", chapter_index=5)))
    assert ei.value.status_code == 400


def _write_wav(path, sr=24000, frames=2400):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * frames)


def test_render_chapter_cache_hit_skips_synth(tmp_path):
    sr = 24000
    chapter = Chapter(title="C1", spans=[Span(voice_id=None, text="hi", pause_ms_after=0)])
    resolve = lambda _vid: {"ref_audio": None, "instruct": None, "seed": None}  # noqa: E731

    # Pre-seed the cache at the exact key this chapter will hash to. The voice
    # signature is ref_audio|ref_text|instruct|seed (all None here).
    sig = {"": "None|None|None|None"}
    key = chapter_cache_key([(None, "hi", 0, None)], sample_rate=sr, engine_id="eng", voice_sig=sig)
    _write_wav(tmp_path / f"{key}.wav", sr=sr, frames=sr // 2)  # 0.5 s

    def boom(*_a, **_k):
        raise AssertionError("synth must not be called on a cache hit")

    wav_path, dur, cached, seg_stats = _render_chapter_cached(chapter, boom, sr, "eng", resolve, str(tmp_path))
    assert cached is True
    assert seg_stats is None  # chapter-level hit — the segment layer untouched
    assert wav_path.endswith(f"{key}.wav")
    assert abs(dur - 0.5) < 0.01
