"""LLM provider registry — resolution precedence + no-key-leak (Settings → LLM
Providers, v0.3.8).

Covers the field-resolution logic (env override → encrypted store → default),
active-provider selection, local-provider handling, and the client-safe
descriptor that must never carry key material. The encrypted round-trip itself
(settings_store.set_secret/get_secret) reuses the proven HF-token Fernet path.
"""
from __future__ import annotations

import json
import os

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


# ── env-override surfacing (silent-revert / dead make-active traps) ──────────

def test_describe_reports_env_override_flags(lp, monkeypatch):
    p = lp.get_provider("groq")
    d = lp.describe(p)
    assert d["base_url_from_env"] is False
    assert d["model_from_env"] is False
    assert d["active_from_env"] is False
    monkeypatch.setenv("GROQ_BASE_URL", "http://env/v1")
    monkeypatch.setenv("GROQ_MODEL", "env-model")
    monkeypatch.setenv("LLM_DEFAULT_PROVIDER", "groq")
    d = lp.describe(p)
    assert d["base_url_from_env"] is True
    assert d["model_from_env"] is True
    assert d["active_from_env"] is True
    # active_from_env is a GLOBAL pin (LLM_DEFAULT_PROVIDER) — true for every
    # provider while set, so the UI disables make-active everywhere.
    assert lp.describe(lp.get_provider("openai"))["active_from_env"] is True


def test_active_from_env_ignores_unknown_provider(lp, monkeypatch):
    monkeypatch.setenv("LLM_DEFAULT_PROVIDER", "not-a-provider")
    assert lp.describe(lp.get_provider("groq"))["active_from_env"] is False


# ── Cloudflare account-id round-trip + no frozen base_url override ───────────

def test_describe_returns_account_id_and_raw_template(lp):
    p = lp.get_provider("cloudflare")
    lp.save_overrides("cloudflare", account_id="acct-9")
    d = lp.describe(p)
    # (a) the stored account id round-trips so the field isn't reset to empty
    assert d["account_id"] == "acct-9"
    assert d["account_from_env"] is False
    # describe shows the RAW template, not the {account_id}-baked value, so
    # saving it back can't freeze the URL.
    assert "{account_id}" in d["base_url"]


def test_account_change_takes_effect_not_frozen(lp):
    """Regression: the UI posts the shown base_url back on every save. Saving a
    value equal to the default template must NOT persist a frozen override, so
    later account-id changes keep taking effect (the P2 bug)."""
    p = lp.get_provider("cloudflare")
    template = lp.describe(p)["base_url"]  # what the field shows
    lp.save_overrides("cloudflare", base_url=template, account_id="acct-1")
    assert lp._text.get("llm.base_url.cloudflare", "") == ""  # not frozen
    assert "accounts/acct-1/ai/v1" in lp.resolve_base_url(p)
    # Change ONLY the account later — must be reflected, not stuck on acct-1.
    lp.save_overrides("cloudflare", base_url=template, account_id="acct-2")
    assert "accounts/acct-2/ai/v1" in lp.resolve_base_url(p)


def test_real_base_url_override_still_persists(lp):
    # A genuinely custom URL (≠ default) is still stored as an override.
    lp.save_overrides("groq", base_url="http://my-proxy/v1")
    assert lp._text["llm.base_url.groq"] == "http://my-proxy/v1"
    assert lp.resolve_base_url(lp.get_provider("groq")) == "http://my-proxy/v1"


# ── #963: stale TRANSLATE_* prefs migration + explicit-save activation ──────
# The retired (≤v0.3.7) Translation-LLM panel persisted env.TRANSLATE_* rows
# in prefs.json; main.py re-imported them into os.environ every launch, which
# made active_provider_id() resolve to "custom" ahead of auto-select on every
# restart — hijacking the slot from whatever the user saved.


@pytest.fixture
def legacy_prefs(monkeypatch, tmp_path):
    """core.prefs redirected to a temp prefs.json seeded with the retired
    Translation-LLM panel's persisted rows (plus non-LLM rows that must
    survive the migration untouched)."""
    from core import prefs

    path = tmp_path / "prefs.json"
    path.write_text(json.dumps({
        "env.TRANSLATE_BASE_URL": "http://legacy:11434/v1",
        "env.TRANSLATE_MODEL": "legacy-model",
        "env.TRANSLATE_API_KEY": "sk-legacy",
        "env.HTTP_PROXY": "http://proxy:1",
        "tts_backend": "omnivoice",
    }), encoding="utf-8")
    monkeypatch.setattr(prefs, "_PREFS_PATH", str(path))
    return prefs


