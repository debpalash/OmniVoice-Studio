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

from dataclasses import dataclass, field
from typing import Callable, Optional

@dataclass
class Span:
    """One contiguous run of text in a single voice, plus trailing silence.

    ``speed`` (when set) is the per-span rate passed to the engine — Stories'
    per-line speed slider rides through here so the shared server render honours
    it the way the old client export did.
    """
    voice_id: Optional[str]
    text: str
    pause_ms_after: int = 0
    speed: Optional[float] = None

    def to_dict(self) -> dict:
        return {"voice_id": self.voice_id, "text": self.text,
                "pause_ms_after": self.pause_ms_after, "speed": self.speed}


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

    @property
    def chapter_count(self) -> int:
        return len(self.chapters)

    def to_dict(self) -> dict:
        return {
            "chapters": [c.to_dict() for c in self.chapters],
            "chapter_count": self.chapter_count,
            "char_count": self.char_count,
        }


def parse_audiobook_script(text: str, *, default_voice: Optional[str] = None) -> AudiobookPlan:
    """Parse a chapter-delimited script into an :class:`AudiobookPlan`.

    Thin wrapper over the canonical :func:`services.longform_parser.
    parse_script_to_spans` (the single grammar source of truth, #27); wraps its
    span dicts in the ``Span``/``Chapter``/``AudiobookPlan`` dataclasses so the
    four router call sites and ``.to_dict()`` shape are unchanged.
    """
    from services.longform_parser import parse_script_to_spans

    chapters = [
        Chapter(title=c["title"], spans=[Span(**s) for s in c["spans"]])
        for c in parse_script_to_spans(text, default_voice=default_voice)
    ]
    return AudiobookPlan(chapters=chapters)


def synthesize_chapter(
    spans: list[Span],
    synth: Callable[[str, Optional[str], Optional[float]], "object"],
    sample_rate: int,
    *,
    crossfade_ms: int = 50,
    lexicon: Optional[dict] = None,
):
    """Render a chapter's spans to one waveform via an injected ``synth``.

    ``synth(text, voice_id, speed)`` returns a 1-D float32 audio tensor for a
    span of text in the given voice (``speed`` may be ``None`` for the engine
    default). Long spans are split with the ``chunked_tts`` splitter and
    crossfaded; inter-span ``pause_ms_after`` becomes silence. ``lexicon`` (when
    given) respells each span's text before chunking so the engine pronounces
    tricky words correctly; a ``None``/empty lexicon is a no-op pass-through.

    Returns ``(audio_tensor, duration_seconds)``. torch + chunked_tts are
    imported lazily so this module stays import-light for the pure parser path.
    """
    import torch
    from services.chunked_tts import concatenate_audio_chunks, split_text_into_chunks
    from services.pronunciation import apply_lexicon

    parts: list = []
    for span in spans:
        if span.text:
            chunks = split_text_into_chunks(apply_lexicon(span.text, lexicon))
            rendered = [synth(c, span.voice_id, span.speed) for c in chunks]
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
