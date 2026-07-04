"""Tests for the regional-dialect translation hint (#280, item 2).

The dialect rides on LLM-backed translation paths only (provider="openai"
and the quality="cinematic" refine). Non-LLM providers can't honor it and
the response says so via `dialect_applied: false`.
"""
from __future__ import annotations

import pytest


# ── dialect_clause ──────────────────────────────────────────────────────────


def test_dialect_clause_curated_entries():
    from api.routers.dub_translate import DIALECT_HINTS, dialect_clause
    # The issue-280 example: Argentina → voseo.
    clause = dialect_clause("es-AR")
    assert "vos" in clause.lower()
    # Every curated entry must produce a non-empty clause containing its hint.
    for code, hint in DIALECT_HINTS.items():
        assert hint in dialect_clause(code), code


def test_dialect_clause_generic_fallback_for_uncurated_region():
    from api.routers.dub_translate import dialect_clause
    clause = dialect_clause("es-PE")
    assert "Spanish" in clause
    assert "PE" in clause


def test_dialect_clause_empty_for_unset_or_bare_code():
    from api.routers.dub_translate import dialect_clause
    assert dialect_clause(None) == ""
    assert dialect_clause("") == ""
    assert dialect_clause("   ") == ""
    # A bare language code carries no regional information.
    assert dialect_clause("es") == ""


# ── schema ──────────────────────────────────────────────────────────────────


def test_translate_request_accepts_dialect_and_defaults_none():
    from schemas.requests import TranslateRequest
    req = TranslateRequest(segments=[], target_lang="es")
    assert req.dialect is None
    req = TranslateRequest(segments=[], target_lang="es", dialect="es-AR")
    assert req.dialect == "es-AR"


def test_translate_segment_keeps_direction_and_slot_seconds():
    """Regression: the frontend has always sent `direction`/`slot_seconds`,
    but pydantic dropped them as undeclared extras — so the per-segment
    direction hint and the rate-ratio prediction silently never ran."""
    from schemas.requests import TranslateSegment
    seg = TranslateSegment(id="s1", text="hello", direction="urgent", slot_seconds=2.5)
    assert seg.direction == "urgent"
    assert seg.slot_seconds == 2.5
    # And both stay optional for older callers.
    seg2 = TranslateSegment(id="s2", text="hi")
    assert seg2.direction is None and seg2.slot_seconds is None


# ── dialect_applied response flags ──────────────────────────────────────────


def test_dialect_flags_absent_when_not_requested():
    from api.routers.dub_translate import _dialect_flags
    from schemas.requests import TranslateRequest
    req = TranslateRequest(segments=[], target_lang="es")
    assert _dialect_flags(req, applied=True) == {}


def test_dialect_flags_present_when_requested():
    from api.routers.dub_translate import _dialect_flags
    from schemas.requests import TranslateRequest
    req = TranslateRequest(segments=[], target_lang="es", dialect="es-AR")
    assert _dialect_flags(req, applied=True) == {"dialect": "es-AR", "dialect_applied": True}
    assert _dialect_flags(req, applied=False) == {"dialect": "es-AR", "dialect_applied": False}


# ── cinematic prompt threading ──────────────────────────────────────────────


def test_cinematic_refine_sync_injects_dialect_into_prompts(monkeypatch):
    from services import translator

    captured_systems = []
    # Distinct reflect/adapt replies — an adapt identical to the critique is
    # (correctly) rejected by the divergence guard as a critique echo.
    replies = iter(["usa voseo rioplatense", "vos sos muy listo"])

    def fake_chat(client, *, system, user):
        captured_systems.append(system)
        return next(replies)

    monkeypatch.setattr(translator, "_llm_client", lambda: object())
    monkeypatch.setattr(translator, "_chat", fake_chat)

    res = translator.cinematic_refine_sync(
        "You are very clever",
        "tú eres muy listo",
        source_lang="en",
        target_lang="es",
        dialect_hint="Rioplatense Spanish (Argentina): use voseo.",
    )
    assert res["text"] == "vos sos muy listo"
    # Both REFLECT and ADAPT system prompts carry the dialect clause.
    assert len(captured_systems) == 2
    for sys_prompt in captured_systems:
        assert "Dialect: Rioplatense Spanish (Argentina): use voseo." in sys_prompt


