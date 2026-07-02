"""
LLM adapter interface — Phase 3.4 (ROADMAP.md).

The translator (Phase 1.1) already speaks the OpenAI chat-completions shape.
This module formalises that surface into an `LLMBackend` protocol so other
call sites (glossary auto-extract, directorial AI in Phase 4, reflection
passes) can depend on the interface instead of duplicating the client
construction logic.

Today we ship:

    • OpenAICompatBackend — wraps the `openai` package pointing at whatever
      TRANSLATE_BASE_URL + TRANSLATE_API_KEY say. Works with real OpenAI,
      Ollama (`base_url=http://localhost:11434/v1`), LM Studio, Together,
      Anyscale, Claude-via-OpenAI-compat proxies.
    • OffBackend — explicit no-op. Gets returned when no LLM is configured
      so callers fail fast with a clear message instead of a KeyError.

Selection: auto — if env is configured, return OpenAICompatBackend; else
OffBackend. Callers can override with `OMNIVOICE_LLM_BACKEND`.

NOTE: cloud providers stay **opt-in** per the ROADMAP's privacy policy.
Even with `TRANSLATE_API_KEY` set, the flag only turns on this backend;
individual features (Cinematic translate, glossary auto-extract) still
check their own `quality="cinematic"` gate / user action before calling.
"""
from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from typing import Optional

logger = logging.getLogger("omnivoice.llm")


class LLMBackend(ABC):
    id: str = "base"
    display_name: str = "Base LLM"
    # LLM backends call out over the network (OpenAI/Ollama/LM Studio) or are a
    # no-op — none run a model on the user's GPU. So `gpu_compat` is empty and
    # list_backends() labels the family `effective_device:"network"` /
    # routing_status:"n/a" rather than asserting a false GPU claim. Routing is
    # never gated for LLM (see engines.select_engine + diagnose).
    gpu_compat: tuple[str, ...] = ()

    @classmethod
    @abstractmethod
    def is_available(cls) -> tuple[bool, str]:
        ...

    @property
    @abstractmethod
    def model_name(self) -> str: ...

    @abstractmethod
    def chat(self, *, system: str, user: str, timeout: Optional[float] = None) -> str:
        """One-shot chat completion. Returns the assistant content string.
        Raises on failure — callers decide whether to fallback gracefully.
        """


# ── OpenAI-compatible (the only backend that actually calls out today) ─────


class OpenAICompatBackend(LLMBackend):
    id = "openai-compat"
    display_name = "OpenAI-compatible (real OpenAI, Ollama, LM Studio, …)"

    def __init__(self):
        self._client = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import openai  # noqa: F401
        except ImportError:
            return False, "openai package missing (install with `pip install openai`)."
        # Resolve through the provider registry — the active provider carries
        # its own base_url/key/model. Legacy single-endpoint setups (a lone
        # TRANSLATE_BASE_URL) resolve to the "custom" provider, so this stays
        # backward-compatible with pre-registry configs.
        from services import llm_providers
        p = llm_providers.active_provider()
        if p is None:
            return False, (
                "No LLM configured. Add a provider key in Settings → LLM Providers "
                "(OpenAI/OpenRouter/Groq/… or a local Ollama), or set "
                "TRANSLATE_BASE_URL (+ TRANSLATE_API_KEY)."
            )
        if not llm_providers.resolve_base_url(p):
            return False, f"{p.display_name}: set a Base URL in Settings → LLM Providers."
        if not llm_providers.has_key(p):
            return False, f"{p.display_name}: add an API key in Settings → LLM Providers."
        return True, f"ready ({p.display_name})"

    @property
    def model_name(self) -> str:
        from services import llm_providers
        p = llm_providers.active_provider()
        if p is not None:
            return llm_providers.resolve_model(p)
        return os.environ.get("TRANSLATE_MODEL", "gpt-4o-mini")

    def _get_client(self):
        if self._client is not None:
            return self._client
        from openai import OpenAI
        from services import llm_providers
        p = llm_providers.active_provider()
        if p is None:
            raise RuntimeError("LLM not configured. See `is_available()` for the hint.")
        base_url = llm_providers.resolve_base_url(p)
        api_key = llm_providers.resolve_api_key(p)
        if not api_key:
            raise RuntimeError("LLM not configured. See `is_available()` for the hint.")
        kw = {"api_key": api_key}
        if base_url:
            kw["base_url"] = base_url
        # max_retries=0 so a 429 + Retry-After can't make one chat() sleep
        # through the Autofit fit-pass wall-clock budget (speech_rate).
        self._client = OpenAI(max_retries=0, **kw)
        return self._client

    def chat(self, *, system: str, user: str, timeout: Optional[float] = None) -> str:
        return self.chat_messages(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            timeout=timeout,
        )

    def chat_messages(self, *, messages: list[dict], timeout: Optional[float] = None) -> str:
        """One-shot completion over a full message list.

        Additive surface for callers that need structured few-shot turns
        (dictation refinement, Wave 2.1) — small local models pattern-match
        and echo inline examples, so examples must arrive as prior chat
        turns, not inside the system prompt.
        """
        if timeout is None:
            try:
                timeout = float(os.environ.get("OMNIVOICE_LLM_TIMEOUT", "45"))
            except ValueError:
                timeout = 45.0
        res = self._get_client().chat.completions.create(
            model=self.model_name,
            timeout=timeout,
            messages=messages,
        )
        return (res.choices[0].message.content or "").strip()


