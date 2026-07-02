"""LLM Skills registry + router + per-consumption-point disabled semantics.

Covers the feat/llm-skills surface:

* registry resolution precedence — per-skill override > active provider > none;
* disabled semantics at every consumption point (monkeypatched): a disabled
  skill degrades exactly like "no LLM configured" does today — Cinematic falls
  back to Fast, refinement passes through, direction parses heuristically,
  slot-fit returns the no-llm marker, glossary auto-extract 503s;
* /api/settings/llm-skills round-trips + unknown skill/provider validation.

House conventions: settings_store backed by in-memory dicts, `clean_llm_env`
clears the full provider env surface, direct handler calls (no TestClient).
"""
from __future__ import annotations

import importlib
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

_HAS_OPENAI = importlib.util.find_spec("openai") is not None


@pytest.fixture
def store(monkeypatch, clean_llm_env):
    """In-memory settings_store (no SQLite) + a clean provider env surface."""
    from services import settings_store as ss

    text: dict[str, str] = {}
    secrets: dict[str, str] = {}
    monkeypatch.setattr(ss, "get_text", lambda k, default=None: text.get(k, default))
    monkeypatch.setattr(ss, "set_text", lambda k, v: text.__setitem__(k, v))
    monkeypatch.setattr(ss, "get_secret", lambda n: secrets.get(n))
    monkeypatch.setattr(
        ss, "set_secret",
        lambda n, v: secrets.__setitem__(n, v) if v else secrets.pop(n, None))
    monkeypatch.setattr(ss, "list_secret_names", lambda: list(secrets))
    return types.SimpleNamespace(text=text, secrets=secrets)


@pytest.fixture
def skills(store):
    from services import llm_skills
    return llm_skills


def _activate_groq(store):
    """Configure + activate a remote provider directly through the store."""
    store.secrets["llm_key.groq"] = "gsk-test-123"
    store.text["llm.active_provider"] = "groq"


# ── Registry + resolution precedence ────────────────────────────────────────

def test_all_skills_cover_every_consumption_point(skills):
    assert [s.id for s in skills.all_skills()] == [
        "cinematic_translation", "slot_fitting", "glossary_extract",
        "direction_parse", "dictation_refinement",
    ]
    for s in skills.all_skills():
        assert s.name_key == f"settings.llmskills_{s.id}_name"
        assert s.description_key == f"settings.llmskills_{s.id}_desc"


def test_defaults_enabled_no_override_active_provider(skills, store):
    _activate_groq(store)
    res = skills.resolve_skill("cinematic_translation")
    assert res.enabled is True
    assert res.source == "active"
    assert res.provider.id == "groq"
    assert res.ready is True and res.reason is None


def test_override_beats_active(skills, store):
    _activate_groq(store)
    skills.configure_skill("cinematic_translation", provider_override="ollama")
    res = skills.resolve_skill("cinematic_translation")
    assert res.source == "override"
    assert res.provider.id == "ollama"          # local: configured without a key
    assert res.ready is True


def test_clearing_override_returns_to_active(skills, store):
    _activate_groq(store)
    skills.configure_skill("slot_fitting", provider_override="ollama")
    skills.configure_skill("slot_fitting", provider_override="")
    res = skills.resolve_skill("slot_fitting")
    assert res.source == "active" and res.provider.id == "groq"


def test_no_provider_at_all_is_not_ready(skills, store):
    res = skills.resolve_skill("direction_parse")
    assert res.provider is None
    assert res.source == "none"
    assert res.ready is False and res.reason == "no_provider"


def test_override_on_unconfigured_provider_is_not_ready(skills, store):
    _activate_groq(store)
    skills.configure_skill("glossary_extract", provider_override="openai")  # no key
    res = skills.resolve_skill("glossary_extract")
    assert res.source == "override" and res.provider.id == "openai"
    assert res.ready is False and res.reason == "unconfigured"


def test_disabled_wins_over_everything(skills, store):
    _activate_groq(store)
    skills.configure_skill("dictation_refinement", enabled=False,
                           provider_override="ollama")
    res = skills.resolve_skill("dictation_refinement")
    assert res.ready is False and res.reason == "disabled"


def test_stale_override_falls_back_to_active(skills, store):
    _activate_groq(store)
    # Simulate a provider removed from the registry after being stored.
    store.text["llm_skill.slot_fitting.provider"] = "gone-provider"
    res = skills.resolve_skill("slot_fitting")
    assert res.source == "active" and res.provider.id == "groq"


def test_unknown_skill_raises(skills, store):
    with pytest.raises(KeyError):
        skills.resolve_skill("nope")
    with pytest.raises(KeyError):
        skills.configure_skill("nope", enabled=False)


