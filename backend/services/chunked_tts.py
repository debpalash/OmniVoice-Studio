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
