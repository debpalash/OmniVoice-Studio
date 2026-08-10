"""dots.tts venv probe + lazy bootstrap (issue #498).

Resolves which Python interpreter runs the dots.tts sidecar. Mirrors
``engines.indextts.bootstrap`` / ``engines.moss_tts_v15.bootstrap`` because
dots.tts has the same shape of problem: a hard ``transformers==4.57.0`` pin
that conflicts with the parent's ``transformers>=5.3`` — so it runs in its
own venv.

Probe order (priority — existing power-user installs win, zero migration):

    1. ``${OMNIVOICE_DOTS_TTS_DIR}/.venv/`` — the user's clone-level venv.
    2. ``backend/engines/dots_tts/.venv/`` — this package's own venv.
    3. Bootstrap: ``uv venv`` then ``uv pip install -e <clone> -c
       <clone>/constraints/recommended.txt`` (the upstream-pinned stack:
       torch==2.8.0, transformers==4.57.0, …).

Caching: memoised after first success. Tests reset via :func:`invalidate`.

Security: same posture as IndexTTS — bootstrap never touches HF_TOKEN; the
sidecar's stderr is redacted by the parent's ``HFTokenRedactor``; the
editable install comes from a user-controlled clone they already trust.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

from engines._venv_probe import ProbeResult, log_safe, venv_can_import

logger = logging.getLogger("omnivoice.dots_tts.bootstrap")

#: Absolute path to the sidecar entrypoint.
DOTS_TTS_SIDECAR_SCRIPT: Path = Path(__file__).parent / "main.py"

#: This package's owned venv (Probe 2).
_ENGINES_VENV_DIR: Path = Path(__file__).parent / ".venv"


def _uv_env() -> "dict[str, str] | None":
    """uv cache co-location for installs on a non-system volume (D:-drive /
    portable installs): without it uv stages every wheel on the system drive
    and cross-volume COPIES it into the venv. Canonical logic lives in
    services.sidecar_install.uv_subprocess_env (lazy import, like _locate_uv).
    """
    from services.sidecar_install import uv_subprocess_env
    return uv_subprocess_env(_ENGINES_VENV_DIR.parent.parent)

#: Env var pointing at the user's dots.tts clone root.
_CLONE_DIR_ENV: str = "OMNIVOICE_DOTS_TTS_DIR"

#: Per-process resolution cache. Cleared by :func:`invalidate` for tests.
_resolved_python: Optional[Path] = None

_UV_VENV_TIMEOUT_S = 120
_UV_PIP_INSTALL_TIMEOUT_S = 1800


# ── public API ────────────────────────────────────────────────────────────


def invalidate() -> None:
    """Clear the resolved-python cache. Tests call this between scenarios."""
    global _resolved_python
    _resolved_python = None


def is_dots_tts_installed() -> bool:
    """Cheap file-existence check for a usable dots.tts venv. Does NOT spawn
    the venv Python — that's saved for :func:`resolve_dots_tts_venv`."""
    for cand in _probe_paths():
        if cand.is_file():
            return True
    return False


def resolve_dots_tts_venv() -> Path:
    """Resolve the sidecar's Python interpreter (probe order in the module
    docstring). Memoised. Raises :exc:`RuntimeError` if none can be located
    and the bootstrap path is unavailable."""
    global _resolved_python
    if _resolved_python is not None:
        return _resolved_python

    clone_dir = os.environ.get(_CLONE_DIR_ENV)

    # A candidate whose probe ran out of time (#1414): preferred over
    # bootstrapping or declaring the engine missing, but only after every
    # candidate has had its chance to prove itself outright.
    unproven: Optional[Path] = None

    # Probe 1 — user's clone-level venv.
    if clone_dir:
        cand = _venv_python_path(Path(clone_dir) / ".venv")
        if cand.is_file():
            verdict = _venv_can_import_dots(cand)
            if verdict == "yes":
                logger.info(
                    "dots.tts venv resolved from %s: %s", _CLONE_DIR_ENV, cand,
                )
                _resolved_python = cand
                return cand
            if verdict == "unproven":
                unproven = cand

    # Probe 2 — this package's own venv.
    cand = _venv_python_path(_ENGINES_VENV_DIR)
    if cand.is_file():
        verdict = _venv_can_import_dots(cand)
        if verdict == "yes":
            logger.info("dots.tts venv resolved from engines path: %s", cand)
            _resolved_python = cand
            return cand
        if verdict == "unproven" and unproven is None:
            unproven = cand

    if unproven is not None:
        # Nothing proved itself, but something plausible is installed. Use
        # it: a venv that really is broken fails the sidecar handshake with
        # a real error, which beats reinstalling over the top of a working
        # install or telling the user their engine isn't there.
        logger.warning(
            "dots.tts venv %s could not be verified in time; using it "
            "anyway rather than treating a slow import as a missing "
            "install (#1414).",
            log_safe(unproven),
        )
        _resolved_python = unproven
        return unproven

    # Probe 3 — bootstrap.
    if not clone_dir:
        raise RuntimeError(
            "dots.tts is not installed. Set the "
            f"{_CLONE_DIR_ENV} environment variable to your dots.tts clone "
            "(the directory that contains pyproject.toml and constraints/), "
            "then restart VoiceStudio. See docs/engines/dots-tts.md for the "
            "full install walk-through."
        )

    cand = _bootstrap_engines_venv(Path(clone_dir))
    _resolved_python = cand
    return cand


