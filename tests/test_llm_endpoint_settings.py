"""LLM endpoint settings (Wave 2.4) — GET/PUT /api/settings/llm-endpoint.

Persistence rides the TRANSLATE_* env vars; these tests assert the read
shape, masking, and the set/unchanged/clear semantics, with prefs writes
stubbed so nothing touches the real prefs.json.
"""
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import importlib

import pytest

# `openai` is an optional (translator-path) dependency. is_available() short-
# circuits to False without it, so availability assertions are guarded.
_HAS_OPENAI = importlib.util.find_spec("openai") is not None


@pytest.fixture
def settings_mod(monkeypatch):
    # Stub prefs persistence so PUT doesn't write the developer's prefs.json.
    import core.prefs as prefs
    monkeypatch.setattr(prefs, "set_", lambda *a, **k: None)
    monkeypatch.setattr(prefs, "delete", lambda *a, **k: None)
    for k in ("TRANSLATE_BASE_URL", "TRANSLATE_MODEL", "TRANSLATE_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    return importlib.import_module("api.routers.settings")


def test_get_empty_state(settings_mod):
    state = settings_mod.get_llm_endpoint()
    assert state["base_url"] == ""
    assert state["model"] == ""
    assert state["api_key_masked"] is None
    assert state["available"] is False
    assert state["reason"]


def test_put_sets_and_masks(settings_mod):
    body = settings_mod._LLMEndpointBody(
        base_url="http://localhost:11434/v1", model="llama3.1", api_key="sk-secret-1234"
    )
    state = settings_mod.set_llm_endpoint(body)
    assert os.environ["TRANSLATE_BASE_URL"] == "http://localhost:11434/v1"
    assert os.environ["TRANSLATE_MODEL"] == "llama3.1"
    assert os.environ["TRANSLATE_API_KEY"] == "sk-secret-1234"
    assert state["api_key_masked"] == "…1234"
    if _HAS_OPENAI:
        assert state["available"] is True  # base_url + key → ready


def test_put_none_field_leaves_unchanged(settings_mod):
    settings_mod.set_llm_endpoint(
        settings_mod._LLMEndpointBody(base_url="http://x/v1", model="m", api_key="key123456")
    )
    # api_key omitted (None) — must not clear it.
    settings_mod.set_llm_endpoint(
        settings_mod._LLMEndpointBody(base_url="http://y/v1", model="m2")
    )
    assert os.environ["TRANSLATE_BASE_URL"] == "http://y/v1"
    assert os.environ["TRANSLATE_API_KEY"] == "key123456"


def test_put_empty_string_clears(settings_mod):
    settings_mod.set_llm_endpoint(
        settings_mod._LLMEndpointBody(base_url="http://x/v1", api_key="key123456")
    )
    settings_mod.set_llm_endpoint(settings_mod._LLMEndpointBody(api_key=""))
    assert "TRANSLATE_API_KEY" not in os.environ


def test_local_base_url_is_available_without_key(settings_mod):
    # A local base_url makes the backend usable even with no key (Ollama):
    # is_available()'s api_key falls back to "local" when a base_url is set.
    state = settings_mod.set_llm_endpoint(
        settings_mod._LLMEndpointBody(base_url="http://localhost:11434/v1", model="llama3.1")
    )
    assert state["api_key_masked"] is None
    if _HAS_OPENAI:
        assert state["available"] is True


def test_short_key_masks_to_set(settings_mod):
    state = settings_mod.set_llm_endpoint(
        settings_mod._LLMEndpointBody(base_url="http://x/v1", api_key="abc")
    )
    assert state["api_key_masked"] == "set"