def test_cinematic_refine_sync_no_dialect_keeps_prompts_clean(monkeypatch):
    from services import translator

    captured_systems = []

    def fake_chat(client, *, system, user):
        captured_systems.append(system)
        return "hola"

    monkeypatch.setattr(translator, "_llm_client", lambda: object())
    monkeypatch.setattr(translator, "_chat", fake_chat)

    translator.cinematic_refine_sync(
        "hello", "hola", source_lang="en", target_lang="es",
    )
    assert all("Dialect:" not in s for s in captured_systems)


# ── response shape via _maybe_cinematic ─────────────────────────────────────


def test_fast_quality_reports_dialect_not_applied():
    """Fast mode with a non-LLM provider can't honor the dialect — the
    response must say so, so the UI can tell the user how to enable it."""
    import asyncio
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest

    async def _run():
        req = TranslateRequest(
            segments=[], target_lang="es", quality="fast", dialect="es-AR",
        )
        return await dub_translate._maybe_cinematic(
            [], req, "en", asyncio.get_running_loop(),
        )

    res = asyncio.run(_run())
    assert res["dialect"] == "es-AR"
    assert res["dialect_applied"] is False


def test_cinematic_quality_reports_dialect_applied(monkeypatch):
    import asyncio
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest, TranslateSegment

    captured = {}

    async def fake_refine_many(pairs, *, dialect_hint=None, **kw):
        captured["dialect_hint"] = dialect_hint
        return [
            {"id": sid, "text": "vos sos muy listo", "literal": lit, "critique": "c"}
            for sid, _src, lit in pairs
        ]

    monkeypatch.setattr(dub_translate, "cinematic_available", lambda: True)
    monkeypatch.setattr(dub_translate, "cinematic_refine_many", fake_refine_many)

    async def _run():
        req = TranslateRequest(
            segments=[TranslateSegment(id="s1", text="You are very clever")],
            target_lang="es", quality="cinematic", dialect="es-AR",
        )
        translated = [{"id": "s1", "text": "tú eres muy listo"}]
        return await dub_translate._maybe_cinematic(
            translated, req, "en", asyncio.get_running_loop(),
        )

    res = asyncio.run(_run())
    assert res["dialect_applied"] is True
    assert "vos" in captured["dialect_hint"].lower()
    assert res["translated"][0]["text"] == "vos sos muy listo"


def test_cinematic_ignores_dialect_from_other_language(monkeypatch):
    """A leftover es-AR dialect must not contaminate a French translation."""
    import asyncio
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest, TranslateSegment

    captured = {}

    async def fake_refine_many(pairs, *, dialect_hint=None, **kw):
        captured["dialect_hint"] = dialect_hint
        return [
            {"id": sid, "text": lit, "literal": lit, "critique": ""}
            for sid, _src, lit in pairs
        ]

    monkeypatch.setattr(dub_translate, "cinematic_available", lambda: True)
    monkeypatch.setattr(dub_translate, "cinematic_refine_many", fake_refine_many)

    async def _run():
        req = TranslateRequest(
            segments=[TranslateSegment(id="s1", text="hello")],
            target_lang="fr", quality="cinematic", dialect="es-AR",
        )
        return await dub_translate._maybe_cinematic(
            [{"id": "s1", "text": "bonjour"}], req, "en",
            asyncio.get_running_loop(),
        )

    res = asyncio.run(_run())
    assert captured["dialect_hint"] == ""
    assert res["dialect_applied"] is False
