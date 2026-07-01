"""Confucius4-TTS venv probe + lazy bootstrap (issue #590).

Confucius4-TTS (netease-youdao) is an LLM-based multilingual zero-shot cloning
TTS — 14 languages, no reference transcript required, Apache-2.0. Like the other
heavyweight opt-in engines (IndexTTS / MOSS-TTS-v1.5 / dots.tts) it runs in its
**own subprocess venv**: upstream targets Python 3.10 + CUDA 12.6 with its own
dependency set, which we keep off the parent interpreter.

Probe order (existing power-user installs win — zero migration):

    1. ``${OMNIVOICE_CONFUCIUS4_TTS_DIR}/.venv/`` — the user's clone-level venv.
    2. ``backend/engines/confucius4/.venv/`` — this package's own venv.
    3. Bootstrap: ``uv venv`` then ``uv pip install -r <clone>/requirements.txt``
       (+ ``uv pip install -e <clone>`` only if upstream ever ships packaging).

Validated end-to-end 2026-07-02 (Apple Silicon, CPU): upstream ships **no
pyproject.toml/setup.py**, so ``confuciustts`` is importable only with the
clone root on ``sys.path`` — the import probe and the sidecar both handle
that. The engine is opt-in (env-dir gated) and never touched unless
``OMNIVOICE_CONFUCIUS4_TTS_DIR`` is set, so this can't affect the default
install on any platform.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger("omnivoice.confucius4.bootstrap")

#: Absolute path to the sidecar entrypoint.
CONFUCIUS4_SIDECAR_SCRIPT: Path = Path(__file__).parent / "main.py"

#: This package's owned venv (Probe 2).
_ENGINES_VENV_DIR: Path = Path(__file__).parent / ".venv"

#: Env var pointing at the user's Confucius4-TTS clone root.
_CLONE_DIR_ENV: str = "OMNIVOICE_CONFUCIUS4_TTS_DIR"

#: The package importable from the clone (verify against upstream).
_IMPORT_PROBE = "confuciustts"

_resolved_python: Optional[Path] = None

_IMPORT_PROBE_TIMEOUT_S = 15
_UV_VENV_TIMEOUT_S = 120
_UV_PIP_INSTALL_TIMEOUT_S = 1800


def invalidate() -> None:
    """Clear the resolved-python cache. Tests call this between scenarios."""
    global _resolved_python
    _resolved_python = None


def is_confucius4_installed() -> bool:
    """Cheap file-existence check for a usable venv (no subprocess spawn)."""
    return any(cand.is_file() for cand in _probe_paths())


def resolve_confucius4_venv() -> Path:
    """Resolve the sidecar's Python interpreter (probe order in the docstring).
    Memoised. Raises :exc:`RuntimeError` if none can be located and bootstrap
    is unavailable."""
    global _resolved_python
    if _resolved_python is not None:
        return _resolved_python

    clone_dir = os.environ.get(_CLONE_DIR_ENV)

    if clone_dir:
        cand = _venv_python_path(Path(clone_dir) / ".venv")
        if cand.is_file() and _venv_can_import(cand):
            logger.info("Confucius4 venv resolved from %s: %s", _CLONE_DIR_ENV, cand)
            _resolved_python = cand
            return cand

    cand = _venv_python_path(_ENGINES_VENV_DIR)
    if cand.is_file() and _venv_can_import(cand):
        logger.info("Confucius4 venv resolved from engines path: %s", cand)
        _resolved_python = cand
        return cand

    if not clone_dir:
        raise RuntimeError(
            "Confucius4-TTS is not installed. Set the "
            f"{_CLONE_DIR_ENV} environment variable to your Confucius4-TTS clone "
            "(the directory that contains requirements.txt), then restart "
            "OmniVoice. See docs/engines/confucius4-tts.md."
        )

    cand = _bootstrap_engines_venv(Path(clone_dir))
    _resolved_python = cand
    return cand


def _venv_python_path(venv_dir: Path) -> Path:
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _probe_paths() -> list[Path]:
    out: list[Path] = []
    clone_dir = os.environ.get(_CLONE_DIR_ENV)
    if clone_dir:
        out.append(_venv_python_path(Path(clone_dir) / ".venv"))
    out.append(_venv_python_path(_ENGINES_VENV_DIR))
    return out


def _import_probe_code() -> str:
    """Probe snippet mirroring the sidecar's import semantics: upstream is not
    pip-installable, so ``confuciustts`` resolves via the clone on sys.path."""
    clone = os.environ.get(_CLONE_DIR_ENV, "")
    if clone:
        return f"import sys; sys.path.insert(0, {clone!r}); import {_IMPORT_PROBE}"
    return f"import {_IMPORT_PROBE}"


def _venv_can_import(python_path: Path) -> bool:
    """Spawn the candidate python and verify ``import confuciustts`` works."""
    try:
        proc = subprocess.run(
            [str(python_path), "-c", _import_probe_code()],
            capture_output=True, timeout=_IMPORT_PROBE_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.debug("Confucius4 import probe failed for %s: %s", python_path, exc)
        return False
    if proc.returncode != 0:
        logger.debug(
            "Confucius4 import probe non-zero for %s: %s",
            python_path, proc.stderr.decode("utf-8", errors="replace")[:200],
        )
        return False
    return True


def _locate_uv() -> Optional[str]:
    bundled = os.environ.get("OMNIVOICE_BUNDLED_UV")
    if bundled and Path(bundled).is_file():
        return bundled
    return shutil.which("uv")


def _bootstrap_engines_venv(clone_dir: Path) -> Path:
    """Create engines/confucius4/.venv and install the user's clone."""
    uv = _locate_uv()
    if not uv:
        raise RuntimeError(
            "uv is required to bootstrap the Confucius4-TTS venv but was not "
            "found on PATH (and OMNIVOICE_BUNDLED_UV was not set). Install uv "
            "from https://docs.astral.sh/uv/ and re-launch OmniVoice."
        )

    logger.info(
        "Bootstrapping Confucius4 venv at %s from %s (several minutes on first "
        "launch)", _ENGINES_VENV_DIR, clone_dir,
    )
    try:
        subprocess.run(
            [uv, "venv", "--python", "3.10", str(_ENGINES_VENV_DIR)],
            check=True, timeout=_UV_VENV_TIMEOUT_S, capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"uv venv failed for Confucius4 bootstrap at {_ENGINES_VENV_DIR}: "
            f"{exc.stderr.decode('utf-8', errors='replace') if exc.stderr else exc}"
        ) from exc

    python_path = _venv_python_path(_ENGINES_VENV_DIR)
    requirements = clone_dir / "requirements.txt"
    try:
        if requirements.is_file():
            subprocess.run(
                [uv, "pip", "install", "--python", str(python_path),
                 "-r", str(requirements)],
                check=True, timeout=_UV_PIP_INSTALL_TIMEOUT_S, capture_output=True,
            )
        # Editable install only if upstream ever ships packaging metadata —
        # as of 2026-07 there is none, and `uv pip install -e` on a bare clone
        # fails outright. Import resolution is handled via sys.path instead.
        if (clone_dir / "pyproject.toml").is_file() or (clone_dir / "setup.py").is_file():
            subprocess.run(
                [uv, "pip", "install", "--python", str(python_path), "-e", str(clone_dir)],
                check=True, timeout=_UV_PIP_INSTALL_TIMEOUT_S, capture_output=True,
            )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "uv pip install failed during Confucius4 bootstrap "
            f"({clone_dir}): "
            f"{exc.stderr.decode('utf-8', errors='replace') if exc.stderr else exc}. "
            "See docs/engines/confucius4-tts.md."
        ) from exc

    if not _venv_can_import(python_path):
        raise RuntimeError(
            f"Confucius4 bootstrap completed but `import {_IMPORT_PROBE}` still "
            f"fails from {python_path}. Verify {clone_dir} is a valid clone. "
            "See docs/engines/confucius4-tts.md."
        )

    logger.info("Confucius4 venv bootstrap successful: %s", python_path)
    return python_path


__all__ = [
    "CONFUCIUS4_SIDECAR_SCRIPT",
    "invalidate",
    "is_confucius4_installed",
    "resolve_confucius4_venv",
]
