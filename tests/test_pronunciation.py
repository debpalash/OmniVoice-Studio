"""Pronunciation lexicon core (longform render, PR 8).

Pure tests for the whole-word, case-insensitive respelling matcher plus the
JSON round-trip. No torch, no engine, no GPU.
"""
from __future__ import annotations

import json

import pytest
from services.pronunciation import (
    apply_lexicon,
    load_lexicon,
    normalize_lexicon,
    save_lexicon,
)


# ── apply_lexicon: whole-word replace ────────────────────────────────────────

def test_whole_word_replace():
    assert apply_lexicon("I love GIF files", {"GIF": "jiff"}) == "I love jiff files"


def test_case_insensitive_match():
    lex = {"OmniVoice": "Omni Voice"}
    assert apply_lexicon("omnivoice rocks", lex) == "Omni Voice rocks"
    assert apply_lexicon("OMNIVOICE rocks", lex) == "Omni Voice rocks"
    assert apply_lexicon("OmniVoice rocks", lex) == "Omni Voice rocks"


def test_no_partial_word_replacement():
    # "cat" must not touch "category" / "scatter".
    assert apply_lexicon("category scatter cat", {"cat": "feline"}) == \
        "category scatter feline"


def test_punctuation_adjacency_trailing():
    # "smith," — trailing comma preserved, word still matched.
    assert apply_lexicon("Hello smith, hi", {"Smith": "Smyth"}) == "Hello Smyth, hi"


def test_punctuation_adjacency_period_key():
    # Key with an internal/edge period: "Dr." should match before a space.
    out = apply_lexicon("See Dr. Jones", {"Dr.": "Doctor"})
    assert out == "See Doctor Jones"


def test_longest_match_first():
    lex = {"Dr": "Doctor", "Dr. Smith": "Doctor Smith the third"}
    # The longer key must win over the shorter overlapping one.
    assert apply_lexicon("Call Dr. Smith now", lex) == "Call Doctor Smith the third now"


def test_multiple_replacements_in_one_pass():
    lex = {"GIF": "jiff", "SQL": "sequel"}
    assert apply_lexicon("GIF and SQL", lex) == "jiff and sequel"


def test_empty_text_and_empty_lexicon():
    assert apply_lexicon("", {"a": "b"}) == ""
    assert apply_lexicon(None, {"a": "b"}) == ""
    assert apply_lexicon("unchanged text", {}) == "unchanged text"
    assert apply_lexicon("unchanged text", None) == "unchanged text"


def test_idempotence_when_no_key_in_output():
    lex = {"GIF": "jiff"}
    once = apply_lexicon("a GIF here", lex)
    twice = apply_lexicon(once, lex)
    assert once == twice == "a jiff here"


def test_respelling_not_rescanned_in_single_pass():
    # If a value contains another key, a single pass must NOT re-expand it.
    lex = {"NY": "New York", "York": "Yorkshire"}
    # "NY" -> "New York"; the produced "York" is part of the substituted
    # text and must not be re-matched within the same pass.
    assert apply_lexicon("from NY today", lex) == "from New York today"


def test_unicode_word_boundary():
    lex = {"café": "kaffey"}
    assert apply_lexicon("a café here", lex) == "a kaffey here"
    # Must not partial-match inside a longer token.
    assert apply_lexicon("cafés plural", lex) == "cafés plural"


def test_value_may_be_empty_to_delete_word():
    assert apply_lexicon("the [marker] gone", {"[marker]": ""}) == "the  gone"


# ── normalize_lexicon ────────────────────────────────────────────────────────

def test_normalize_drops_empty_keys():
    lex = {"": "x", "  ": "y", "ok": "v", None: "z"}
    assert normalize_lexicon(lex) == {"ok": "v"}


def test_normalize_strips_keys_and_coerces_values():
    assert normalize_lexicon({"  Dr  ": "Doctor", "n": None}) == {"Dr": "Doctor", "n": ""}


def test_normalize_non_dict():
    assert normalize_lexicon(None) == {}
    assert normalize_lexicon(["a", "b"]) == {}


# ── load / save round-trip ───────────────────────────────────────────────────

def test_save_and_load_round_trip(tmp_path):
    path = tmp_path / "sub" / "lexicon.json"
    written = save_lexicon(str(path), {"  GIF ": "jiff", "": "skip"})
    assert written == {"GIF": "jiff"}
    assert path.is_file()
    assert load_lexicon(str(path)) == {"GIF": "jiff"}


def test_load_missing_or_empty(tmp_path):
    assert load_lexicon(str(tmp_path / "nope.json")) == {}
    empty = tmp_path / "empty.json"
    empty.write_text("   ", encoding="utf-8")
    assert load_lexicon(str(empty)) == {}


def test_load_non_object_json(tmp_path):
    p = tmp_path / "arr.json"
    p.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    assert load_lexicon(str(p)) == {}


def test_load_normalizes(tmp_path):
    p = tmp_path / "lex.json"
    p.write_text(json.dumps({"  Dr  ": "Doctor", "": "x"}), encoding="utf-8")
    assert load_lexicon(str(p)) == {"Dr": "Doctor"}
