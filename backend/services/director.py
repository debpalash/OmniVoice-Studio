"""
Directorial AI — Phase 4.2 (ROADMAP.md), one of the two defensible bets.

User types a natural-language direction ("make segment 14 feel more urgent
and surprised") on a segment. The director service parses it into a
structured taxonomy token set, and the pipeline applies the tokens in three
places:

  1. Translate reflection — "adapt for an urgent, surprised delivery"
  2. TTS `instruct` — "urgent, surprised"
  3. Speech-rate target — "urgent" nudges the slot tighter

Parsing can run via LLM (robust, natural language) or heuristic (fallback
when no LLM is configured). The taxonomy is the stable contract — the LLM is
an implementation detail.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Optional

from services.llm_backend import get_active_llm_backend, OffBackend

logger = logging.getLogger("omnivoice.director")


# ── Taxonomy (stable contract) ──────────────────────────────────────────────
# Additive per dimension — multiple values allowed. Unknown tokens are ignored
# so the UI can ship new words independently of backend deploys.

TAXONOMY = {
    "energy":    ["calm", "relaxed", "steady", "energetic", "urgent", "frantic"],
    "emotion":   ["happy", "sad", "angry", "surprised", "fearful", "neutral", "warm", "cold", "hopeful", "resigned"],
    "pace":      ["slow", "measured", "conversational", "quick", "rushed"],
    "intimacy":  ["whispered", "intimate", "conversational", "projected", "announcing"],
    "formality": ["casual", "neutral", "formal", "clinical"],
}

# Keyword → (dimension, value). Loose hand-written hints for the heuristic parser.
_KEYWORD_HINTS = {
    "urgent": ("energy", "urgent"),
    "urgency": ("energy", "urgent"),
    "rushed": ("pace", "rushed"),
    "quick": ("pace", "quick"),
    "fast": ("pace", "quick"),
    "slow": ("pace", "slow"),
    "surprised": ("emotion", "surprised"),
    "shocked": ("emotion", "surprised"),
    "angry": ("emotion", "angry"),
    "sad": ("emotion", "sad"),
    "happy": ("emotion", "happy"),
    "warm": ("emotion", "warm"),
    "cold": ("emotion", "cold"),
    "hopeful": ("emotion", "hopeful"),
    "whisper": ("intimacy", "whispered"),
    "whispered": ("intimacy", "whispered"),
    "intimate": ("intimacy", "intimate"),
    "announcing": ("intimacy", "announcing"),
    "announcer": ("intimacy", "announcing"),
    "casual": ("formality", "casual"),
    "formal": ("formality", "formal"),
    "calm": ("energy", "calm"),
    "energetic": ("energy", "energetic"),
}


@dataclass
class Direction:
    """Parsed result. Each dimension holds a list of taxonomy values."""
    tokens: dict[str, list[str]] = field(default_factory=dict)
    source: str = ""          # original natural-language input
    method: str = "heuristic"  # "heuristic" | "llm"
    error: Optional[str] = None

    def is_empty(self) -> bool:
        return not any(self.tokens.values())

    def instruct_prompt(self) -> str:
        """Flatten into a TTS instruct string. Order: emotion, energy, pace, intimacy, formality."""
        order = ["emotion", "energy", "pace", "intimacy", "formality"]
        terms: list[str] = []
        for dim in order:
            for v in self.tokens.get(dim, []):
                if v not in terms:
                    terms.append(v)
        return ", ".join(terms)

    def translate_hint(self) -> str:
        """Sentence fragment suitable for Cinematic translator's reflect/adapt prompts."""
        if self.is_empty():
            return ""
        return f"Deliver this with a {self.instruct_prompt()} tone."

    def rate_bias(self) -> float:
        """Nudge for slot-fit: >1 = speed up (tighten), <1 = slow down."""
        energy = set(self.tokens.get("energy", []))
        pace = set(self.tokens.get("pace", []))
        if "urgent" in energy or "frantic" in energy or "rushed" in pace or "quick" in pace:
            return 1.1
        if "calm" in energy or "relaxed" in energy or "slow" in pace:
            return 0.92
        return 1.0


_LLM_PROMPT = """\
You are a casting director. The user describes how a line should be delivered
in natural language. Map their description onto the fixed taxonomy below.
Each dimension may contain zero or more values; ignore anything outside the
taxonomy. Reply ONLY with JSON of the shape:
{"energy": [...], "emotion": [...], "pace": [...], "intimacy": [...], "formality": [...]}
Omit dimensions that don't apply (empty list OK). No preamble, no trailing text.

Taxonomy:
""" + "\n".join(f"  {k}: {', '.join(v)}" for k, v in TAXONOMY.items())


def _heuristic_parse(text: str) -> Direction:
    """Keyword scan over known hints. Fast, deterministic, no network."""
    tokens: dict[str, list[str]] = {}
    lower = (text or "").lower()
    for kw, (dim, val) in _KEYWORD_HINTS.items():
        if re.search(rf"\b{re.escape(kw)}\b", lower):
            tokens.setdefault(dim, [])
            if val not in tokens[dim]:
                tokens[dim].append(val)
    return Direction(tokens=tokens, source=text, method="heuristic")


def _normalize(tokens: dict) -> dict[str, list[str]]:
    """Drop unknown dims + unknown values from an LLM-returned dict."""
    out: dict[str, list[str]] = {}
    for dim, allowed in TAXONOMY.items():
        raw = tokens.get(dim) or []
        if not isinstance(raw, list):
            continue
        cleaned = [str(v).strip().lower() for v in raw if str(v).strip().lower() in allowed]
        if cleaned:
            out[dim] = cleaned
    return out


def parse(text: str) -> Direction:
    """Public entry: parse natural-language direction. LLM if available, else heuristic."""
    if not text or not text.strip():
        return Direction(source=text or "")

    llm = get_active_llm_backend()
    if isinstance(llm, OffBackend):
        return _heuristic_parse(text)

    try:
        body = llm.chat(system=_LLM_PROMPT, user=text)
    except Exception as e:
        logger.warning("director LLM parse failed: %s", e)
        d = _heuristic_parse(text)
        d.error = f"llm-parse-failed: {e}"
        return d

    raw = body.strip()
    # Some providers wrap JSON in fences; strip them.
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("director got non-JSON: %r — falling back to heuristic", raw[:120])
        d = _heuristic_parse(text)
        d.error = "llm-invalid-json"
        return d

    return Direction(tokens=_normalize(parsed), source=text, method="llm")
