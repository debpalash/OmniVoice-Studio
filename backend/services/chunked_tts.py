"""Chunked TTS generation utilities (Wave 1.2 — unlimited-length generation).

Adapted from voicebox (https://github.com/jamiepine/voicebox), MIT License,
Copyright (c) voicebox contributors. The concatenation half is reworked for
torch tensors (our inference helpers pass raw model output — possibly
multi-channel — to the effect chain), and the sample rate comes from the
engine's declared rate rather than the first chunk (fixes a latent upstream
bug where a mid-run rate change was silently ignored).

Splits long text into sentence-boundary chunks and joins the per-chunk audio
with a short crossfade. Pure functions — the generation loop itself lives in
``api/routers/generation.py`` next to the existing ``[pause]`` span stitcher,
so this module stays unit-testable without a model.

Short text (<= max_chunk_chars) never reaches this module's concat path; the
callers keep their unchanged single-shot fast path.
"""

from __future__ import annotations

import logging
import re
from typing import List

logger = logging.getLogger("omnivoice.chunked_tts")

# Default chunk size in characters. 0 disables chunking entirely.
DEFAULT_MAX_CHUNK_CHARS = 800

# Default crossfade between chunks. 0 = hard cut.
DEFAULT_CROSSFADE_MS = 50

# Common abbreviations that should NOT be treated as sentence endings.
# Lowercase for case-insensitive matching.
_ABBREVIATIONS = frozenset({
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "ave", "blvd",
    "inc", "ltd", "corp", "dept", "est", "approx", "vs", "etc",
    "e.g", "i.e", "a.m", "p.m", "u.s", "u.s.a", "u.k",
})

# Inline bracket tags (paralinguistic tags like [laugh]; our own
# [pause 300ms] markers). The splitter must never cut inside one.
_BRACKET_TAG_RE = re.compile(r"\[[^\]]*\]")

# Dense scripts (CJK ideographs, kana, Hangul) where ~1 character = 1 syllable,
# so an N-char chunk is far more *speech* than N Latin chars. Counted by code
# point (see _dense_char_count) so there are no literal CJK chars in source.
def _dense_char_count(text: str) -> int:
    """Number of CJK / kana / Hangul characters in *text* (dense scripts)."""
    n = 0
    for ch in text:
        o = ord(ch)
        if (0x3040 <= o <= 0x30FF or 0x3400 <= o <= 0x4DBF
                or 0x4E00 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF
                or 0xF900 <= o <= 0xFAFF):
            n += 1
    return n

# A chunk that is predominantly dense-script (>= this fraction) gets the smaller
# limit; below it, the text is mostly spaced/Latin and the full limit applies.
_DENSE_FRACTION_THRESHOLD = 0.3
# Speech-per-char multiplier for dense scripts vs Latin (~1 ideograph ≈ 2.5
# Latin chars of audio). Used to scale the char limit down.
_DENSE_SPEECH_FACTOR = 2.5


def _effective_max_chars(text: str, max_chars: int) -> int:
    """Scale *max_chars* down for dense-script text (#505).

    Long-form (5+ min) generation degrades — repeated / skipped / mispronounced
    words — when a single chunk's acoustic sequence gets too long. With CJK /
    kana / Hangul, ~1 char = 1 syllable, so an 800-char chunk is ~4-5 minutes of
    audio in one shot, well past the model's reliable range. When a chunk is
    predominantly dense-script, cap it to ``max_chars / _DENSE_SPEECH_FACTOR``
    (floored) so each chunk's spoken length stays bounded. Latin / spaced text
    is unchanged. ``max_chars <= 0`` (chunking disabled) is left untouched.
    """
    if max_chars <= 0 or not text:
        return max_chars
    dense = _dense_char_count(text)
    if dense and dense / len(text) >= _DENSE_FRACTION_THRESHOLD:
        return max(120, min(max_chars, round(max_chars / _DENSE_SPEECH_FACTOR)))
    return max_chars