def test_unknown_provider_override_raises(skills, store):
    with pytest.raises(ValueError):
        skills.configure_skill("slot_fitting", provider_override="not-a-provider")


# ── resolve_skill_client / skill_backend ───────────────────────────────────

@pytest.mark.skipif(not _HAS_OPENAI, reason="openai package not installed")
def test_client_none_when_disabled(skills, store):
    _activate_groq(store)
    skills.configure_skill("cinematic_translation", enabled=False)
    assert skills.resolve_skill_client("cinematic_translation") is None


@pytest.mark.skipif(not _HAS_OPENAI, reason="openai package not installed")
def test_client_binds_override_provider(skills, store):
    _activate_groq(store)
    skills.configure_skill("cinematic_translation", provider_override="ollama")
    handle = skills.resolve_skill_client("cinematic_translation")
    assert handle is not None
    assert handle.provider_id == "ollama"
    assert handle.model == "llama3.1"           # ollama's default model
    assert handle.timeout == pytest.approx(45.0)


@pytest.mark.skipif(not _HAS_OPENAI, reason="openai package not installed")
def test_client_uses_active_when_no_override(skills, store):
    _activate_groq(store)
    handle = skills.resolve_skill_client("cinematic_translation")
    assert handle is not None and handle.provider_id == "groq"


def test_backend_off_when_disabled(skills, store):
    from services.llm_backend import OffBackend
    _activate_groq(store)
    skills.configure_skill("direction_parse", enabled=False)
    assert isinstance(skills.skill_backend("direction_parse"), OffBackend)


def test_backend_delegates_to_active_callable_without_override(skills, store):
    sentinel = object()
    assert skills.skill_backend("direction_parse", active=lambda: sentinel) is sentinel


@pytest.mark.skipif(not _HAS_OPENAI, reason="openai package not installed")
def test_backend_binds_override_and_ignores_active_callable(skills, store):
    from services.llm_backend import OpenAICompatBackend
    _activate_groq(store)
    skills.configure_skill("direction_parse", provider_override="ollama")
    be = skills.skill_backend("direction_parse", active=lambda: pytest.fail("must not delegate"))
    assert isinstance(be, OpenAICompatBackend)
    assert be.model_name == "llama3.1"          # bound to ollama, not groq


def test_global_env_kill_switch_silences_overrides(skills, store, monkeypatch):
    from services.llm_backend import OffBackend
    _activate_groq(store)
    skills.configure_skill("direction_parse", provider_override="ollama")
    monkeypatch.setenv("OMNIVOICE_LLM_BACKEND", "off")
    assert isinstance(skills.skill_backend("direction_parse"), OffBackend)


def test_backend_off_when_override_unconfigured(skills, store):
    from services.llm_backend import OffBackend
    _activate_groq(store)
    skills.configure_skill("direction_parse", provider_override="openai")  # no key
    assert isinstance(skills.skill_backend("direction_parse"), OffBackend)


# ── Disabled semantics per consumption point ────────────────────────────────

def test_disabled_translation_reports_cinematic_unavailable(skills, store):
    _activate_groq(store)
    from services import translator
    assert translator.cinematic_available() is (_HAS_OPENAI and True)
    skills.configure_skill("cinematic_translation", enabled=False)
    assert translator.cinematic_available() is False
    # and the per-segment refine degrades to the literal with the no-llm marker
    out = translator.cinematic_refine_sync(
        "hello", "hallo", source_lang="en", target_lang="de")
    assert out["text"] == "hallo" and out.get("error") == "no-llm"


def test_disabled_refinement_is_pass_through(skills, store, monkeypatch):
    _activate_groq(store)
    from services import refinement

    class _Fake:
        id = "openai-compat"
        def chat_messages(self, **kw):
            return "Refined."
    monkeypatch.setattr(
        "services.llm_backend.get_active_llm_backend", lambda: _Fake())
    assert refinement.maybe_refine("um hello") == "Refined."
    skills.configure_skill("dictation_refinement", enabled=False)
    assert refinement.maybe_refine("um hello") is None


def test_disabled_direction_parse_uses_heuristic(skills, store, monkeypatch):
    _activate_groq(store)
    from services import director

    class _Fake:
        id = "openai-compat"
        def chat(self, **kw):
            return '{"energy": ["urgent"]}'
    monkeypatch.setattr(director, "get_active_llm_backend", lambda: _Fake())
    assert director.parse("urgent and surprised").method == "llm"
    skills.configure_skill("direction_parse", enabled=False)
    d = director.parse("urgent and surprised")
    assert d.method == "heuristic"
    assert d.tokens.get("energy") == ["urgent"]  # heuristic still delivers


