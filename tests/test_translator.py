"""Phase 1.1 / 2.7 — translator service.

Validates the glossary prompt-prefixing and the graceful "no LLM" path.
Does NOT hit a real LLM — the client is mocked.
"""
import os
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

from unittest.mock import MagicMock, patch
import pytest

from services import translator as tr


# ── Glossary preamble ──────────────────────────────────────────────────────


def test_glossary_text_empty_inputs():
    assert tr._glossary_text(None) == ""
    assert tr._glossary_text([]) == ""
    assert tr._glossary_text([{"source": "", "target": "y"}]) == ""


def test_glossary_text_includes_each_term():
    out = tr._glossary_text([
        {"source": "Marcus", "target": "Marcus", "note": "character name"},
        {"source": "breakthrough", "target": "Durchbruch"},
    ])
    assert "Marcus → Marcus" in out
    assert "breakthrough → Durchbruch" in out
    assert "character name" in out


# ── No-LLM graceful path ───────────────────────────────────────────────────


def test_cinematic_no_llm_returns_literal_with_marker(monkeypatch):
    monkeypatch.setattr(tr, "_llm_client", lambda: None)
    res = tr.cinematic_refine_sync(
        "Hello.",
        "Hola.",
        source_lang="en",
        target_lang="es",
    )
    # With no LLM, "text" falls back to literal and an error marker is present.
    assert res["text"] == "Hola."
    assert res["literal"] == "Hola."
    assert res["critique"] == ""
    assert res.get("error") == "no-llm"


def test_cinematic_empty_literal_is_passthrough():
    res = tr.cinematic_refine_sync(
        "Source",
        "",
        source_lang="en",
        target_lang="es",
    )
    assert res["text"] == ""
    assert res["literal"] == ""
    # No error when there's literally nothing to refine.
    assert "error" not in res


# ── Happy-path 3-step chain (mocked client) ────────────────────────────────


def test_cinematic_full_chain_with_mocked_llm(monkeypatch):
    calls = []
    responses = iter([
        "reads stiff; prefer idiomatic phrasing",  # reflect
        "Hola, mundo.",                             # adapt
    ])

    def fake_chat(client, *, system, user):
        calls.append({"system": system, "user": user})
        return next(responses)

    mock_client = MagicMock()
    monkeypatch.setattr(tr, "_llm_client", lambda: mock_client)
    monkeypatch.setattr(tr, "_chat", fake_chat)

    res = tr.cinematic_refine_sync(
        "Hello, world.",
        "Hola mundo.",
        source_lang="en",
        target_lang="es",
        glossary=[{"source": "world", "target": "mundo"}],
    )
    assert res["literal"] == "Hola mundo."
    assert res["text"] == "Hola, mundo."
    assert res["critique"] == "reads stiff; prefer idiomatic phrasing"
    assert len(calls) == 2
    # Glossary prepended to both system prompts (reflect + adapt).
    assert "world → mundo" in calls[0]["system"]
    assert "world → mundo" in calls[1]["system"]


def test_cinematic_reflect_failure_returns_literal(monkeypatch):
    mock_client = MagicMock()
    monkeypatch.setattr(tr, "_llm_client", lambda: mock_client)

    def boom(*a, **kw):
        raise RuntimeError("LLM down")
    monkeypatch.setattr(tr, "_chat", boom)

    res = tr.cinematic_refine_sync(
        "Hello",
        "Hola",
        source_lang="en",
        target_lang="es",
    )
    assert res["text"] == "Hola"
    assert res["literal"] == "Hola"
    assert "reflect" in res.get("error", "")
