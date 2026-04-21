"""
Speech-rate engineering — Phase 4.4 (ROADMAP.md).

Before TTS generation, predict how long the target-language text will take
to read at a natural pace. If it overshoots the source slot (= lip-sync
will drift), ask the LLM to trim filler or slightly reflow. If it undershoots,
expand. Loop until fit or max retries.

Runs as a post-process on Cinematic translator output or manually via
`adjust_for_slot(...)`. Fast mode skips this — the whole point is the
LLM-aware trimming, and Fast-mode users opted out of LLM calls.

Returns the fit text + a `rate_ratio` (text chars / slot-aligned chars).
"""
from __future__ import annotations

import logging
from typing import Iterable, Optional

from services.llm_backend import get_active_llm_backend, OffBackend

logger = logging.getLogger("omnivoice.speech_rate")

# Per-language read-speed estimates (chars/sec at natural pace).
# These are rough; real speakers vary wildly. Good enough for a first pass.
_RATE_CPS = {
    "en": 15.0, "de": 14.0, "fr": 15.0, "es": 15.5, "it": 15.0, "pt": 15.0,
    "ja": 10.0, "ko": 10.0, "zh": 6.0,
}

# Tolerance window — if predicted ratio is within this of 1.0 we accept.
TOL_LOW = 0.92
TOL_HIGH = 1.08

# Max LLM attempts per segment. Past this we just return the best we got.
MAX_ATTEMPTS = 3


def expected_duration(text: str, lang: str = "en") -> float:
    """Rough CPS-based duration estimate. Returns seconds."""
    cps = _RATE_CPS.get(lang.split("-")[0].lower(), 13.0)
    return len(text) / max(1.0, cps)


def rate_ratio(text: str, slot_seconds: float, lang: str = "en") -> float:
    """How far off the text is from the slot. 1.0 = perfect."""
    if slot_seconds <= 0:
        return 1.0
    return expected_duration(text, lang) / slot_seconds


_TRIM_PROMPT = """\
You are a dubbing writer. The user will give you a translated line + the exact
time slot it must fit. The current line is TOO LONG — trim filler words,
tighten phrasing, or drop less essential clauses while preserving the meaning.
Never change character names or proper nouns.
Reply with ONLY the new line. No quotes, no commentary."""

_EXPAND_PROMPT = """\
You are a dubbing writer. The user will give you a translated line + the exact
time slot it must fit. The current line is TOO SHORT — add natural filler or
gently flesh out the thought while keeping the meaning the same. Aim for a
reading duration that matches the slot.
Reply with ONLY the new line. No quotes, no commentary."""


def adjust_for_slot(
    text: str,
    *,
    slot_seconds: float,
    target_lang: str,
    source_text: Optional[str] = None,
) -> dict:
    """Return `{text, rate_ratio, attempts, error?}`.

    Falls back to the input text if the LLM is off or the loop gives up.
    """
    initial_ratio = rate_ratio(text, slot_seconds, target_lang)
    if TOL_LOW <= initial_ratio <= TOL_HIGH:
        return {"text": text, "rate_ratio": initial_ratio, "attempts": 0}

    llm = get_active_llm_backend()
    if isinstance(llm, OffBackend):
        return {
            "text": text,
            "rate_ratio": initial_ratio,
            "attempts": 0,
            "error": "no-llm",
        }

    current = text
    best = (current, initial_ratio)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        r = rate_ratio(current, slot_seconds, target_lang)
        if TOL_LOW <= r <= TOL_HIGH:
            return {"text": current, "rate_ratio": r, "attempts": attempt - 1}

        system = _TRIM_PROMPT if r > 1.0 else _EXPAND_PROMPT
        user_lines = [
            f"Target language: {target_lang}",
            f"Slot: {slot_seconds:.2f}s",
            f"Current line: {current}",
            f"Current reading duration: ~{expected_duration(current, target_lang):.2f}s "
            f"(ratio {r:.2f})",
        ]
        if source_text:
            user_lines.append(f"Source line (for meaning): {source_text}")

        try:
            next_text = llm.chat(system=system, user="\n".join(user_lines))
        except Exception as e:
            logger.warning("speech-rate attempt %d failed: %s", attempt, e)
            return {"text": best[0], "rate_ratio": best[1], "attempts": attempt - 1, "error": str(e)}

        if next_text and next_text.strip():
            current = next_text.strip()
            new_r = rate_ratio(current, slot_seconds, target_lang)
            # Keep the best candidate seen so far in case we exhaust retries.
            if abs(new_r - 1.0) < abs(best[1] - 1.0):
                best = (current, new_r)

    return {
        "text": best[0],
        "rate_ratio": best[1],
        "attempts": MAX_ATTEMPTS,
    }


def adjust_many(pairs: Iterable[tuple[str, float, str, Optional[str]]]) -> list[dict]:
    """Apply `adjust_for_slot` over many items synchronously.

    `pairs`: iterable of `(text, slot_seconds, target_lang, source_text_or_None)`.
    """
    return [
        adjust_for_slot(t, slot_seconds=s, target_lang=tl, source_text=src)
        for (t, s, tl, src) in pairs
    ]