def split_text_into_chunks(text: str, max_chars: int = DEFAULT_MAX_CHUNK_CHARS) -> List[str]:
    """Split *text* at natural boundaries into chunks of at most *max_chars*.

    Priority: sentence-end (``.!?`` not after an abbreviation/decimal and not
    inside brackets, plus fullwidth equivalents) -> clause boundary
    (``;:,`` / em dash) -> whitespace -> hard cut that avoids splitting a
    ``[tag]``.
    """
    text = text.strip()
    if not text:
        return []
    # #505: dense-script text packs far more speech per char, so cap the chunk
    # smaller to keep each chunk's spoken length in the model's reliable range.
    max_chars = _effective_max_chars(text, max_chars)
    if max_chars <= 0 or len(text) <= max_chars:
        return [text]

    chunks: List[str] = []
    remaining = text

    while remaining:
        remaining = remaining.lstrip()
        if not remaining:
            break
        if len(remaining) <= max_chars:
            chunks.append(remaining)
            break

        segment = remaining[:max_chars]

        split_pos = _find_last_sentence_end(segment)
        if split_pos == -1:
            split_pos = _find_last_clause_boundary(segment)
        if split_pos == -1:
            split_pos = segment.rfind(" ")
        if split_pos == -1:
            split_pos = _safe_hard_cut(segment, max_chars)

        chunk = remaining[: split_pos + 1].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[split_pos + 1:]

    return chunks


def _find_last_sentence_end(text: str) -> int:
    """Index of the last sentence-ending punctuation, or -1.

    Skips periods after common abbreviations and decimals, anything inside
    a bracket tag, and also recognizes fullwidth sentence punctuation
    (ideographic full stop / fullwidth ! and ?) for no-space scripts.
    """
    best = -1
    for m in re.finditer(r"[.!?](?:\s|$)", text):
        pos = m.start()
        if text[pos] == ".":
            word_start = pos - 1
            while word_start >= 0 and text[word_start].isalpha():
                word_start -= 1
            word = text[word_start + 1: pos].lower()
            if word in _ABBREVIATIONS:
                continue
            if word_start >= 0 and text[word_start].isdigit():
                continue
        if _inside_bracket_tag(text, pos):
            continue
        best = pos
    # Fullwidth sentence enders (ideographic full stop, fullwidth !, ?)
    # written as escapes to keep the repo's no-literal-CJK gate clean.
    for m in re.finditer("[\u3002\uff01\uff1f]", text):
        if m.start() > best:
            best = m.start()
    return best


def _find_last_clause_boundary(text: str) -> int:
    best = -1
    for m in re.finditer(r"[;:,—](?:\s|$)", text):
        if _inside_bracket_tag(text, m.start()):
            continue
        best = m.start()
    return best


def _inside_bracket_tag(text: str, pos: int) -> bool:
    for m in _BRACKET_TAG_RE.finditer(text):
        if m.start() < pos < m.end():
            return True
    return False


def _safe_hard_cut(segment: str, max_chars: int) -> int:
    cut = max_chars - 1
    for m in _BRACKET_TAG_RE.finditer(segment):
        if m.start() < cut < m.end():
            return m.start() - 1 if m.start() > 0 else cut
    return cut


def concatenate_audio_chunks(chunks: list, sample_rate: int,
                             crossfade_ms: int = DEFAULT_CROSSFADE_MS):
    """Join per-chunk waveforms with a linear crossfade on the sample axis.

    ``chunks`` are torch tensors as returned by the engine (1-D, or N-D with
    samples on the last axis — matching what ``_render_with_pauses`` handles).
    Crossfade overlap is clamped to the shorter neighbor; ``crossfade_ms=0``
    is a hard concat.
    """
    import torch

    chunks = [c for c in chunks if c is not None and c.shape[-1] > 0]
    if not chunks:
        return torch.zeros(1, dtype=torch.float32)
    if len(chunks) == 1:
        return chunks[0]

    crossfade_samples = int(sample_rate * crossfade_ms / 1000)
    result = chunks[0]

    for chunk in chunks[1:]:
        chunk = chunk.to(device=result.device, dtype=result.dtype)
        overlap = min(crossfade_samples, result.shape[-1], chunk.shape[-1])
        if overlap > 0:
            fade_out = torch.linspace(1.0, 0.0, overlap, dtype=result.dtype, device=result.device)
            fade_in = torch.linspace(0.0, 1.0, overlap, dtype=result.dtype, device=result.device)
            blended = result[..., -overlap:] * fade_out + chunk[..., :overlap] * fade_in
            result = torch.cat([result[..., :-overlap], blended, chunk[..., overlap:]], dim=-1)
        else:
            result = torch.cat([result, chunk], dim=-1)

    return result