def test_migration_moves_prefs_into_custom_store_and_deletes_rows(lp, legacy_prefs):
    assert lp.migrate_legacy_translate_prefs() is True
    # values live in the custom provider's own store rows now…
    assert lp._text["llm.base_url.custom"] == "http://legacy:11434/v1"
    assert lp._text["llm.model.custom"] == "legacy-model"
    assert lp._secrets["llm_key.custom"] == "sk-legacy"
    # …the prefs rows are gone (nothing left to re-import as env)…
    data = legacy_prefs._load()
    assert not any(k.startswith("env.TRANSLATE") for k in data)
    # …and rows the migration doesn't own keep persisting.
    assert data["env.HTTP_PROXY"] == "http://proxy:1"
    assert data["tts_backend"] == "omnivoice"
    # The legacy endpoint keeps working, now via the store.
    p = lp.get_provider("custom")
    assert lp.resolve_base_url(p) == "http://legacy:11434/v1"
    assert lp.is_configured(p) is True


def test_migration_runs_exactly_once_and_never_overwrites(lp, legacy_prefs):
    assert lp.migrate_legacy_translate_prefs() is True
    # The user later edits the custom provider…
    lp.save_overrides("custom", base_url="http://mine/v1", model="my-model")
    lp.save_key("custom", "sk-mine")
    # …a second startup's migration is a no-op and can't resurrect leftovers.
    assert lp.migrate_legacy_translate_prefs() is False
    assert lp._text["llm.base_url.custom"] == "http://mine/v1"
    assert lp._text["llm.model.custom"] == "my-model"
    assert lp._secrets["llm_key.custom"] == "sk-mine"


def test_migration_respects_existing_store_values(lp, legacy_prefs):
    lp._text["llm.base_url.custom"] = "http://already/v1"
    lp._secrets["llm_key.custom"] = "sk-already"
    lp.migrate_legacy_translate_prefs()
    # rows the user already owns are never overwritten…
    assert lp._text["llm.base_url.custom"] == "http://already/v1"
    assert lp._secrets["llm_key.custom"] == "sk-already"
    # …the empty one is filled, and the prefs rows are deleted regardless.
    assert lp._text["llm.model.custom"] == "legacy-model"
    assert not any(k.startswith("env.TRANSLATE") for k in legacy_prefs._load())


def test_migration_never_touches_real_env(lp, legacy_prefs, monkeypatch):
    monkeypatch.setenv("TRANSLATE_BASE_URL", "http://real-env/v1")
    lp.migrate_legacy_translate_prefs()
    assert os.environ["TRANSLATE_BASE_URL"] == "http://real-env/v1"


def test_saving_ollama_wins_over_legacy_env_after_migration(lp, legacy_prefs, monkeypatch):
    """#963 end to end: legacy TRANSLATE_BASE_URL in the environment (as a
    pre-migration launch would have imported it) + no stored selection. A
    plain save of Ollama must yield active == 'ollama' — pre-fix it stayed
    'custom' on every restart because nothing persisted the choice."""
    monkeypatch.setenv("TRANSLATE_BASE_URL", "http://legacy:11434/v1")
    lp.migrate_legacy_translate_prefs()
    from api.routers import settings as settings_router
    settings_router.save_llm_provider(
        "ollama", settings_router._LLMProviderBody(make_active=False))
    assert lp.active_provider_id() == "ollama"


def test_stored_active_provider_id_ignores_env_and_auto(lp, monkeypatch):
    # Only the persisted row counts — env pin / legacy env / auto-detect don't.
    monkeypatch.setenv("LLM_DEFAULT_PROVIDER", "openrouter")
    monkeypatch.setenv("TRANSLATE_BASE_URL", "http://legacy/v1")
    lp._secrets["llm_key.groq"] = "k"  # would auto-select
    assert lp.stored_active_provider_id() is None
    lp.set_active_provider("mistral")
    assert lp.stored_active_provider_id() == "mistral"
