"""LLM Skills registry — per-feature enable/route control for every LLM call.

Every LLM-powered capability ("skill") in the backend is registered here, so
the Settings → LLM Skills panel can (a) toggle it and (b) route it to a
specific provider (a local Ollama/LM Studio vs a remote key) instead of
everything riding the one global active provider.

The six consumption points today:

    dub_translation       — api/routers/dub_translate.py (the Dub tab's direct
                            "LLM" translation engine; provider=openai branch)
    cinematic_translation — services/translator.py (Cinematic + Autofit
                            REFLECT/ADAPT rewrite; dub_translate quality gate)
    slot_fitting          — services/speech_rate.py (trim/expand a line to its
                            time slot; Autofit strict pass + /tools/rate-fit)
    glossary_extract      — api/routers/glossary.py auto-extract
    direction_parse       — services/director.py (natural-language direction →
                            taxonomy tokens; /tools/direction + dub generate)
    dictation_refinement  — services/refinement.py (dictation transcript
                            cleanup on finals)

Design rules:

* **Disabled == unconfigured.** A disabled skill degrades through the exact
  same path the feature takes today when no LLM is configured (Fast
  translation fallback, refinement pass-through, heuristic direction parse,
  no-llm slot fit, 503 on glossary auto-extract). No new degradation modes.
* **Override > active > none.** A per-skill provider override (persisted in
  settings_store) wins over the global active provider. No override → the
  active provider, resolved exactly as before (so existing setups see zero
  behavior change; all skills default to enabled with no override).
* **Persistence** is two plaintext settings rows per skill:
  ``llm_skill.<id>.enabled`` ("1"/"0", absent = enabled) and
  ``llm_skill.<id>.provider`` (provider id, absent/empty = active provider).
  Keys stay in the provider registry (encrypted) — nothing secret here.
* ``OMNIVOICE_LLM_BACKEND=off`` remains the global kill switch: it also
  silences skills routed through a per-skill override.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Callable, Optional

logger = logging.getLogger("omnivoice.llm_skills")

_ENABLED_KEY = "llm_skill.{sid}.enabled"
_PROVIDER_KEY = "llm_skill.{sid}.provider"

_UNSET = object()


@dataclass(frozen=True)
class LLMSkill:
    """A registered LLM consumption point. name/description resolve via the
    frontend i18n layer (localization hard rule — no hardcoded UI text)."""

    id: str
    name_key: str
    description_key: str


def _skill(sid: str) -> LLMSkill:
    return LLMSkill(
        id=sid,
        name_key=f"settings.llmskills_{sid}_name",
        description_key=f"settings.llmskills_{sid}_desc",
    )


# Display order in the settings panel: the dub pipeline first (translation →
# refine → fit → glossary → direction), then dictation.
_SKILLS: tuple[LLMSkill, ...] = (
    _skill("dub_translation"),
    _skill("cinematic_translation"),
    _skill("slot_fitting"),
    _skill("glossary_extract"),
    _skill("direction_parse"),
    _skill("dictation_refinement"),
)

_BY_ID: dict[str, LLMSkill] = {s.id: s for s in _SKILLS}


def all_skills() -> tuple[LLMSkill, ...]:
    return _SKILLS


def get_skill(skill_id: str) -> Optional[LLMSkill]:
    return _BY_ID.get(skill_id)


# ── Persistence (settings_store text rows) ─────────────────────────────────


def is_enabled(skill_id: str) -> bool:
    """Skill toggle. Absent row = enabled (all skills default on)."""
    from services import settings_store

    raw = settings_store.get_text(_ENABLED_KEY.format(sid=skill_id))
    return raw != "0"


def provider_override(skill_id: str) -> Optional[str]:
    """The per-skill provider id, or None when the skill follows the active
    provider. A stored id that no longer exists in the registry reads as None
    (stale override — resolution falls back to the active provider)."""
    from services import llm_providers, settings_store

    raw = (settings_store.get_text(_PROVIDER_KEY.format(sid=skill_id)) or "").strip()
    if not raw:
        return None
    if llm_providers.get_provider(raw) is None:
        logger.warning("llm_skills: stale provider override %r on %s — ignoring",
                       raw, skill_id)
        return None
    return raw


def configure_skill(skill_id: str, *, enabled: Optional[bool] = None,
                    provider_override: Any = _UNSET) -> None:
    """Persist a skill's toggle and/or provider routing.

    ``provider_override``: omit to leave unchanged; ``None``/``""`` clears it
    (skill follows the active provider); a provider id routes the skill there.
    Raises KeyError for an unknown skill, ValueError for an unknown provider.
    """
    if skill_id not in _BY_ID:
        raise KeyError(f"unknown LLM skill {skill_id!r}. Known: {sorted(_BY_ID)}")
    from services import llm_providers, settings_store

    if enabled is not None:
        settings_store.set_text(_ENABLED_KEY.format(sid=skill_id),
                                "1" if enabled else "0")
    if provider_override is not _UNSET:
        pid = (provider_override or "").strip()
        if pid and llm_providers.get_provider(pid) is None:
            raise ValueError(f"unknown provider {pid!r}")
        settings_store.set_text(_PROVIDER_KEY.format(sid=skill_id), pid)


# ── Resolution (override > active > none) ──────────────────────────────────


@dataclass(frozen=True)
class SkillResolution:
    skill: LLMSkill
    enabled: bool
    provider: Optional[Any]      # llm_providers.Provider or None
    source: str                  # "override" | "active" | "none"
    ready: bool
    reason: Optional[str]        # None | "disabled" | "no_provider" | "unconfigured"


def resolve_skill(skill_id: str) -> SkillResolution:
    """Resolve a skill's effective provider + ready status.

    Precedence: per-skill override → global active provider → none. Ready
    means enabled AND the effective provider is configured end-to-end.
    Raises KeyError for an unknown skill.
    """
    skill = _BY_ID.get(skill_id)
    if skill is None:
        raise KeyError(f"unknown LLM skill {skill_id!r}. Known: {sorted(_BY_ID)}")
    from services import llm_providers

    enabled = is_enabled(skill_id)
    override = provider_override(skill_id)
    if override:
        provider = llm_providers.get_provider(override)
        source = "override"
    else:
        provider = llm_providers.active_provider()
        source = "active" if provider is not None else "none"

    if not enabled:
        ready, reason = False, "disabled"
    elif provider is None:
        ready, reason = False, "no_provider"
    elif not llm_providers.is_configured(provider):
        ready, reason = False, "unconfigured"
    else:
        ready, reason = True, None
    return SkillResolution(skill=skill, enabled=enabled, provider=provider,
                           source=source, ready=ready, reason=reason)


def effective_provider(skill_id: str) -> Optional[Any]:
    """The provider a skill would call (override or active), or None."""
    return resolve_skill(skill_id).provider


# ── Client / backend construction ───────────────────────────────────────────


@dataclass(frozen=True)
class SkillClient:
    """A ready-to-call OpenAI-compatible client bound to the skill's provider."""

    client: Any        # openai.OpenAI
    model: str
    provider_id: str
    timeout: float


