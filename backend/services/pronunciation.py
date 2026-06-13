"""Pronunciation lexicon — per-project word respelling (longform render, PR 8).

A pronunciation lexicon maps a word (or short phrase) to a respelling the TTS
engine pronounces correctly: ``{"OmniVoice": "Omni Voice", "Dr": "Doctor",
"GIF": "jiff"}``. The narration pipeline applies it to each span's text just
before chunking, so the engine never sees the hard-to-say original.

This module is the engine-agnostic, pure core:

  * ``apply_lexicon(text, lexicon)`` — whole-word, case-insensitive replacement
    of every key with its respelling. Word-boundary aware (``\\b``), so a key
    ``cat`` never touches ``category``; surrounding punctuation/whitespace is
    preserved (``"smith,"`` → ``"Smith,"``). Longest key first, so a key
    ``Dr. Smith`` wins over ``Dr`` on overlapping input.
  * ``normalize_lexicon(lexicon)`` — drop empty/whitespace keys, coerce values.
  * ``load_lexicon(path)`` / ``save_lexicon(path, lexicon)`` — JSON round-trip.

ReDoS safety: the matcher is a single anchored-alternation regex built from
``re.escape``'d keys joined by ``|`` and wrapped in word boundaries
(``\\b(?:k1|k2|…)\\b``). No nested/overlapping quantifiers, no user-controlled
quantifier — the keys are literals, so there is no catastrophic backtracking
(CodeQL py/polynomial-redos clean). Matching is done in one ``re.sub`` pass with
a callback, so a respelling that happens to contain another key is never
re-scanned (idempotent against its own output).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

# A "word" character for boundary purposes. We treat the standard regex word
# class (``\w`` = ``[A-Za-z0-9_]`` plus Unicode letters under ``re.UNICODE``,
# the default for ``str`` patterns). A key only gets ``\b`` boundaries on a side
# that actually abuts a word char, so a key like ``Dr.`` (ends in a non-word
# char) still matches when followed by a space.


def normalize_lexicon(lexicon: Optional[dict]) -> dict[str, str]:
    """Return a clean ``{key: respelling}`` dict.

    Drops entries whose key is empty or whitespace-only; coerces keys/values to
    stripped strings. A value may be empty (``""``) — that deletes the word
    (valid: e.g. stripping a stray marker). ``None``/non-dict input → ``{}``.
    """
    if not isinstance(lexicon, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in lexicon.items():
        if k is None:
            continue
        key = str(k).strip()
        if not key:
            continue
        out[key] = "" if v is None else str(v)
    return out


def _boundary_prefix(key: str) -> str:
    """``\\b`` only if the key starts with a word char (else the boundary would
    never match — e.g. a key opening with punctuation)."""
    return r"\b" if key[:1].isalnum() or key[:1] == "_" else ""


def _boundary_suffix(key: str) -> str:
    """``\\b`` only if the key ends with a word char."""
    return r"\b" if key[-1:].isalnum() or key[-1:] == "_" else ""


def _compile(lexicon: dict[str, str]) -> tuple[Optional[re.Pattern], dict[str, str]]:
    """Build the single alternation regex + a casefold→respelling lookup.

    Keys are sorted longest-first so an overlapping longer key (``Dr. Smith``)
    is tried before a shorter one (``Dr``). Each alternative carries its own
    word-boundary guards based on its own edge characters, which keeps a
    punctuation-edged key (``Dr.``) matchable while still protecting a
    letter-edged key (``cat``) from partial hits inside ``category``.
    """
    keys = sorted(lexicon.keys(), key=len, reverse=True)
    if not keys:
        return None, {}
    # casefold (not lower) for robust Unicode case-insensitive lookup.
    lookup = {k.casefold(): lexicon[k] for k in keys}
    alts = [f"{_boundary_prefix(k)}{re.escape(k)}{_boundary_suffix(k)}" for k in keys]
    # No capturing groups, no nested quantifiers — pure literal alternation.
    pattern = re.compile("(?:" + "|".join(alts) + ")", re.IGNORECASE)
    return pattern, lookup


def apply_lexicon(text: str, lexicon: Optional[dict]) -> str:
    """Replace whole-word occurrences of each lexicon key with its respelling.

    Case-insensitive match; word-boundary aware (a key never matches inside a
    longer word); longest key wins on overlap; surrounding punctuation and
    whitespace are untouched. A single left-to-right ``re.sub`` pass means a
    respelling is never itself rescanned, so applying twice is idempotent when
    no key is a substring of another key's output.

    Returns ``text`` unchanged when ``text`` is falsy or the lexicon is empty.
    """
    if not text:
        return text or ""
    clean = normalize_lexicon(lexicon)
    pattern, lookup = _compile(clean)
    if pattern is None:
        return text

    def _repl(m: re.Match) -> str:
        return lookup.get(m.group(0).casefold(), m.group(0))

    return pattern.sub(_repl, text)


# ── JSON persistence ─────────────────────────────────────────────────────────

def load_lexicon(path) -> dict[str, str]:
    """Load + normalize a lexicon from a JSON file.

    A missing file, empty file, or non-object JSON yields ``{}`` rather than
    raising — a project simply has no lexicon yet. Malformed JSON still raises
    (caller's choice to surface it).
    """
    p = Path(path)
    if not p.is_file():
        return {}
    raw = p.read_text(encoding="utf-8").strip()
    if not raw:
        return {}
    data = json.loads(raw)
    return normalize_lexicon(data)


def save_lexicon(path, lexicon: Optional[dict]) -> dict[str, str]:
    """Normalize + write a lexicon to ``path`` as pretty JSON (utf-8).

    Returns the normalized dict that was written. Parent dirs are created.
    """
    clean = normalize_lexicon(lexicon)
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps(clean, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return clean
