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
        base_url = os.environ.get("TRANSLATE_BASE_URL")
        api_key = (
            os.environ.get("TRANSLATE_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or ("local" if base_url else None)
        )
        if not api_key:
            return False, (
                "No LLM configured. Set TRANSLATE_BASE_URL (+ TRANSLATE_API_KEY) to "
                "point at OpenAI, Ollama (http://localhost:11434/v1), or any compatible host."
            )
        return True, "ready"

    @property
    def model_name(self) -> str:
        return os.environ.get("TRANSLATE_MODEL", "gpt-4o-mini")

    def _get_client(self):
        if self._client is not None:
            return self._client
        from openai import OpenAI
        base_url = os.environ.get("TRANSLATE_BASE_URL")
        api_key = (
            os.environ.get("TRANSLATE_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or ("local" if base_url else None)
        )
        if not api_key:
            raise RuntimeError("LLM not configured. See `is_available()` for the hint.")
        kw = {"api_key": api_key}
        if base_url:
            kw["base_url"] = base_url
        self._client = OpenAI(**kw)
        return self._client

    def chat(self, *, system: str, user: str, timeout: Optional[float] = None) -> str:
        if timeout is None:
            try:
                timeout = float(os.environ.get("OMNIVOICE_LLM_TIMEOUT", "45"))
            except ValueError:
                timeout = 45.0
        res = self._get_client().chat.completions.create(
            model=self.model_name,
            timeout=timeout,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
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


_REGISTRY: dict[str, type[LLMBackend]] = {
    "openai-compat": OpenAICompatBackend,
    "off":           OffBackend,
}


def list_backends() -> list[dict]:
    out = []
    for bid, cls in _REGISTRY.items():
        ok, msg = cls.is_available()
        out.append({
            "id": bid,
            "display_name": cls.display_name,
            "available": ok,
            "reason": None if ok else msg,
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
