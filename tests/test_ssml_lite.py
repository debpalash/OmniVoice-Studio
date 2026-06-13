"""SSML-LITE inline markup parser (PR 8).

Pure tests: every tag type, nesting, unclosed-to-EOL, plain text, mixed input,
stray closes, and the spell_out helper. No torch, no I/O, no main import.
"""
from __future__ import annotations

from services.ssml_lite import (
    EMPHASIS_SPEED,
    FAST_SPEED,
    SLOW_SPEED,
    parse_ssml_lite,
    spell_out,
)


def test_plain_text_single_segment():
    segs = parse_ssml_lite("just a plain line")
    assert segs == [
        {"text": "just a plain line", "speed": None, "spell": False, "emphasis": False}
    ]


def test_empty_and_none():
    assert parse_ssml_lite("") == []
    assert parse_ssml_lite(None) == []


def test_slow_tag():
    segs = parse_ssml_lite("a [slow]b[/slow] c")
    assert [s["text"] for s in segs] == ["a ", "b", " c"]
    assert segs[0]["speed"] is None
    assert segs[1]["speed"] == SLOW_SPEED
    assert segs[2]["speed"] is None


def test_fast_tag():
    segs = parse_ssml_lite("[fast]zoom[/fast]")
    assert len(segs) == 1
    assert segs[0]["text"] == "zoom"
    assert segs[0]["speed"] == FAST_SPEED
    assert segs[0]["spell"] is False


def test_emphasis_tag_sets_speed_and_flag():
    segs = parse_ssml_lite("[emphasis]wow[/emphasis]")
    assert segs[0]["speed"] == EMPHASIS_SPEED
    assert segs[0]["emphasis"] is True
    assert segs[0]["spell"] is False


def test_spell_tag_sets_flag_not_speed():
    segs = parse_ssml_lite("call [spell]NASA[/spell] now")
    middle = segs[1]
    assert middle["text"] == "NASA"
    assert middle["spell"] is True
    assert middle["speed"] is None


def test_nesting_innermost_speed_wins():
    # [fast] nested inside [slow] -> fast wins inside the inner run.
    segs = parse_ssml_lite("[slow]a[fast]b[/fast]c[/slow]")
    by_text = {s["text"]: s for s in segs}
    assert by_text["a"]["speed"] == SLOW_SPEED
    assert by_text["b"]["speed"] == FAST_SPEED
    assert by_text["c"]["speed"] == SLOW_SPEED


def test_nesting_spell_inside_slow_keeps_both():
    segs = parse_ssml_lite("[slow]x[spell]Y[/spell]z[/slow]")
    by_text = {s["text"]: s for s in segs}
    assert by_text["Y"]["speed"] == SLOW_SPEED  # outer slow still applies
    assert by_text["Y"]["spell"] is True
    assert by_text["x"]["spell"] is False
    assert by_text["z"]["spell"] is False


def test_unclosed_applies_to_eol():
    segs = parse_ssml_lite("start [slow]rest of line")
    assert segs[0]["text"] == "start "
    assert segs[0]["speed"] is None
    assert segs[1]["text"] == "rest of line"
    assert segs[1]["speed"] == SLOW_SPEED


def test_unclosed_nested_both_to_eol():
    segs = parse_ssml_lite("[slow]a[spell]b")
    by_text = {s["text"]: s for s in segs}
    assert by_text["a"]["speed"] == SLOW_SPEED and by_text["a"]["spell"] is False
    assert by_text["b"]["speed"] == SLOW_SPEED and by_text["b"]["spell"] is True


def test_stray_close_ignored():
    segs = parse_ssml_lite("hello[/slow]world")
    # Markers stripped; the two plain runs merge into one segment.
    assert segs == [
        {"text": "helloworld", "speed": None, "spell": False, "emphasis": False}
    ]


def test_only_markers_yields_no_segments():
    assert parse_ssml_lite("[slow][/slow]") == []


def test_mixed_tags_in_one_line():
    segs = parse_ssml_lite("Say [slow]hi[/slow] then [fast]bye[/fast]!")
    texts = [s["text"] for s in segs]
    assert texts == ["Say ", "hi", " then ", "bye", "!"]
    assert segs[1]["speed"] == SLOW_SPEED
    assert segs[3]["speed"] == FAST_SPEED
    assert segs[0]["speed"] is None and segs[4]["speed"] is None


def test_adjacent_plain_runs_merge():
    # Open+immediate-close around nothing, surrounded by text -> single seg.
    segs = parse_ssml_lite("foo[slow][/slow]bar")
    assert segs == [
        {"text": "foobar", "speed": None, "spell": False, "emphasis": False}
    ]


def test_case_insensitive_tags():
    segs = parse_ssml_lite("[SLOW]x[/Slow]")
    assert segs[0]["speed"] == SLOW_SPEED


def test_spell_out_basic():
    assert spell_out("USA") == "U S A"
    assert spell_out("a") == "a"


def test_spell_out_strips_and_joins_whitespace():
    assert spell_out("  hi  ") == "h i"
    assert spell_out("go USA") == "g o U S A"
    assert spell_out("") == ""


def test_redos_safe_on_adversarial_input():
    # Many bracket-like fragments must not blow up (linear-time guarantee).
    import time

    payload = "[slow]" * 5000 + "x"
    t0 = time.perf_counter()
    segs = parse_ssml_lite(payload)
    assert time.perf_counter() - t0 < 1.0
    # All 5000 opens unclosed -> the single 'x' run is slow.
    assert segs[-1]["text"] == "x"
    assert segs[-1]["speed"] == SLOW_SPEED
