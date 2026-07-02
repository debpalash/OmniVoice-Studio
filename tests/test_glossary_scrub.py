"""Glossary auto-extract — provider-error scrubbing + no-LLM guidance.

The auto-extract endpoint reuses the translator's LLM client. A provider that
echoes the API key / a user_id / a home path in its error body must not surface
that verbatim in the 502 detail, and the no-LLM 503 must point users at the
current setup surface (Settings → LLM Providers), not the legacy env vars.
"""
import os

os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest
from fastapi import HTTPException


def _req(**kw):
    # AutoExtractRequest is defined in the glossary router module.
    from api.routers.glossary import AutoExtractRequest
    return AutoExtractRequest(**kw)


def test_auto_extract_no_llm_points_at_llm_providers(monkeypatch):
    from api.routers import glossary
    from services import translator
    monkeypatch.setattr(translator, "_llm_client", lambda: None)

    req = _req(target_lang="es", segments=[{"text": "Hello Marcus"}])
    with pytest.raises(HTTPException) as ei:
        glossary.auto_extract("proj1", req)
    detail = ei.value.detail
    assert ei.value.status_code == 503
    assert "LLM Providers" in detail
    # The stale env-var-only guidance must be gone.
    assert "TRANSLATE_BASE_URL" not in detail
    assert "TRANSLATE_API_KEY" not in detail


def test_auto_extract_scrubs_provider_error(monkeypatch):
    from api.routers import glossary
    from services import translator

    secret = "sk-LEAKLEAKLEAKLEAKLEAK12345"
    home = "/Users/alice/videos"

    class _Completions:
        def create(self, **kw):
            raise RuntimeError(f"401 bad key {secret} user_id=acct_9 at {home}")

    class _Chat:
        completions = _Completions()

    class _Client:
        chat = _Chat()

    monkeypatch.setattr(translator, "_llm_client", lambda: _Client())
    monkeypatch.setattr(translator, "_llm_model", lambda: "m")
    monkeypatch.setattr(translator, "_llm_timeout", lambda: 1.0)

    req = _req(target_lang="es", segments=[{"text": "Hello Marcus"}])
    with pytest.raises(HTTPException) as ei:
        glossary.auto_extract("proj1", req)
    detail = ei.value.detail
    assert ei.value.status_code == 502
    assert secret not in detail
    assert home not in detail
    assert "***REDACTED***" in detail
