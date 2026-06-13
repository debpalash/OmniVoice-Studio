"""Audiobook creator — chapterized long-form narration (parity Wave 5).

Turns a chapter-delimited script into a chapterized audiobook. This module is
the engine-agnostic core:

  * ``parse_audiobook_script`` — pure parser: Markdown ``# H1`` headings become
    chapters; inline ``[voice:NAME]`` switches the narrator; ``[pause …]`` is
    delegated to the existing :func:`omnivoice.utils.text.parse_pause_markers`
    so audiobooks and single-shot synthesis share one pause dialect.
  * ``synthesize_chapter`` — orchestration: renders a chapter's spans through an
    injected ``synth(text, voice_id) -> tensor`` callable (reusing the
    ``chunked_tts`` splitter + crossfade), stitching the inter-span silences.
    Injecting the synth keeps this unit-testable with a stub backend (no torch
    model, no GPU).
  * ``build_chapter_ffmetadata`` / ``build_m4b_cmd`` — pure builders for the
    ffmpeg chapterized-m4b mux (FFMETADATA1 ``[CHAPTER]`` blocks + concat-demux
    argv). The actual ffmpeg run lives in the (impure) caller.

Scope (first cut): plain chapter-delimited text/Markdown input. epub/pdf
ingestion, the streaming synth job + UI are deferred follow-ups.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Optional

from omnivoice.utils.text import parse_pause_markers

# A Markdown H1 (``# Title``) starts a new chapter. Deeper headings stay in the
# body as ordinary text (narrated, not chapter breaks). The title capture
# starts with ``\S`` (a non-space) so the leading ``[ \t]+`` and the title's
# ``.*`` can't both match the same whitespace run — that overlap is what makes
# ``[ \t]+(.+)`` polynomial-time on adversarial tabs (ReDoS). Stripped in code.
_HEADING_RE = re.compile(r"^[ \t]*#[ \t]+(\S.*)$", re.MULTILINE)
# ``[voice:NAME]`` switches the active narrator for the text that follows. The
# content class excludes BOTH brackets (``[^\]\[]``) so a run of nested
# ``[voice:`` prefixes can't create overlapping match attempts across
# ``finditer`` (the source of the polynomial-time ReDoS). A voice name never
# contains a bracket; the value is stripped in code.
_VOICE_RE = re.compile(r"\[voice:([^\]\[]*)\]")


@dataclass
class Span:
    """One contiguous run of text in a single voice, plus trailing silence."""
    voice_id: Optional[str]
    text: str
    pause_ms_after: int = 0

    def to_dict(self) -> dict:
        return {"voice_id": self.voice_id, "text": self.text,
                "pause_ms_after": self.pause_ms_after}


@dataclass
class Chapter:
    title: str
    spans: list[Span] = field(default_factory=list)

    @property
    def char_count(self) -> int:
        return sum(len(s.text) for s in self.spans)

    def to_dict(self) -> dict:
        return {"title": self.title, "char_count": self.char_count,
                "spans": [s.to_dict() for s in self.spans]}


@dataclass
class AudiobookPlan:
    chapters: list[Chapter] = field(default_factory=list)

    @property
    def char_count(self) -> int:
        return sum(c.char_count for c in self.chapters)

    def to_dict(self) -> dict:
        return {
            "chapters": [c.to_dict() for c in self.chapters],
            "chapter_count": len(self.chapters),
            "char_count": self.char_count,
        }


def _parse_spans(body: str, default_voice: Optional[str]) -> list[Span]:
    """Split a chapter body into voice-tagged, pause-aware spans."""
    spans: list[Span] = []
    cur_voice = default_voice
    runs: list[tuple[Optional[str], str]] = []
    last = 0
    for m in _VOICE_RE.finditer(body):
        if m.start() > last:
            runs.append((cur_voice, body[last:m.start()]))
        cur_voice = (m.group(1).strip() or default_voice)
        last = m.end()
    runs.append((cur_voice, body[last:]))

    for voice, run_text in runs:
        # Delegate pause handling to the shared parser so the [pause …] dialect
        # stays identical to single-shot synthesis.
        for span_text, pause_ms in parse_pause_markers(run_text):
            t = span_text.strip()
            if not t and pause_ms == 0:
                continue  # pure whitespace between markers — nothing to render
            spans.append(Span(voice_id=voice, text=t, pause_ms_after=pause_ms))
    return spans


def parse_audiobook_script(text: str, *, default_voice: Optional[str] = None) -> AudiobookPlan:
    """Parse a chapter-delimited script into an :class:`AudiobookPlan`.

    ``# Heading`` lines delimit chapters; text before the first heading becomes
    an untitled lead-in chapter. Chapters with no renderable spans are dropped.
    """
    text = text or ""
    matches = list(_HEADING_RE.finditer(text))
    if not matches:
        raw = [(None, text)]
    else:
        raw = []
        intro = text[:matches[0].start()]
        if intro.strip():
            raw.append((None, intro))
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            raw.append((m.group(1).strip(), text[m.end():end]))

    chapters: list[Chapter] = []
    for title, body in raw:
        spans = _parse_spans(body, default_voice)
        if not spans:
            continue
        chapters.append(Chapter(title=title or f"Chapter {len(chapters) + 1}", spans=spans))
    return AudiobookPlan(chapters=chapters)


def synthesize_chapter(
    spans: list[Span],
    synth: Callable[[str, Optional[str]], "object"],
    sample_rate: int,
    *,
    crossfade_ms: int = 50,
):
    """Render a chapter's spans to one waveform via an injected ``synth``.

    ``synth(text, voice_id)`` returns a 1-D float32 audio tensor for a span of
    text in the given voice. Long spans are split with the ``chunked_tts``
    splitter and crossfaded; inter-span ``pause_ms_after`` becomes silence.

    Returns ``(audio_tensor, duration_seconds)``. torch + chunked_tts are
    imported lazily so this module stays import-light for the pure parser path.
    """
    import torch
    from services.chunked_tts import concatenate_audio_chunks, split_text_into_chunks

    parts: list = []
    for span in spans:
        if span.text:
            chunks = split_text_into_chunks(span.text)
            rendered = [synth(c, span.voice_id) for c in chunks]
            rendered = [r for r in rendered if r is not None and getattr(r, "numel", lambda: 0)()]
            if len(rendered) == 1:
                parts.append(rendered[0])
            elif rendered:
                parts.append(concatenate_audio_chunks(rendered, sample_rate, crossfade_ms=crossfade_ms))
        if span.pause_ms_after > 0:
            n = int(sample_rate * span.pause_ms_after / 1000.0)
            if n > 0:
                parts.append(torch.zeros(n, dtype=torch.float32))

    if not parts:
        return torch.zeros(0, dtype=torch.float32), 0.0
    # Hard-concat spans + silences (crossfading silence would bleed the gap).
    audio = parts[0] if len(parts) == 1 else concatenate_audio_chunks(parts, sample_rate, crossfade_ms=0)
    return audio, audio.shape[-1] / float(sample_rate)


# ── ffmpeg / metadata builders ──────────────────────────────────────────────
#
# These now live in the shared ``longform_render`` core (Stories + Audiobook
# converge on one mux). The thin wrappers below preserve the original
# audiobook-only call sites/signatures; new callers should use
# ``longform_render`` directly to reach global metadata, cover art, loudness,
# and mp3 output.
from services.longform_render import (  # noqa: E402
    build_concat_list,
    build_ffmetadata,
    build_render_cmd,
)


def build_chapter_ffmetadata(chapters: list[tuple[str, int]]) -> str:
    """Backward-compatible alias: chapters-only FFMETADATA (no global tags)."""
    return build_ffmetadata(chapters)


def build_m4b_cmd(
    ffmpeg: str,
    concat_list_path: str,
    metadata_path: str,
    out_path: str,
    *,
    bitrate: str = "128k",
) -> list[str]:
    """Backward-compatible alias: a chapterized faststart m4b, no cover/loudness."""
    return build_render_cmd(
        ffmpeg, concat_list_path, metadata_path, out_path,
        fmt="m4b", bitrate=bitrate,
    )
