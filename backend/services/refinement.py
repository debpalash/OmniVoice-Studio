"""Dictation transcript refinement — deterministic pre-pass (Wave 1.1).

Adapted from voicebox (https://github.com/jamiepine/voicebox), MIT License,
Copyright (c) voicebox contributors.

This module currently ships phase 1 of Spec 3 (docs/competitive-analysis.md):
``collapse_repetitive_artifacts()``, a deterministic filter that strips the
classic Whisper hallucination loops ("thanks for watching" repeated forever)
from FINAL transcripts before they reach the user. It needs no LLM and runs
identically on every platform. Phase 2 (optional local-LLM filler-word
removal via services.llm_backend) lands with parity program Wave 2.1 and
will live here too.
"""

from __future__ import annotations

import re

# A token (or unit) must repeat at least this many times consecutively to be
# treated as an STT artifact. Rhetorical repetition ("no, no, no, no, no" —
# five repeats) stays below the threshold and survives.
_REPETITION_RUN_THRESHOLD = 6

# Upper bound on the repeating unit the character-level pass looks for.
# Long enough for multi-word loop phrases, short enough to keep the
# non-greedy regex cheap on long transcripts.
_MAX_REPETITION_UNIT_CHARS = 60


def _token_key(word: str) -> str:
    """Normalize a token for repetition comparison — strip surrounding
    punctuation and lowercase so "URL", "url," and "URL." all compare
    equal inside a loop."""
    return re.sub(r"[^\w]", "", word).lower()


def collapse_repetitive_artifacts(text: str, min_run: int = _REPETITION_RUN_THRESHOLD) -> str:
    """Strip STT-artifact loops. Two passes handle the full space:

    1. Word-level: any token repeated ``min_run``+ times consecutively
       (with surrounding punctuation stripped for comparison). Catches
       single-word loops like "URL URL URL..." and punctuated variants.
    2. Character-level: any substring 2-60 chars long that repeats
       ``min_run``+ times immediately after itself. Catches multi-word
       loops ("thanks for watching" x 6) that the word-level pass misses
       (no consecutive identical tokens) and loops in no-space scripts
       where ``text.split()`` yields a single unsplit token.

    Both passes preserve rhetorical repetition: five "no"s or three
    "yeah"s stay in the transcript because they don't cross the threshold.
    """
    if not text:
        return text
    collapsed = _collapse_word_runs(text, min_run)
    collapsed = _collapse_character_runs(collapsed, min_run)
    return collapsed


def _collapse_word_runs(text: str, min_run: int) -> str:
    words = text.split()
    if len(words) < min_run:
        return text

    out: list[str] = []
    i = 0
    while i < len(words):
        key = _token_key(words[i])
        j = i
        # Empty keys (all-punctuation tokens) shouldn't count as a match.
        if key:
            while j < len(words) and _token_key(words[j]) == key:
                j += 1
        else:
            j = i + 1
        run_len = j - i
        if run_len >= min_run:
            # Drop the whole run — the surrounding prose still carries
            # the speaker's thought, and a 6-token repeat almost always
            # means the speech-to-text model glitched.
            pass
        else:
            out.extend(words[i:j])
        i = j

    return " ".join(out)


def _collapse_character_runs(text: str, min_run: int) -> str:
    # Non-greedy unit so the shortest repeating substring wins. Lower
    # bound of 2 chars avoids stripping emphasized single-letter runs
    # ("wooooooow", "hmmmmm") that aren't hallucinations. re.DOTALL so a
    # newline inside a looped unit (rare) doesn't break the match.
    pattern = re.compile(
        r"(.{2," + str(_MAX_REPETITION_UNIT_CHARS) + r"}?)\1{" + str(min_run - 1) + r",}",
        flags=re.DOTALL,
    )
    result = pattern.sub("", text)
    if result == text:
        return text
    # Stripping a run leaves double whitespace where the loop used to
    # bridge surrounding context; normalize only when we actually modified
    # the text so untouched transcripts keep their original whitespace.
    return re.sub(r"\s+", " ", result).strip()