def test_disabled_slot_fitting_returns_no_llm_marker(skills, store, monkeypatch):
    _activate_groq(store)
    from services import speech_rate

    class _Fake:
        id = "openai-compat"
        def chat(self, **kw):
            return "short"
    monkeypatch.setattr(speech_rate, "get_active_llm_backend", lambda: _Fake())
    long_text = "x" * 400  # far over any slot → forces the LLM branch
    assert "error" not in speech_rate.adjust_for_slot(
        long_text, slot_seconds=1.0, target_lang="en")
    skills.configure_skill("slot_fitting", enabled=False)
    res = speech_rate.adjust_for_slot(long_text, slot_seconds=1.0, target_lang="en")
    assert res["error"] == "no-llm" and res["text"] == long_text


def test_disabled_glossary_extract_503s(skills, store):
    _activate_groq(store)
    from fastapi import HTTPException
    from api.routers import glossary

    skills.configure_skill("glossary_extract", enabled=False)
    with pytest.raises(HTTPException) as ei:
        glossary.auto_extract(
            "proj-1",
            glossary.AutoExtractRequest(target_lang="de",
                                        segments=[{"text": "hello"}]),
        )
    assert ei.value.status_code == 503


def test_refinement_state_reflects_disabled_skill(skills, store):
    _activate_groq(store)
    from api.routers import settings as settings_router
    skills.configure_skill("dictation_refinement", enabled=False)
    assert settings_router._refinement_state()["llm_ready"] is False


# ── Router endpoints ────────────────────────────────────────────────────────

@pytest.fixture
def settings_mod(store):
    return importlib.import_module("api.routers.settings")


def test_list_returns_every_skill_with_status(settings_mod, store, skills):
    _activate_groq(store)
    body = settings_mod.list_llm_skills()
    assert [s["id"] for s in body["skills"]] == [s.id for s in skills.all_skills()]
    first = body["skills"][0]
    assert first["enabled"] is True and first["provider_override"] is None
    assert first["provider"] == "groq" and first["provider_source"] == "active"
    assert first["ready"] is True and first["reason"] is None
    assert first["provider_local"] is False


def test_put_toggle_round_trips(settings_mod, store):
    _activate_groq(store)
    body = settings_mod.set_llm_skill(
        "dictation_refinement", settings_mod._LLMSkillBody(enabled=False))
    row = next(s for s in body["skills"] if s["id"] == "dictation_refinement")
    assert row["enabled"] is False and row["reason"] == "disabled"
    body = settings_mod.set_llm_skill(
        "dictation_refinement", settings_mod._LLMSkillBody(enabled=True))
    row = next(s for s in body["skills"] if s["id"] == "dictation_refinement")
    assert row["enabled"] is True and row["ready"] is True


def test_put_provider_override_round_trips(settings_mod, store):
    _activate_groq(store)
    body = settings_mod.set_llm_skill(
        "cinematic_translation",
        settings_mod._LLMSkillBody(provider_override="ollama"))
    row = next(s for s in body["skills"] if s["id"] == "cinematic_translation")
    assert row["provider_override"] == "ollama"
    assert row["provider"] == "ollama" and row["provider_source"] == "override"
    assert row["provider_local"] is True
    # clear with "" → back to the active provider
    body = settings_mod.set_llm_skill(
        "cinematic_translation", settings_mod._LLMSkillBody(provider_override=""))
    row = next(s for s in body["skills"] if s["id"] == "cinematic_translation")
    assert row["provider_override"] is None and row["provider"] == "groq"


def test_put_omitted_fields_left_unchanged(settings_mod, store):
    _activate_groq(store)
    settings_mod.set_llm_skill(
        "slot_fitting",
        settings_mod._LLMSkillBody(enabled=False, provider_override="ollama"))
    # A body with neither field set must not clear the stored override.
    body = settings_mod.set_llm_skill("slot_fitting", settings_mod._LLMSkillBody())
    row = next(s for s in body["skills"] if s["id"] == "slot_fitting")
    assert row["enabled"] is False and row["provider_override"] == "ollama"


def test_put_unknown_skill_404s(settings_mod, store):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        settings_mod.set_llm_skill("nope", settings_mod._LLMSkillBody(enabled=False))
    assert ei.value.status_code == 404


def test_put_unknown_provider_404s(settings_mod, store):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        settings_mod.set_llm_skill(
            "slot_fitting", settings_mod._LLMSkillBody(provider_override="nope"))
    assert ei.value.status_code == 404
