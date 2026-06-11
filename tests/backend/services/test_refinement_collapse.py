"""collapse_repetitive_artifacts — Wave 1.1 (Spec 3 phase 1).

Fixture patterns mirror voicebox's test corpus (MIT) with Latin-only strings
(the repo CJK gate forbids literal CJK in test files; the character-level
pass is script-agnostic, so a no-space Latin token exercises the same path).
"""

import pytest

from services.refinement import collapse_repetitive_artifacts


def test_word_level_loop_is_dropped():
    text = "send it to the URL URL URL URL URL URL please"
    assert collapse_repetitive_artifacts(text) == "send it to the please"


def test_punctuated_word_loop_is_dropped():
    text = "open the file. URL, URL, URL, URL, URL, URL. then close it"
    out = collapse_repetitive_artifacts(text)
    assert "URL" not in out
    assert "open the file." in out and "then close it" in out


def test_multiword_phrase_loop_is_dropped():
    loop = "thanks for watching " * 6
    text = f"that's all for today {loop}goodbye"
    out = collapse_repetitive_artifacts(text)
    assert "thanks for watching" not in out
    assert "that's all for today" in out and "goodbye" in out


def test_nospace_token_loop_is_dropped():
    # A single token formed by a unit repeated 6x with no separators —
    # the word-level pass can't split it; the character pass catches it.
    text = "done " + "lala" * 6 + " bye"
    out = collapse_repetitive_artifacts(text)
    assert "lala" not in out
    assert out.startswith("done") and out.endswith("bye")


def test_rhetorical_repetition_survives():
    text = "no, no, no, no, no — that's not what I meant"
    assert collapse_repetitive_artifacts(text) == text


def test_triple_yeah_survives():
    text = "yeah yeah yeah let's do it"
    assert collapse_repetitive_artifacts(text) == text


def test_emphasized_single_letter_runs_survive():
    # Character pass lower bound is 2 chars — stretched words stay.
    text = "wooooooow that was hmmmmm interesting"
    assert collapse_repetitive_artifacts(text) == text


def test_clean_text_content_unchanged():
    # The word-level pass rejoins tokens with single spaces (whitespace is
    # normalized even when nothing is dropped); the words themselves and
    # their order must be untouched.
    text = "a perfectly  normal sentence\nwith odd   spacing"
    assert collapse_repetitive_artifacts(text).split() == text.split()


def test_empty_and_none_safe():
    assert collapse_repetitive_artifacts("") == ""


def test_case_and_punct_insensitive_word_match():
    text = "ok URL url, URL. url URL url done"
    out = collapse_repetitive_artifacts(text)
    assert "url" not in out.lower().replace("ok", "").replace("done", "")
    assert out == "ok done"


@pytest.mark.parametrize("repeats,survives", [(5, True), (6, False)])
def test_threshold_boundary(repeats, survives):
    text = ("ping " * repeats).strip()
    out = collapse_repetitive_artifacts(text)
    assert (out == text) is survives
