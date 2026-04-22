"""
Translation engine registry + UI-driven install/uninstall.

This is the single source of truth for which translation providers we know
about, what pip package they need, and whether that package is importable
right now. The Engine dropdown in the Dub tab reads list_engines() to
decide which options are ready-to-use vs. "needs install".

Why a registry rather than inline probes in dub_translate.py? The UI wants
to render the availability table BEFORE the user clicks Translate, so we
don't surface a cryptic ModuleNotFoundError for every segment. Having the
registry live next to the dub_translate dispatch also means adding a new
engine is one entry here + one branch in _build_translator.
"""
from __future__ import annotations

import asyncio
import importlib
import logging
import os
import shutil
import sys

logger = logging.getLogger("omnivoice.translation_engines")


# Engine ID → registry entry. Keyed by the `provider` string sent from the
# frontend (must match the values of `translateProvider` in the store).
REGISTRY: dict[str, dict] = {
    "argos": {
        "id": "argos",
        "display_name": "Argos (Local, Fast)",
        "pip_package": "argostranslate",
        "probe_module": "argostranslate",
        "category": "offline",
        "needs_key": False,
        "builtin": True,
        "notes": "Pure-CPU offline translator. Downloads a ~50MB language pack on first use per pair.",
    },
    "nllb": {
        "id": "nllb",
        "display_name": "NLLB-200 (Local, Heavy)",
        "pip_package": None,          # uses HF transformers — already a core dep
        "probe_module": "transformers",
        "category": "offline",
        "needs_key": False,
        "builtin": True,
        "notes": "Meta's 200-language NMT model. Large download (~2.4GB), best offline quality.",
    },
    "google": {
        "id": "google",
        "display_name": "Google Translate (Online, Free)",
        "pip_package": "deep_translator",
        "probe_module": "deep_translator",
        "category": "online",
        "needs_key": False,
        "notes": "Free web endpoint via deep_translator. Rate-limited by Google; no API key required.",
    },
    "deepl": {
        "id": "deepl",
        "display_name": "DeepL (Online, Key)",
        "pip_package": "deep_translator",
        "probe_module": "deep_translator",
        "category": "online",
        "needs_key": True,
        "notes": "High-quality EU MT. Free tier: 500K chars/month. Set DEEPL_API_KEY.",
    },
    "microsoft": {
        "id": "microsoft",
        "display_name": "Microsoft Translator (Online, Key)",
        "pip_package": "deep_translator",
        "probe_module": "deep_translator",
        "category": "online",
        "needs_key": True,
        "notes": "Azure Cognitive Services. Free tier: 2M chars/month. Set MICROSOFT_API_KEY.",
    },
    "mymemory": {
        "id": "mymemory",
        "display_name": "MyMemory (Online, No Key)",
        "pip_package": "deep_translator",
        "probe_module": "deep_translator",
        "category": "online",
        "needs_key": False,
        "notes": "Crowdsourced MT. Free, 5K chars/day anonymous; more with an email param.",
    },
    "openai": {
        "id": "openai",
        "display_name": "LLM (OpenAI-compatible)",
        "pip_package": "openai",
        "probe_module": "openai",
        "category": "llm",
        "needs_key": True,
        "notes": (
            "Any OpenAI-compatible endpoint: GPT-4/5 (OpenAI), Claude (via OpenRouter), "
            "Gemini (OpenAI-compat mode), DeepSeek, Qwen, Ollama, LM Studio. "
            "Set TRANSLATE_BASE_URL + TRANSLATE_API_KEY + TRANSLATE_MODEL."
        ),
    },
}


def is_frozen() -> bool:
    """True when running inside a packaged Tauri / PyInstaller bundle.

    In that case the Python site-packages is read-only and signed, so we
    refuse install/uninstall requests instead of corrupting the bundle.
    """
    return bool(getattr(sys, "frozen", False) or os.environ.get("OMNIVOICE_FROZEN"))


def _probe(entry: dict) -> tuple[bool, str]:
    mod = entry.get("probe_module")
    if not mod:
        return True, "no module required"
    try:
        importlib.import_module(mod)
        return True, "ready"
    except ImportError as e:
        return False, f"import {mod!r} failed: {e}"


def list_engines() -> list[dict]:
    """Return a UI-ready list with per-engine availability stamped in."""
    out = []
    for e in REGISTRY.values():
        installed, reason = _probe(e)
        out.append({
            **e,
            "installed": installed,
            "availability_reason": reason,
        })
    return out


def get_engine(engine_id: str) -> dict | None:
    return REGISTRY.get(engine_id)


def is_installed(engine_id: str) -> bool:
    entry = REGISTRY.get(engine_id)
    if not entry:
        return False
    ok, _ = _probe(entry)
    return ok


def _installer_cmd() -> list[str]:
    """Prefer `uv pip` (the dev install's default), fall back to `python -m pip`.

    Using `python -m pip` ensures we target the same interpreter the server
    is running under — avoids the classic "pip installed into the wrong venv"
    footgun.
    """
    if shutil.which("uv"):
        return ["uv", "pip"]
    return [sys.executable, "-m", "pip"]


async def run_pip(args: list[str], timeout: float = 600.0) -> tuple[int, str]:
    """Run a pip command async and return (rc, combined_output).

    Combines stdout + stderr so the UI can surface a useful tail on failure
    (pip's "ERROR: ..." lines go to stderr).
    """
    cmd = _installer_cmd() + args
    logger.info("pip: %s", " ".join(cmd))
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError as e:
        return 1, f"installer not found: {e}"
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return 1, f"pip timed out after {timeout:.0f}s"
    out = stdout.decode(errors="replace") if stdout else ""
    return proc.returncode or 0, out
