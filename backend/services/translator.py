"""
Cinematic translation pipeline — Phase 1.1 (ROADMAP.md).

Takes the literal translation of a segment (from any provider — Argos, Google,
NLLB, OpenAI, …) and runs it through a 3-step LLM chain:

    1. LITERAL    — already done by the provider caller; passed in as input.
    2. REFLECT    — LLM critiques the literal against tone, idiom, length,
                    pacing, and any project glossary.
    3. ADAPT      — LLM rewrites for cinematic delivery using the critique.

Output contract per segment:

    {
      "id":        seg.id,
      "text":      final adapted text,       ← what the dub uses
      "literal":   step-1 text,              ← kept for UI "3-column view"
      "critique":  step-2 text,              ← kept for UI "3-column view"
    }

Graceful degradation: if the LLM is unreachable / unconfigured, each segment
falls back to the literal text with a `translate_error` marker so the UI can
surface "Cinematic unavailable — showing Fast result for N segments".

The reflect + adapt calls go through an OpenAI-compatible client, configurable
via env:

    TRANSLATE_BASE_URL   # default: https://api.openai.com/v1
    TRANSLATE_API_KEY    # or OPENAI_API_KEY
    TRANSLATE_MODEL      # default: gpt-4o-mini
    OMNIVOICE_LLM_TIMEOUT=45          # seconds per LLM call

Works with real OpenAI, Ollama (base_url=http://localhost:11434/v1), LM Studio,
Together, Anyscale — anything that speaks the OpenAI chat-completion shape.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Iterable, Optional

logger = logging.getLogger("omnivoice.translator")

# ── Prompts ──────────────────────────────────────────────────────────────────
# Kept short + direct. These run N × 2 times per dub, so verbosity = wall time.

_REFLECT_PROMPT = """\
You are a professional dubbing script editor. The user will give you a source
line and its literal translation. Critique the literal translation in 2-3
crisp sentences, focusing on:
- natural idiom in the target language
- emotional tone (does it match what the speaker would convey?)
- length (will it fit in the same time slot as the source?)
- any proper nouns or recurring terms that should stay consistent
Reply ONLY with the critique — no headers, no bullet points, no code fences."""

_ADAPT_PROMPT = """\
You are a cinematic dubbing writer. Rewrite the literal translation using the
editor's critique so it sounds natural, in-character, and fits the speaker's
time slot. Keep meaning faithful but prefer native idiom over word-for-word
accuracy. The output MUST be written in the same target language and script
as the literal translation — never switch language or transliterate.
Reply ONLY with the adapted translation — no quotes, no headers, no code
fences, no commentary."""

# Per-language script ranges, mirrored from dub_translate.LANG_REQUIRED_SCRIPT
# so the cinematic refine path can reject LLM outputs that drifted off the
# target script. Kept local instead of imported because the routers package
# also imports this services module — circular-import risk otherwise.
_SCRIPT_RANGES = {
    "hi":    (0x0900, 0x097F),
    "ar":    (0x0600, 0x06FF),
    "zh":    (0x4E00, 0x9FFF),
    "zh-CN": (0x4E00, 0x9FFF),
    "ja":    (0x3040, 0x30FF),
    "ko":    (0xAC00, 0xD7AF),
    "th":    (0x0E00, 0x0E7F),
    "ru":    (0x0400, 0x04FF),
    "uk":    (0x0400, 0x04FF),
}


def _looks_like_target_script(text: str, code: str, threshold: float = 0.5) -> bool:
    rng = _SCRIPT_RANGES.get(code)
    if not rng:
        return True
    lo, hi = rng
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return True
    inside = sum(1 for c in letters if lo <= ord(c) <= hi)
    return (inside / len(letters)) >= threshold


def _llm_client():
    """Lazy-build the OpenAI-compatible client. Returns None if no key + no local base_url."""
    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai package not installed — cinematic mode unavailable.")
        return None
    base_url = os.environ.get("TRANSLATE_BASE_URL")
    api_key = (
        os.environ.get("TRANSLATE_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or ("local" if base_url else None)  # local providers often accept any key
    )
    if not api_key:
        return None
    kw = {"api_key": api_key}
    if base_url:
        kw["base_url"] = base_url
    return OpenAI(**kw)


def _llm_model() -> str:
    return os.environ.get("TRANSLATE_MODEL", "gpt-4o-mini")


def _llm_timeout() -> float:
    try:
        return float(os.environ.get("OMNIVOICE_LLM_TIMEOUT", "45"))
    except ValueError:
        return 45.0


def _glossary_text(glossary: Iterable[dict] | None) -> str:
    """Format the project glossary as a preamble for the LLM prompts.

    Empty / None → empty string. Otherwise one "SRC → TGT" per line.
    """
    if not glossary:
        return ""
    lines = []
    for entry in glossary:
        src = (entry.get("source") or "").strip()
        tgt = (entry.get("target") or "").strip()
        if not src or not tgt:
            continue
        note = (entry.get("note") or "").strip()
        lines.append(f"- {src} → {tgt}" + (f"  (note: {note})" if note else ""))
    if not lines:
        return ""
    return (
        "Project glossary — every occurrence of a source term must be rendered "
        "as its target, unless the critique explicitly overrides it:\n"
        + "\n".join(lines)
    )


def _chat(client, *, system: str, user: str) -> str:
    """One-shot chat completion. Raises on failure."""
    res = client.chat.completions.create(
        model=_llm_model(),
        timeout=_llm_timeout(),
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return (res.choices[0].message.content or "").strip()


# ── Public API ──────────────────────────────────────────────────────────────


def cinematic_available() -> bool:
    """Cheap check so callers can warn early rather than after a full translate run."""
    return _llm_client() is not None


def cinematic_refine_sync(
    source_text: str,
    literal_text: str,
    *,
    source_lang: str,
    target_lang: str,
    glossary: Iterable[dict] | None = None,
    direction: Optional[str] = None,
) -> dict:
    """Blocking: run REFLECT + ADAPT on a single segment.

    Returns `{"text", "literal", "critique"}` on success. On LLM failure,
    returns `{"text": literal_text, "literal": literal_text, "critique": "",
    "error": "…"}` so the caller can keep going and surface a warning.

    Meant to run in a threadpool; the async wrapper below handles dispatch.
    """
    result_ok = {
        "text": literal_text,
        "literal": literal_text,
        "critique": "",
    }
    if not literal_text or not literal_text.strip():
        return result_ok

    client = _llm_client()
    if client is None:
        return {**result_ok, "error": "no-llm"}

    glossary_preamble = _glossary_text(glossary)

    # Phase 4.2 — if a direction was supplied, compute a translate hint that
    # feeds into both reflect and adapt prompts. Parser picks up taxonomy
    # tokens via LLM when configured, falls back to a keyword heuristic.
    direction_hint = ""
    if direction and direction.strip():
        try:
            from services.director import parse as _parse_direction
            d = _parse_direction(direction)
            direction_hint = d.translate_hint()
        except Exception as e:
            logger.debug("director parse skipped: %s", e)

    def _with_preamble(base: str) -> str:
        out = base
        if glossary_preamble:
            out = out + "\n\n" + glossary_preamble
        if direction_hint:
            out = out + "\n\nDirection: " + direction_hint
        return out

    # Step 2 — reflect
    try:
        reflect_user = (
            f"Source ({source_lang}): {source_text}\n"
            f"Literal translation ({target_lang}): {literal_text}"
        )
        critique = _chat(client, system=_with_preamble(_REFLECT_PROMPT), user=reflect_user)
    except Exception as e:
        logger.warning("cinematic reflect failed: %s", e)
        return {**result_ok, "error": f"reflect: {e}"}

    # Step 3 — adapt
    try:
        adapt_user = (
            f"Source ({source_lang}): {source_text}\n"
            f"Literal translation ({target_lang}): {literal_text}\n"
            f"Editor's critique: {critique}"
        )
        adapted = _chat(client, system=_with_preamble(_ADAPT_PROMPT), user=adapt_user)
    except Exception as e:
        logger.warning("cinematic adapt failed: %s", e)
        return {
            "text": literal_text,
            "literal": literal_text,
            "critique": critique,
            "error": f"adapt: {e}",
        }

    final = (adapted or "").strip() or literal_text
    # Refuse adaptations that drifted off the target script (e.g. local LLM
    # rewrote a Devanagari line in Latin/German). Caller still gets the
    # critique so the UI can show what happened, but the live text falls
    # back to the literal translation rather than corrupting the dub.
    if final is not literal_text and not _looks_like_target_script(final, target_lang):
        logger.warning(
            "cinematic adapt produced wrong-script output for %s — falling back to literal",
            target_lang,
        )
        return {
            "text": literal_text,
            "literal": literal_text,
            "critique": critique,
            "error": f"adapt-wrong-script:{target_lang}",
        }
    return {
        "text": final,
        "literal": literal_text,
        "critique": critique,
    }


async def cinematic_refine_many(
    pairs: list[tuple],
    *,
    source_lang: str,
    target_lang: str,
    glossary: Iterable[dict] | None = None,
    directions: Optional[dict[str, str]] = None,
    executor=None,
    concurrency: int | None = None,
) -> list[dict]:
    """Fan out REFLECT + ADAPT across N segments on `executor`.

    `pairs`: list of `(id, source_text, literal_text)`.
    `directions`: optional `{seg_id: "natural-language direction"}` — when
        present, the matching segment's reflect/adapt prompts get the parsed
        direction hint prepended.
    Returns a list of dicts keyed the same length + order, each carrying
    `id`, `text`, `literal`, `critique`, optional `error`.
    """
    loop = asyncio.get_event_loop()
    directions = directions or {}

    # Bound concurrency so we don't fan out 500 simultaneous requests.
    sem = asyncio.Semaphore(concurrency or int(os.environ.get("OMNIVOICE_LLM_CONCURRENCY", "6")))

    async def _one(seg_id: str, src: str, lit: str) -> dict:
        async with sem:
            res = await loop.run_in_executor(
                executor,
                lambda: cinematic_refine_sync(
                    src, lit,
                    source_lang=source_lang,
                    target_lang=target_lang,
                    glossary=glossary,
                    direction=directions.get(seg_id),
                ),
            )
        return {"id": seg_id, **res}

    return await asyncio.gather(*(_one(sid, src, lit) for sid, src, lit in pairs))
