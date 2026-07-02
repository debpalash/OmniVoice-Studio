"""Router surface for /api/settings/llm-providers (v0.3.9 testing pass).

`tests/test_llm_providers.py` covers the registry service; these cover the
router handlers the UI calls — the /test probe's error classification
(kind: config/auth/not_found/rate_limit/network/error + latency_ms) and the
/models discovery endpoint, with the OpenAI client faked at the SDK boundary
(no network) and settings_store backed by in-memory dicts (house convention,
same as test_llm_providers.py — direct handler calls, no TestClient, so the
loopback auth guard isn't in play).
"""
from __future__ import annotations

import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

_HAS_OPENAI = __import__("importlib").util.find_spec("openai") is not None
pytestmark = pytest.mark.skipif(not _HAS_OPENAI, reason="openai package not installed")


@pytest.fixture
def settings_mod(monkeypatch, clean_llm_env):
    """Router module with settings_store in-memory (no SQLite, no prefs I/O).

    clean_llm_env (conftest) clears the FULL provider env surface so probes
    resolve only the seeded in-memory state, not ambient/.env keys (#878).
    """
    from services import settings_store as ss

    text: dict[str, str] = {}
    secrets: dict[str, str] = {}
    monkeypatch.setattr(ss, "get_text", lambda k, default=None: text.get(k, default))
    monkeypatch.setattr(ss, "set_text", lambda k, v: text.__setitem__(k, v))
    monkeypatch.setattr(ss, "get_secret", lambda n: secrets.get(n))
    monkeypatch.setattr(ss, "set_secret", lambda n, v: secrets.__setitem__(n, v) if v else secrets.pop(n, None))
    monkeypatch.setattr(ss, "list_secret_names", lambda: list(secrets))
    import importlib
    return importlib.import_module("api.routers.settings")


def _fake_openai(monkeypatch, *, reply="ok", models=None, raise_exc=None):
    """Fake `openai.OpenAI` with canned chat/models behavior."""
    class _Msg:
        def __init__(self, content):
            self.message = types.SimpleNamespace(content=content)

    class _FakeClient:
        def __init__(self, api_key=None, base_url=None):
            self.chat = types.SimpleNamespace(
                completions=types.SimpleNamespace(create=self._create))
            self.models = types.SimpleNamespace(list=self._models)

        def _create(self, **kw):
            if raise_exc is not None:
                raise raise_exc
            return types.SimpleNamespace(choices=[_Msg(reply)])

        def _models(self, **kw):
            if raise_exc is not None:
                raise raise_exc
            return [types.SimpleNamespace(id=m) for m in (models or [])]

    import openai
    monkeypatch.setattr(openai, "OpenAI", _FakeClient)


def _configure_groq(settings_mod, key="gsk-test-123"):
    settings_mod.save_llm_provider(
        "groq", settings_mod._LLMProviderBody(api_key=key, make_active=True))


# ── list / save ─────────────────────────────────────────────────────────────

def test_list_never_leaks_keys(settings_mod):
    _configure_groq(settings_mod)
    body = settings_mod.list_llm_providers()
    assert body["active"] == "groq"
    groq = next(p for p in body["providers"] if p["id"] == "groq")
    assert groq["has_key"] is True and groq["configured"] is True
    assert "gsk-test-123" not in str(body)  # the key never round-trips


def test_unknown_provider_404s(settings_mod):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        settings_mod.test_llm_provider("nope")
    with pytest.raises(HTTPException):
        settings_mod.list_llm_provider_models("nope")


# ── /test probe ─────────────────────────────────────────────────────────────

def test_probe_ok_includes_latency(settings_mod, monkeypatch):
    _configure_groq(settings_mod)
    _fake_openai(monkeypatch, reply="ok")
    body = settings_mod.test_llm_provider("groq")
    assert body["ok"] is True and body["reply"] == "ok"
    assert isinstance(body["latency_ms"], int) and body["latency_ms"] >= 0


def test_probe_unconfigured_is_kind_config(settings_mod):
    # openai: no key stored, env cleared → config guidance, no network attempt
    body = settings_mod.test_llm_provider("openai")
    assert body["ok"] is False and body["kind"] == "config"


@pytest.mark.parametrize("exc_name,status,expected_kind", [
    ("AuthenticationError", 401, "auth"),
    ("NotFoundError", 404, "not_found"),
    ("RateLimitError", 429, "rate_limit"),
    ("APIConnectionError", None, "network"),
    ("ValueError", None, "error"),
])
def test_probe_classifies_failures(settings_mod, monkeypatch, exc_name, status, expected_kind):
    _configure_groq(settings_mod)
    exc = type(exc_name, (Exception,), {})()
    if status is not None:
        exc.status_code = status
    _fake_openai(monkeypatch, raise_exc=exc)
    body = settings_mod.test_llm_provider("groq")
    assert body["ok"] is False
    assert body["kind"] == expected_kind
    assert "latency_ms" in body


def test_probe_failure_detail_is_scrubbed(settings_mod, monkeypatch):
    _configure_groq(settings_mod)
    _fake_openai(monkeypatch, raise_exc=RuntimeError(
        "boom key=gsk-test-123 at /Users/someone/secret"))
    body = settings_mod.test_llm_provider("groq")
    assert body["ok"] is False
    assert "gsk-test-123" not in body["detail"]


# ── /models discovery ───────────────────────────────────────────────────────

def test_models_lists_sorted_ids(settings_mod, monkeypatch):
    _configure_groq(settings_mod)
    _fake_openai(monkeypatch, models=["zeta", "alpha", "mid"])
    body = settings_mod.list_llm_provider_models("groq")
    assert body["ok"] is True
    assert body["models"] == ["alpha", "mid", "zeta"]


def test_models_unconfigured_is_kind_config(settings_mod):
    body = settings_mod.list_llm_provider_models("openai")
    assert body == {"ok": False, "kind": "config", "models": []}


def test_models_failure_is_classified(settings_mod, monkeypatch):
    _configure_groq(settings_mod)
    exc = type("AuthenticationError", (Exception,), {})()
    exc.status_code = 401
    _fake_openai(monkeypatch, raise_exc=exc)
    body = settings_mod.list_llm_provider_models("groq")
    assert body["ok"] is False and body["kind"] == "auth" and body["models"] == []
