"""LLM provider registry — resolution precedence + no-key-leak (Settings → LLM
Providers, v0.3.8).

Covers the field-resolution logic (env override → encrypted store → default),
active-provider selection, local-provider handling, and the client-safe
descriptor that must never carry key material. The encrypted round-trip itself
(settings_store.set_secret/get_secret) reuses the proven HF-token Fernet path.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def lp(monkeypatch, clean_llm_env):
    """llm_providers with settings_store backed by in-memory dicts (no SQLite).

    clean_llm_env (conftest) clears the FULL provider env surface — a partial
    list left other providers' keys standing when an earlier `main` import
    dotenv-loaded them into os.environ, breaking precedence asserts (#878).
    """
    from services import settings_store as ss
    from services import llm_providers as _lp

    text: dict[str, str] = {}
    secrets: dict[str, str] = {}

    monkeypatch.setattr(ss, "get_text", lambda k, default=None: text.get(k, default))
    monkeypatch.setattr(ss, "set_text", lambda k, v: text.__setitem__(k, v))
    monkeypatch.setattr(ss, "get_secret", lambda n: secrets.get(n))
    monkeypatch.setattr(ss, "set_secret", lambda n, v: secrets.__setitem__(n, v) if v else secrets.pop(n, None))
    monkeypatch.setattr(ss, "list_secret_names", lambda: list(secrets))
    _lp._text, _lp._secrets = text, secrets  # handles for the test to seed
    return _lp


def test_registry_has_all_providers(lp):
    ids = {p.id for p in lp.all_providers()}
    # 12 cloud + 2 local + custom + openai
    for expected in ("openai", "openrouter", "groq", "cerebras", "google-ai",
                     "mistral", "cohere", "nvidia", "github-models", "cloudflare",
                     "huggingface", "sambanova", "siliconflow", "ollama",
                     "lmstudio", "custom"):
        assert expected in ids, expected


def test_default_base_url_and_model(lp):
    d = lp.describe(lp.get_provider("groq"))
    assert d["base_url"] == "https://api.groq.com/openai/v1"
    assert d["model"] == "llama-3.3-70b-versatile"
    assert d["has_key"] is False and d["configured"] is False


def test_env_key_wins_and_is_flagged(lp, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_env_value")
    d = lp.describe(lp.get_provider("groq"))
    assert d["has_key"] is True
    assert d["key_from_env"] is True
    assert d["configured"] is True
    assert lp.resolve_api_key(lp.get_provider("groq")) == "gsk_env_value"


def test_stored_key_used_when_no_env(lp):
    lp._secrets["llm_key.groq"] = "gsk_stored"
    p = lp.get_provider("groq")
    assert lp.has_key(p) is True
    assert lp.resolve_api_key(p) == "gsk_stored"
    d = lp.describe(p)
    assert d["has_key"] is True and d["key_from_env"] is False


def test_env_overrides_stored_key(lp, monkeypatch):
    lp._secrets["llm_key.groq"] = "gsk_stored"
    monkeypatch.setenv("GROQ_API_KEY", "gsk_env")
    assert lp.resolve_api_key(lp.get_provider("groq")) == "gsk_env"


def test_base_url_and_model_overrides(lp):
    lp._text["llm.base_url.custom"] = "http://localhost:9000/v1"
    lp._text["llm.model.custom"] = "my-model"
    p = lp.get_provider("custom")
    assert lp.resolve_base_url(p) == "http://localhost:9000/v1"
    assert lp.resolve_model(p) == "my-model"


def test_local_provider_needs_no_key(lp):
    p = lp.get_provider("ollama")
    assert lp.has_key(p) is True
    assert lp.resolve_api_key(p) == "local"
    assert lp.is_configured(p) is True  # has default base_url + local


def test_cloudflare_account_interpolation(lp):
    p = lp.get_provider("cloudflare")
    assert p.needs_account
    # No account yet → empty segment
    assert "accounts//ai/v1" in lp.resolve_base_url(p)
    lp.save_overrides("cloudflare", account_id="abc123")
    assert "accounts/abc123/ai/v1" in lp.resolve_base_url(p)


def test_active_provider_precedence(lp, monkeypatch):
    # Nothing configured → None
    assert lp.active_provider_id() is None
    # A configured provider auto-selects
    lp._secrets["llm_key.groq"] = "k"
    assert lp.active_provider_id() == "groq"
    # Stored selection wins over auto
    lp.set_active_provider("mistral")
    lp._secrets["llm_key.mistral"] = "k2"
    assert lp.active_provider_id() == "mistral"
    # Env LLM_DEFAULT_PROVIDER wins over everything
    monkeypatch.setenv("LLM_DEFAULT_PROVIDER", "openrouter")
    assert lp.active_provider_id() == "openrouter"


def test_legacy_translate_base_url_maps_to_custom(lp, monkeypatch):
    monkeypatch.setenv("TRANSLATE_BASE_URL", "http://legacy:11434/v1")
    assert lp.active_provider_id() == "custom"


def test_describe_never_leaks_key(lp, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_super_secret")
    d = lp.describe(lp.get_provider("groq"))
    assert "gsk_super_secret" not in repr(d)
    assert "api_key" not in d and "key" not in d  # only boolean flags
    assert set(["has_key", "key_from_env"]).issubset(d)
