"""Subprocess env builder for engine launchers (Phase 1 INST-12 + AUTH-04).

Every place that spawns an engine subprocess (sonitranslate, future
CosyVoice / IndexTTS subprocess backends from Phase 2) should call
`build_engine_env()` instead of constructing its own env dict ad-hoc.
That gives us ONE place to inject:

  - HF_TOKEN / YOUR_HF_TOKEN from the 3-source resolver (AUTH-04)
  - TORCH_COMPILE_DISABLE=1 on Windows when the user enabled the
    Performance toggle (INST-12, issue #65)

The function returns a fresh dict (caller may further mutate before
passing to `subprocess.Popen(env=...)`).
"""
from __future__ import annotations

import logging
import os
import sys
from typing import Optional

logger = logging.getLogger("omnivoice.engine_env")

_TORCH_COMPILE_KEY = "perf.torch_compile_disabled"


def build_engine_env(
    *,
    base_env: Optional[dict] = None,
    inject_hf_token: bool = True,
) -> dict:
    """Build the environment dict to pass to an engine subprocess launcher.

    Args:
        base_env: starting point — defaults to `os.environ.copy()`.
        inject_hf_token: when True (default), resolve the HF token via the
            3-source cascade and inject it as both HF_TOKEN and YOUR_HF_TOKEN
            (the latter is what SoniTranslate's pipeline expects).

    Returns a new dict — never mutates the input.
    """
    env = dict(base_env if base_env is not None else os.environ)

    # AUTH-04: HF token injection from the resolver cascade. We import lazily
    # so the helper is callable in test contexts that don't stand up the
    # full settings_store / DB.
    if inject_hf_token:
        try:
            from services import token_resolver

            resolved = token_resolver.resolve()
            if resolved and resolved.token:
                env["HF_TOKEN"] = resolved.token
                env["YOUR_HF_TOKEN"] = resolved.token
        except Exception:
            logger.exception("build_engine_env: token resolver failed (non-fatal)")

    # INST-12: TORCH_COMPILE_DISABLE on Windows when the user opted in.
    # The flag is a Windows-only escape hatch — torch.compile OOMs the same
    # Triton kernel cache differently on macOS/Linux, so injecting on those
    # platforms would just slow the engine for no gain.
    if sys.platform.startswith("win"):
        try:
            from services import settings_store

            if settings_store.get_text(_TORCH_COMPILE_KEY, "0") == "1":
                env["TORCH_COMPILE_DISABLE"] = "1"
        except Exception:
            logger.exception("build_engine_env: torch_compile_disabled read failed")

    return env