def _default_timeout() -> float:
    try:
        return float(os.environ.get("OMNIVOICE_LLM_TIMEOUT", "45"))
    except ValueError:
        return 45.0


def resolve_skill_client(skill_id: str) -> Optional[SkillClient]:
    """OpenAI-compat client + model for a skill, or None.

    None when the skill is disabled, no provider resolves, the provider is
    unconfigured, or the openai package is missing — callers treat None
    exactly like "no LLM configured" (their existing degradation path).
    Raises KeyError for an unknown skill (programming error, not user state).
    """
    res = resolve_skill(skill_id)
    if not res.ready:
        return None
    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai package not installed — LLM skill %s unavailable.",
                       skill_id)
        return None
    from services import llm_providers

    api_key = llm_providers.resolve_api_key(res.provider)
    if not api_key:
        return None
    kw: dict[str, Any] = {"api_key": api_key}
    base_url = llm_providers.resolve_base_url(res.provider)
    if base_url:
        kw["base_url"] = base_url
    # max_retries=0: a rate-limited provider returning 429 + a long Retry-After
    # would otherwise let the SDK sleep+retry inside a single call, blowing the
    # skill's wall-clock budget (the cinematic pass budget, the glossary call
    # timeout) from inside one request. Fail fast — the per-call timeout and the
    # pass-level budget are the only bounds we want. Mirrors OpenAICompatBackend.
    #
    # #959 class guard: OpenAI() eagerly builds its httpx client, which can
    # raise AT CONSTRUCTION for environment-shaped reasons — the reported one
    # is httpx's ImportError under ALL_PROXY/HTTPS_PROXY=socks5:// without
    # socksio; a malformed proxy URL or broken cert bundle fails the same way.
    # The contract here is already "None == LLM unavailable, degrade" — a bad
    # proxy env must degrade the skill, never 500 the calling feature.
    try:
        client = OpenAI(max_retries=0, **kw)
    except Exception as exc:
        logger.warning(
            "LLM client construction failed for skill %s (provider %s): %s — "
            "treating the skill as unavailable.",
            skill_id, res.provider.id, exc,
        )
        return None
    return SkillClient(
        client=client,
        model=llm_providers.resolve_model(res.provider),
        provider_id=res.provider.id,
        timeout=_default_timeout(),
    )


def skill_backend(skill_id: str, active: Optional[Callable[[], Any]] = None):
    """LLMBackend for a skill — the drop-in for ``get_active_llm_backend()``.

    * disabled skill → OffBackend (same object the no-LLM path returns today,
      so every caller's ``id == "off"`` / ``isinstance(…, OffBackend)`` check
      degrades identically);
    * no override → the ``active`` callable (callers pass their module-local
      ``get_active_llm_backend`` so existing monkeypatch seams keep working),
      defaulting to ``llm_backend.get_active_llm_backend`` — the exact legacy
      path, env/prefs overrides included;
    * override → an OpenAICompatBackend bound to that provider, or OffBackend
      when the provider is unconfigured, openai is missing, or the global
      ``OMNIVOICE_LLM_BACKEND=off`` kill switch is set.
    """
    from services.llm_backend import OffBackend, OpenAICompatBackend

    res = resolve_skill(skill_id)
    if not res.enabled:
        return OffBackend()
    if res.source != "override":
        if active is not None:
            return active()
        from services import llm_backend
        return llm_backend.get_active_llm_backend()
    if os.environ.get("OMNIVOICE_LLM_BACKEND") == "off":
        return OffBackend()
    if not res.ready:
        return OffBackend()
    try:
        import openai  # noqa: F401
    except ImportError:
        return OffBackend()
    return OpenAICompatBackend(provider=res.provider)


# ── API descriptor ──────────────────────────────────────────────────────────


def describe(skill_id: str) -> dict:
    """Client-safe skill descriptor for GET /api/settings/llm-skills."""
    res = resolve_skill(skill_id)
    p = res.provider
    return {
        "id": res.skill.id,
        "name_key": res.skill.name_key,
        "description_key": res.skill.description_key,
        "enabled": res.enabled,
        "provider_override": provider_override(skill_id),
        "provider": p.id if p is not None else None,
        "provider_display_name": p.display_name if p is not None else None,
        "provider_local": p.local if p is not None else None,
        "provider_source": res.source,
        "ready": res.ready,
        "reason": res.reason,
    }
