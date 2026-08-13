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


def test_provider_hint_names_the_active_provider_only_for_openai_compat(monkeypatch):
    """The catalogue's LLM row must say WHICH provider answers (#coherence):
    llm_backend and the LLM Providers panel are one system, and the hint is
    the row-level proof of that. Other backends carry no hint, and a
    provider-registry failure degrades to no hint, never to a crash."""
    from services import llm_backend, llm_providers

    class _P:
        display_name = "OrcaRouter"

    monkeypatch.setattr(llm_providers, "active_provider", lambda: _P())
    monkeypatch.setattr(llm_providers, "resolve_model", lambda p: "gpt-4o-mini")
    assert llm_backend._provider_hint("openai-compat") == "OrcaRouter · gpt-4o-mini"
    assert llm_backend._provider_hint("off") is None

    monkeypatch.setattr(llm_providers, "resolve_model", lambda p: "")
    assert llm_backend._provider_hint("openai-compat") == "OrcaRouter"

    def _boom():
        raise RuntimeError("registry unavailable")

    monkeypatch.setattr(llm_providers, "active_provider", _boom)
    assert llm_backend._provider_hint("openai-compat") is None