# ── Off — explicit no-LLM path ────────────────────────────────────────────


class OffBackend(LLMBackend):
    id = "off"
    display_name = "Off (no LLM)"

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        return True, "ready"

    @property
    def model_name(self) -> str:
        return "none"

    def chat(self, **kw) -> str:
        raise RuntimeError(
            "No LLM backend configured. Set TRANSLATE_BASE_URL (+ TRANSLATE_API_KEY) "
            "to use features that need one (Cinematic translate, glossary auto-extract)."
        )

    def chat_messages(self, **kw) -> str:
        return self.chat(**kw)


_REGISTRY: dict[str, type[LLMBackend]] = {
    "openai-compat": OpenAICompatBackend,
    "off":           OffBackend,
}


# Most-recent failure per backend (parity with tts/asr list_backends).
_LAST_ERRORS: dict[str, str] = {}

_INSTALL_HINTS: dict[str, str] = {
    "openai-compat": "Set TRANSLATE_BASE_URL (+ TRANSLATE_API_KEY) — OpenAI, "
                     "Ollama (http://localhost:11434/v1), or any compatible host.",
}


def list_backends() -> list[dict]:
    """Same 11-key shape as tts/asr so the matrix renders families uniformly.

    LLM is NOT a GPU family: every entry carries literal
    ``effective_device:"network"`` / ``routing_status:"n/a"`` /
    ``routing_reason:null`` (NOT via resolve_routing — that would be a false
    GPU claim). ``effective_device:"network"`` is a label, not a probe: nothing
    here touches the network (local-first).
    """
    from core.scrub import scrub_text

    out: list[dict] = []
    for bid, cls in _REGISTRY.items():
        try:
            ok, msg = cls.is_available()
        except Exception as exc:
            ok = False
            msg = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "llm list_backends: %s.is_available() raised — degrading "
                "gracefully so the picker still renders: %s", bid, msg,
            )
        if ok:
            _LAST_ERRORS.pop(bid, None)
        else:
            _LAST_ERRORS[bid] = scrub_text(msg)
        out.append({
            "id": bid,
            "display_name": cls.display_name,
            "available": ok,
            "reason": None if ok else scrub_text(msg),
            "install_hint": _INSTALL_HINTS.get(bid),
            "last_error": _LAST_ERRORS.get(bid),
            "isolation_mode": "in-process",
            "gpu_compat": list(getattr(cls, "gpu_compat", ())),
            "effective_device": "network",
            "routing_status": "n/a",
            "routing_reason": None,
        })
    return out


def active_backend_id() -> str:
    explicit = os.environ.get("OMNIVOICE_LLM_BACKEND")
    if explicit:
        return explicit
    from core import prefs
    picked = prefs.get("llm_backend")
    if picked:
        return picked
    ok, _ = OpenAICompatBackend.is_available()
    return "openai-compat" if ok else "off"


def get_active_llm_backend() -> LLMBackend:
    bid = active_backend_id()
    if bid not in _REGISTRY:
        raise ValueError(f"Unknown LLM backend: {bid!r}. Known: {list(_REGISTRY)}")
    return _REGISTRY[bid]()
