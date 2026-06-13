"""Shared long-form render core (Stories + Audiobook convergence).

Pure builders for the chapterized mux: FFMETADATA (global tags + chapters),
concat list, loudness filter, cover validation, and the ffmpeg render argv.
All unit-testable without ffmpeg/torch/GPU.
"""
from __future__ import annotations

import pytest

from services.longform_render import (
    LOUDNESS_PRESETS,
    build_concat_list,
    build_ffmetadata,
    build_loudnorm_filter,
    build_render_cmd,
    chapter_cache_key,
    prune_cache_dir,
    validate_cover_image,
)


# ── loudness ────────────────────────────────────────────────────────────────

def test_loudnorm_acx_filter():
    f = build_loudnorm_filter("acx")
    assert f == "loudnorm=I=-19.0:TP=-3.0:LRA=11.0"


def test_loudnorm_podcast_filter():
    assert build_loudnorm_filter("podcast") == "loudnorm=I=-16.0:TP=-1.5:LRA=11.0"


def test_loudnorm_case_insensitive():
    assert build_loudnorm_filter("ACX") == build_loudnorm_filter("acx")


@pytest.mark.parametrize("val", [None, "", "off", "none", "bogus"])
def test_loudnorm_off_or_unknown_is_none(val):
    assert build_loudnorm_filter(val) is None


def test_loudness_presets_within_acx_window():
    # ACX wants integrated near -19 LUFS and a -3 dB peak ceiling.
    acx = LOUDNESS_PRESETS["acx"]
    assert -23.0 <= acx.i <= -18.0
    assert acx.tp == -3.0


# ── FFMETADATA ──────────────────────────────────────────────────────────────

def test_ffmetadata_chapters_only_matches_legacy_shape():
    doc = build_ffmetadata([("One", 1000), ("Two", 500)])
    assert doc.startswith(";FFMETADATA1\n")
    assert "[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=One" in doc
    assert "START=1000\nEND=1500\ntitle=Two" in doc
    # No global tags when none supplied.
    assert "artist=" not in doc


def test_ffmetadata_global_tags_mapped_and_ordered():
    doc = build_ffmetadata(
        [("Ch", 1000)],
        global_meta={
            "title": "My Book", "author": "Ada", "narrator": "Grace",
            "year": "2026", "genre": "Sci-Fi", "description": "A tale",
        },
    )
    # field → tag mapping (author→artist, narrator→composer, year→date,
    # description→comment) and stable order (title before artist).
    head = doc.split("[CHAPTER]")[0]
    assert head.index("title=My Book") < head.index("artist=Ada")
    assert "composer=Grace" in head
    assert "date=2026" in head
    assert "genre=Sci-Fi" in head
    assert "comment=A tale" in head


def test_ffmetadata_skips_empty_global_values():
    doc = build_ffmetadata([("Ch", 1)], global_meta={"title": "T", "author": "  ", "genre": None})
    head = doc.split("[CHAPTER]")[0]
    assert "title=T" in head
    assert "artist=" not in head   # whitespace-only dropped
    assert "genre=" not in head    # None dropped


def test_ffmetadata_escapes_special_chars():
    doc = build_ffmetadata([("a=b;c#d", 100)], global_meta={"title": "x=y"})
    assert r"title=x\=y" in doc
    assert r"title=a\=b\;c\#d" in doc


# ── concat list ─────────────────────────────────────────────────────────────

def test_concat_list_quotes_and_escapes():
    out = build_concat_list(["/a/one.wav", "/weird/it's here.wav"])
    assert "file '/a/one.wav'" in out
    assert "file '/weird/it'\\''s here.wav'" in out


# ── cover validation ────────────────────────────────────────────────────────

def test_cover_valid(tmp_path):
    p = tmp_path / "cover.jpg"
    p.write_bytes(b"\xff\xd8\xff" + b"x" * 100)
    assert validate_cover_image(str(p)) is True


def test_cover_rejects_missing_and_bad_type(tmp_path):
    assert validate_cover_image(None) is False
    assert validate_cover_image(str(tmp_path / "nope.jpg")) is False
    txt = tmp_path / "c.txt"
    txt.write_bytes(b"hi")
    assert validate_cover_image(str(txt)) is False


def test_cover_rejects_oversize(tmp_path):
    big = tmp_path / "big.png"
    big.write_bytes(b"\x89PNG" + b"0" * (8 * 1024 * 1024 + 1))
    assert validate_cover_image(str(big)) is False


def test_cover_rejects_empty(tmp_path):
    empty = tmp_path / "empty.jpg"
    empty.write_bytes(b"")
    assert validate_cover_image(str(empty)) is False


# ── render command ──────────────────────────────────────────────────────────

def test_render_cmd_m4b_default():
    cmd = build_render_cmd("ffmpeg", "concat.txt", "ch.ffmeta", "out.m4b")
    assert cmd[0] == "ffmpeg"
    assert "-f" in cmd and "concat" in cmd
    assert cmd[-3:] == ["-f", "mp4", "out.m4b"]
    assert "-c:a" in cmd and "aac" in cmd
    assert "+faststart" in cmd
    assert "-map_metadata" in cmd
    # no cover, no loudnorm by default
    assert "attached_pic" not in cmd
    assert "-af" not in cmd


def test_render_cmd_mp3_format():
    cmd = build_render_cmd("ffmpeg", "c.txt", "m.ffmeta", "out.mp3", fmt="mp3")
    assert "libmp3lame" in cmd
    assert cmd[-3:] == ["-f", "mp3", "out.mp3"]
    assert "+faststart" not in cmd


