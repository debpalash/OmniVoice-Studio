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

import importlib.util
import logging
import os
import sys
from typing import Optional

logger = logging.getLogger("omnivoice.engine_env")

_TORCH_COMPILE_KEY = "perf.torch_compile_disabled"

# #278: explicit opt-in override — set to 1/true to attempt torch.compile even
# when the GPU's compute capability is not in this PyTorch build's arch list
# (e.g. a brand-new architecture running through PTX forward-compat).
_FORCE_COMPILE_ENV = "OMNIVOICE_FORCE_TORCH_COMPILE"

# #278: set (with a reason) the first time torch.compile — or *running* the
# compiled model — fails at runtime in this process. Once set, every later
# load in the same session goes straight to eager instead of re-tripping the
# same Dynamo/Inductor/Triton failure.
_compile_runtime_failure: Optional[str] = None


def mark_compile_runtime_failure(reason: str) -> None:
    """Record that torch.compile (or compiled execution) failed at runtime.

    Called by ``services.model_manager`` when compilation raises, or when a
    generation through the compiled model dies inside the Dynamo / Inductor /
    Triton stack (#278). Disables compile for the rest of the process — eager
    mode from here on; the next app restart probes again.
    """
    global _compile_runtime_failure
    _compile_runtime_failure = reason or "unknown torch.compile runtime failure"
    logger.warning(
        "torch.compile disabled for this session after a runtime failure: %s",
        _compile_runtime_failure,
    )


def _force_compile_requested() -> bool:
    value = os.environ.get(_FORCE_COMPILE_ENV, "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _cuda_arch_supported_for_compile() -> "tuple[bool, str]":
    """Check the GPU's compute capability against this torch build's arch list.

    New GPU architectures (e.g. Blackwell sm_120, issue #278) routinely break
    torch.compile/Triton before upstream support lands: the eager model runs
    via PTX forward-compat, but Inductor/Triton kernel compilation targets the
    new arch directly and fails mid-generation. If the device's ``sm_XY`` tag
    is absent from ``torch.cuda.get_arch_list()`` we treat compile as
    unsupported and use eager.

    Returns ``(supported, reason)``. Fails open — any probe error returns
    ``(True, "")`` so a weird torch build never silently loses the
    optimization (the runtime fallback in model_manager still protects
    generation).
    """
    try:
        import torch

        if not torch.cuda.is_available():
            return True, ""
        major, minor = torch.cuda.get_device_capability(0)
        arch_list = list(getattr(torch.cuda, "get_arch_list", lambda: [])() or [])
        if not arch_list:
            return True, ""
        sm_tag = f"sm_{major}{minor}"
        if sm_tag in arch_list or f"compute_{major}{minor}" in arch_list:
            return True, ""
        try:
            device_name = torch.cuda.get_device_name(0)
        except Exception:
            device_name = "GPU"
        return False, (
            f"{device_name} (compute capability {major}.{minor} / {sm_tag}) is not "
            f"in this PyTorch build's supported arch list ({', '.join(arch_list)})"
        )
    except Exception:
        logger.debug("CUDA arch probe for torch.compile failed; assuming supported", exc_info=True)
        return True, ""


def should_torch_compile(device: str) -> bool:
    """Decide whether to apply ``torch.compile`` to an in-process model.

    plan-02 (#65): ``torch.compile(mode="reduce-overhead")`` needs Triton at
    runtime, and Triton has no Windows build — on Windows+CUDA the compile path
    failed and surfaced as a confusing "OOM". Requires all of:
      - device == "cuda" (compile only helps the CUDA path here),
      - Triton importable (``find_spec`` — the cross-platform gate that closes
        #65; no Windows wheel ⇒ skip ⇒ eager),
      - the user has NOT set the ``perf.torch_compile_disabled`` escape hatch,
      - compile has NOT already failed at runtime in this process (#278),
      - the GPU's compute capability is in this torch build's arch list (#278)
        — overridable via ``OMNIVOICE_FORCE_TORCH_COMPILE=1``.

    Returns False (→ eager mode) on any of those, logging the reason at INFO.
    torch.compile is an optimization, never a requirement — generation must
    always work without it.
    """
    if device != "cuda":
        return False
    if importlib.util.find_spec("triton") is None:
        logger.info("torch.compile skipped: Triton unavailable — using eager mode.")
        return False
    try:
        from services import settings_store

        if settings_store.get_text(_TORCH_COMPILE_KEY, "0") == "1":
            logger.info("torch.compile skipped: disabled in Settings (Performance).")
            return False
    except Exception:
        logger.exception("should_torch_compile: settings read failed; proceeding")
    if _compile_runtime_failure is not None:
        logger.info(
            "torch.compile skipped: failed earlier this session (%s) — using eager mode.",
            _compile_runtime_failure,
        )
        return False
    supported, reason = _cuda_arch_supported_for_compile()
    if not supported:
        if _force_compile_requested():
            logger.warning(
                "torch.compile forced via %s=1 despite: %s", _FORCE_COMPILE_ENV, reason,
            )
            return True
        logger.info(
            "torch.compile skipped: %s — using eager mode. "
            "(Set %s=1 to attempt compile anyway.)",
            reason, _FORCE_COMPILE_ENV,
        )
        return False
    return True


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
    # platforms would just slow the engine for no gain. (The in-process
    # should_torch_compile() gate handles the automatic Triton-absence case;
    # the subprocess var stays user-driven by design — see test_perf_settings.)
    if sys.platform.startswith("win"):
        try:
            from services import settings_store

            if settings_store.get_text(_TORCH_COMPILE_KEY, "0") == "1":
                env["TORCH_COMPILE_DISABLE"] = "1"
        except Exception:
            logger.exception("build_engine_env: torch_compile_disabled read failed")

    return env
