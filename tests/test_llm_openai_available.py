"""Regression guard: the `openai` client must stay a declared dependency.

Cinematic dub refinement, glossary auto-extract, and LLM-based translation all
`from openai import OpenAI`. It was previously undeclared in pyproject, so a fresh
`uv sync` never installed it and Cinematic was dead-on-arrival on every source
install — the UI showed "Cinematic needs an LLM" even with Ollama running and
configured, because `OpenAICompatBackend.is_available()` returned "openai package
missing" (reported on Discord). These tests fail loudly if the dep is dropped.
"""
from __future__ import annotations


def test_openai_client_importable():
    import openai  # noqa: F401
    from openai import OpenAI  # noqa: F401


def test_llm_backend_not_blocked_by_missing_openai_package():
    from services.llm_backend import OpenAICompatBackend

    ok, msg = OpenAICompatBackend.is_available()
    # Without a configured endpoint it's still unavailable — but the reason must
    # be "configure an endpoint", NOT "openai package missing".
    assert "package missing" not in msg.lower(), msg
