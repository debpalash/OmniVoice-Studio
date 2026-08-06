"""A chunk with nothing to say must never reach an engine (#1330).

Found by probing the splitter rather than waiting for a reproduction: at
certain lengths the boundary lands so that the tail becomes a chunk of pure
punctuation. 799 filler characters plus ``' ...'`` split into
``['aaa…', '...']`` — a whole chunk whose entire content is three dots.

Two things go wrong with that:

* it costs a full GPU job to synthesize nothing, and
* if the engine returns no audio for it — which is the likely response to
  ``"."`` — the join reports "part of your text produced no audio" (#1388).
  That warning exists to surface real data loss. Firing it for punctuation
  that was never speech teaches users to ignore it, which would quietly undo
  the fix it belongs to.

The punctuation is not discarded: it is folded into a neighbouring chunk, so
the engine sees the same characters in the same order.
"""

import importlib
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

SPEAKABLE = re.compile(r"[^\W_]", re.UNICODE)


@pytest.fixture()
def ct():
    return importlib.import_module("services.chunked_tts")


def _dead(chunks):
    return [c for c in chunks if not SPEAKABLE.search(c)]


# ── the bug ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "tail", ['"', "...", "—", "!!!", "()", ",,,", ";", ":", "??", "[x]"]
)
@pytest.mark.parametrize("pad", [797, 798, 799, 800])
def test_a_punctuation_tail_never_becomes_its_own_chunk(ct, pad, tail):
    """The measured failure, swept across the boundary lengths that trigger it."""
    chunks = ct.split_text_into_chunks("a" * pad + " " + tail, 800)
    assert not _dead(chunks), f"chunk with no speakable content: {_dead(chunks)!r}"


def test_nothing_is_lost_when_a_chunk_is_folded(ct):
    """Folding must move the text, not drop it — the join has to still cover
    every character the user typed."""
    text = "a" * 799 + " ..."
    chunks = ct.split_text_into_chunks(text, 800)
    assert "".join(text.split()) == "".join("".join(chunks).split())


def test_the_fold_keeps_the_punctuation_adjacent_to_its_sentence(ct):
    """It belongs to the text before it; gluing it to the front of the NEXT
    chunk would change where the pause lands."""
    chunks = ct.split_text_into_chunks("a" * 799 + " ...", 800)
    assert chunks[-1].endswith("...")


def test_a_realistic_ellipsis_ending_stays_whole(ct):
    text = "Hello there. " + ("word " * 200) + "and then it simply stopped . . ."
    chunks = ct.split_text_into_chunks(text, 800)
    assert not _dead(chunks)
    assert "".join(text.split()) == "".join("".join(chunks).split())


# ── input that is ONLY punctuation ─────────────────────────────────────────


def test_text_made_entirely_of_punctuation_still_returns_one_chunk(ct):
    """Degenerate but legal input. It must not vanish (the caller would then
    render nothing with no explanation) and must not split into several dead
    chunks either."""
    text = "... " * 300
    chunks = ct.split_text_into_chunks(text, 800)
    assert len(chunks) == 1
    assert "".join(text.split()) == "".join("".join(chunks).split())


def test_a_leading_unspeakable_chunk_folds_forward(ct, monkeypatch):
    """Nothing precedes the first chunk, so it folds into the one after it."""
    merged = ct._merge_unspeakable(["...", "real words here", "more words"])
    assert not _dead(merged)
    assert merged[0].startswith("...")
    assert len(merged) == 2


# ── the ordinary path is untouched ─────────────────────────────────────────


def test_normal_prose_is_chunked_exactly_as_before(ct):
    text = ("This is a sentence. " * 120).strip()
    chunks = ct.split_text_into_chunks(text, 800)
    assert len(chunks) > 1
    assert not _dead(chunks)
    assert "".join(text.split()) == "".join("".join(chunks).split())


def test_a_single_short_text_is_still_one_chunk(ct):
    assert ct.split_text_into_chunks("Just a short line.", 800) == ["Just a short line."]


def test_empty_input_still_yields_nothing(ct):
    assert ct.split_text_into_chunks("", 800) == []
    assert ct.split_text_into_chunks("   ", 800) == []


def test_cjk_counts_as_speakable(ct):
    """The speakable test is \\w-based across all scripts, not ASCII letters —
    a CJK chunk must never be mistaken for punctuation and folded away."""
    cjk = "こんにちは"  # hiragana
    merged = ct._merge_unspeakable([cjk, cjk])
    assert merged == [cjk, cjk]


# ── the fold respects the size contract ────────────────────────────────────


def test_the_fold_prefers_moving_a_word_over_overflowing(ct):
    """Given room to rebalance, both chunks stay inside the limit."""
    text = ("word " * 40).strip() + " ..."
    chunks = ct.split_text_into_chunks(text, 120)
    assert all(len(c) <= 120 for c in chunks), [len(c) for c in chunks]
    assert not _dead(chunks)


def test_a_borrowed_word_must_itself_be_speakable(ct):
    """Borrowing a word that is punctuation just moves the silence: the
    measured regression was ``"longer." + "." -> ". ."``, a fresh dead chunk
    produced by the very code meant to remove them."""
    merged = ct._merge_unspeakable(["some words longer.", ".", "."], 20)
    assert not _dead(merged), merged


def test_any_overflow_is_punctuation_only_and_small(ct):
    """When no word can move, the fold wins — but max_chars bounds SPEECH
    (#505), so nothing past the limit may be speakable."""
    import random
    import re as _re

    random.seed(11)
    words = ["hello", "world", "testing", "a", "sentence", "with", "words"]
    worst = 0
    for max_chars in (120, 200, 400, 800):
        for _ in range(200):
            text = " ".join(random.choice(words) for _ in range(random.randint(50, 400)))
            text += random.choice([".", " ...", ' "', " —", " !!!", " ;", ". . .", ".. .."])
            for c in ct.split_text_into_chunks(text, max_chars):
                if len(c) > max_chars:
                    excess = c[max_chars:]
                    assert not _re.search(r"[^\W_]", excess), f"speech past the limit: {excess!r}"
                    worst = max(worst, len(excess))
    assert worst <= 8, f"overflow grew to {worst} characters"
