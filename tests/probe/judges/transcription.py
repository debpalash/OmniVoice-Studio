"""L4 round-trip ASR judge — the single most reliable autonomous correctness check.

Transcribe the generated audio and compare the transcript to the text that was
*asked for*, via Word Error Rate. This answers "did the TTS actually say what I
asked" without a human listening.

Honest caveats baked into the design:
  - WER measures *your TTS plus the ASR's own errors*. Gate at WER < ~0.10–0.15,
    never at 0. A *rising* WER on a fixed sentence is a far stronger signal than
    the absolute value.
  - ASR is weakest on exactly the rare/non-Latin tokens TTS is weakest on
    (correlated blind spots) — so a green WER means "intelligible", not "good".
  - The ASR backend is pluggable so the harness's own tests run offline with a
    FakeTranscriber; real verification injects faster-whisper.

WER is implemented in pure Python (word-level Levenshtein) so the judge needs no
extra dependency in the base venv. ``jiwer`` (in the ``eval`` extra) can be
swapped in if you want its richer normalization, but it is not required.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from ..spec import JudgeResult

_PUNCT = re.compile(r"[^\w\s]", flags=re.UNICODE)
_WS = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace.

    Deliberately conservative: aggressive normalization (number expansion,
    homophone folding) is ASR-engine-specific and would hide real regressions,
    so we keep it to case/punct/whitespace.
    """
    text = (text or "").lower()
    text = _PUNCT.sub(" ", text)
    return _WS.sub(" ", text).strip()


def _levenshtein(ref: list[str], hyp: list[str]) -> int:
    """Token-level edit distance (substitutions + insertions + deletions)."""
    if not ref:
        return len(hyp)
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, start=1):
        cur = [i]
        for j, h in enumerate(hyp, start=1):
            cost = 0 if r == h else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def word_error_rate(reference: str, hypothesis: str) -> float:
    ref = normalize_text(reference).split()
    hyp = normalize_text(hypothesis).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    return _levenshtein(ref, hyp) / len(ref)


def char_error_rate(reference: str, hypothesis: str) -> float:
    ref = list(normalize_text(reference).replace(" ", ""))
    hyp = list(normalize_text(hypothesis).replace(" ", ""))
    if not ref:
        return 0.0 if not hyp else 1.0
    return _levenshtein(ref, hyp) / len(ref)


# ── transcriber backends ─────────────────────────────────────────────────────


class Transcriber(Protocol):
    """Anything that turns an audio file path into text."""

    def transcribe(self, path: str, *, language: str | None = None) -> str: ...


@dataclass
class FakeTranscriber:
    """Deterministic transcriber for the harness's own offline tests.

    Either returns a fixed string, or echoes a per-path mapping. Lets us prove
    the WER judge's pass/fail logic without loading a real ASR model.
    """

    fixed: str | None = None
    mapping: dict[str, str] | None = None

    def transcribe(self, path: str, *, language: str | None = None) -> str:
        if self.mapping is not None and path in self.mapping:
            return self.mapping[path]
        return self.fixed if self.fixed is not None else ""


class FasterWhisperTranscriber:
    """Default real backend. Lazily loads faster-whisper (already in the base
    venv). Pin one ASR backend for stable WER — WhisperX / faster-whisper /
    transformers give *different* WER for the same model."""

    def __init__(self, model_size: str = "tiny", device: str = "auto", compute_type: str = "int8"):
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self._model = None

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            device = self.device
            if device == "auto":
                try:
                    import torch

                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except Exception:  # noqa: BLE001
                    device = "cpu"
            self._model = WhisperModel(self.model_size, device=device, compute_type=self.compute_type)
        return self._model

    def transcribe(self, path: str, *, language: str | None = None) -> str:
        model = self._load()
        segments, _ = model.transcribe(path, language=language)
        return " ".join(seg.text for seg in segments).strip()


# ── judge ────────────────────────────────────────────────────────────────────


def asr_wer_below(
    path: str,
    expected: str,
    max: float = 0.15,
    transcriber: Transcriber | None = None,
    language: str | None = None,
) -> JudgeResult:
    if transcriber is None:
        transcriber = FasterWhisperTranscriber()
    hyp = transcriber.transcribe(path, language=language)
    wer = word_error_rate(expected, hyp)
    return JudgeResult(
        name="asr_wer_below",
        passed=wer <= float(max),
        measured=round(wer, 4),
        detail=f"WER={wer:.3f} (max {max}); heard {hyp!r} vs asked {expected!r}",
    )