# ── internals ─────────────────────────────────────────────────────────────


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


def _venv_can_import_dots(python_path: Path) -> ProbeResult:
    """Spawn the candidate python and verify the engine imports.

    Tri-state — "yes" / "no" / "unproven". See ``engines._venv_probe``:
    a probe that runs out of time proves nothing, and treating that as
    "no" is what discarded working user installs (#1414).
    """
    return venv_can_import(
        python_path, "import dots_tts.runtime", engine="dots_tts", logger=logger,
    )


def _locate_uv() -> Optional[str]:
    bundled = os.environ.get("OMNIVOICE_BUNDLED_UV")
    if bundled and Path(bundled).is_file():
        return bundled
    return shutil.which("uv")


def _bootstrap_engines_venv(clone_dir: Path) -> Path:
    """Create engines/dots_tts/.venv and editable-install the user's clone
    with the upstream constraints file."""
    uv = _locate_uv()
    if not uv:
        raise RuntimeError(
            "uv is required to bootstrap the dots.tts venv but was not found "
            "on PATH (and OMNIVOICE_BUNDLED_UV was not set). Install uv from "
            "https://docs.astral.sh/uv/ and re-launch VoiceStudio, or set "
            "OMNIVOICE_BUNDLED_UV to the absolute path of a uv binary."
        )

    logger.info(
        "Bootstrapping dots.tts venv at %s from %s (this can take several "
        "minutes on first launch)", _ENGINES_VENV_DIR, clone_dir,
    )

    try:
        subprocess.run(
            [uv, "venv", str(_ENGINES_VENV_DIR)],
            check=True, timeout=_UV_VENV_TIMEOUT_S, capture_output=True,
            env=_uv_env(),
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"uv venv failed for dots.tts bootstrap at {_ENGINES_VENV_DIR}: "
            f"{exc.stderr.decode('utf-8', errors='replace') if exc.stderr else exc}"
        ) from exc

    python_path = _venv_python_path(_ENGINES_VENV_DIR)
    install_cmd = [
        uv, "pip", "install",
        "--python", str(python_path),
        "-e", str(clone_dir),
    ]
    # Apply the upstream pin set when it ships with the clone.
    constraints = clone_dir / "constraints" / "recommended.txt"
    if constraints.is_file():
        install_cmd += ["-c", str(constraints)]
    try:
        subprocess.run(
            install_cmd, check=True,
            timeout=_UV_PIP_INSTALL_TIMEOUT_S, capture_output=True,
            env=_uv_env(),
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "uv pip install -e failed during dots.tts bootstrap "
            f"({clone_dir}): "
            f"{exc.stderr.decode('utf-8', errors='replace') if exc.stderr else exc}. "
            "See docs/engines/dots-tts.md."
        ) from exc

    # Only a *proven* failure is fatal: a bootstrap that installed correctly
    # and is merely slow to import must not be thrown away after spending
    # minutes on the install (#1414).
    if _venv_can_import_dots(python_path) == "no":
        raise RuntimeError(
            "dots.tts bootstrap completed but `import dots_tts.runtime` still "
            f"fails from {python_path}. Verify that {clone_dir} is a valid "
            "dots.tts clone. See docs/engines/dots-tts.md."
        )

    logger.info("dots.tts venv bootstrap successful: %s", python_path)
    return python_path


__all__ = [
    "DOTS_TTS_SIDECAR_SCRIPT",
    "invalidate",
    "is_dots_tts_installed",
    "resolve_dots_tts_venv",
]