def test_render_cmd_bitrate_validation():
    ok = build_render_cmd("ffmpeg", "c", "m", "o", bitrate="192k")
    assert "192k" in ok
    bad = build_render_cmd("ffmpeg", "c", "m", "o", bitrate="; rm -rf /")
    assert "128k" in bad  # rejected → default
    assert "; rm -rf /" not in bad


def test_render_cmd_loudnorm_adds_af():
    cmd = build_render_cmd("ffmpeg", "c", "m", "o", loudness="acx")
    assert "-af" in cmd
    assert any(a.startswith("loudnorm=") for a in cmd)


def test_render_cmd_with_cover(tmp_path):
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff" + b"x" * 50)
    cmd = build_render_cmd("ffmpeg", "c", "m", "o.m4b", cover_path=str(cover))
    # cover becomes input 2, mapped as attached_pic, copied
    assert str(cover) in cmd
    assert "-map" in cmd and "2:v" in cmd
    assert "attached_pic" in cmd
    assert "-c:v" in cmd and "copy" in cmd


def test_render_cmd_drops_invalid_cover(tmp_path):
    cmd = build_render_cmd("ffmpeg", "c", "m", "o.m4b", cover_path=str(tmp_path / "missing.jpg"))
    assert "attached_pic" not in cmd  # silently dropped, render still proceeds


def test_render_cmd_mp3_never_embeds_cover(tmp_path):
    # A valid cover must NOT be wired into an MP3 (the attached_pic + -c:v copy
    # combo produces a corrupt mp3); m4b is the cover-bearing format.
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff" + b"x" * 50)
    cmd = build_render_cmd("ffmpeg", "c", "m", "o.mp3", fmt="mp3", cover_path=str(cover))
    assert "libmp3lame" in cmd
    assert "attached_pic" not in cmd
    assert str(cover) not in cmd
    assert "-c:v" not in cmd


# ── chapter cache key (resume) ──────────────────────────────────────────────

_SPANS = [(None, "Once upon a time.", 350), ("narrator", "The end.", 0)]


def test_cache_key_deterministic():
    a = chapter_cache_key(_SPANS, sample_rate=24000, engine_id="omnivoice")
    b = chapter_cache_key(list(_SPANS), sample_rate=24000, engine_id="omnivoice")
    assert a == b and len(a) == 20


@pytest.mark.parametrize("mutate", [
    lambda: chapter_cache_key([(None, "Different.", 350), ("narrator", "The end.", 0)],
                              sample_rate=24000, engine_id="omnivoice"),                       # text
    lambda: chapter_cache_key([("x", "Once upon a time.", 350), ("narrator", "The end.", 0)],
                              sample_rate=24000, engine_id="omnivoice"),                       # voice
    lambda: chapter_cache_key([(None, "Once upon a time.", 500), ("narrator", "The end.", 0)],
                              sample_rate=24000, engine_id="omnivoice"),                       # pause
    lambda: chapter_cache_key(list(reversed(_SPANS)), sample_rate=24000, engine_id="omnivoice"),  # order
    lambda: chapter_cache_key(_SPANS, sample_rate=44100, engine_id="omnivoice"),              # sr
    lambda: chapter_cache_key(_SPANS, sample_rate=24000, engine_id="kokoro"),                 # engine
    lambda: chapter_cache_key(_SPANS, sample_rate=24000, engine_id="omnivoice",
                              voice_sig={"narrator": "ref.wav|warm|7"}),                       # voice sig
    lambda: chapter_cache_key([(None, "Once upon a time.", 350, 0.8), ("narrator", "The end.", 0)],
                              sample_rate=24000, engine_id="omnivoice"),                       # speed
])
def test_cache_key_changes_on_any_input(mutate):
    base = chapter_cache_key(_SPANS, sample_rate=24000, engine_id="omnivoice")
    assert mutate() != base


def test_cache_key_voice_sig_order_irrelevant():
    a = chapter_cache_key(_SPANS, sample_rate=24000, engine_id="omnivoice",
                          voice_sig={"a": "1", "b": "2"})
    b = chapter_cache_key(_SPANS, sample_rate=24000, engine_id="omnivoice",
                          voice_sig={"b": "2", "a": "1"})
    assert a == b


# ── cache eviction ──────────────────────────────────────────────────────────

def _seed(tmp_path, name, size, age_s):
    import os, time
    p = tmp_path / name
    p.write_bytes(b"\0" * size)
    t = time.time() - age_s
    os.utime(p, (t, t))
    return p


def test_prune_cache_under_cap_is_noop(tmp_path):
    _seed(tmp_path, "a.wav", 100, 10)
    remaining, removed = prune_cache_dir(str(tmp_path), max_bytes=1000)
    assert removed == 0 and remaining == 100


def test_prune_cache_evicts_oldest_first(tmp_path):
    old = _seed(tmp_path, "old.wav", 600, age_s=100)   # oldest
    new = _seed(tmp_path, "new.wav", 600, age_s=1)      # newest
    remaining, removed = prune_cache_dir(str(tmp_path), max_bytes=1000)
    assert removed == 1
    assert not old.exists()      # oldest evicted
    assert new.exists()          # newest kept
    assert remaining <= 1000


def test_prune_cache_missing_dir_is_safe(tmp_path):
    assert prune_cache_dir(str(tmp_path / "nope")) == (0, 0)
