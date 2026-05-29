"""IndexTTS-2 venv probe + lazy bootstrap (Phase 2 Plan 02-03).

The parent process needs to know *which Python interpreter* to spawn the
IndexTTS sidecar under. This module owns that resolution. The probe runs
in three steps, in priority order, so the experience for existing
v0.2.7 users is transparent (their existing clone + venv is reused
verbatim — no re-download of the 6 GB model, no re-install of the
indextts package).

Probe order (Open Question #1 resolution from 02-RESEARCH.md):

    1. ``${OMNIVOICE_INDEXTTS_DIR}/.venv/`` (or ``Scripts\\python.exe`` on
       Windows). Highest priority — power users who already cloned
       IndexTTS and ran ``uv pip install -e .`` get zero migration cost.
    2. ``backend/engines/indextts/.venv/`` — this package's own venv,
       created by step 3 if needed. Survives across OmniVoice upgrades;
       the IndexTTS clone is referenced via ``uv pip install -e`` so
       weights and code live in the user's clone, not under OmniVoice.
    3. Bootstrap: run ``uv venv`` then ``uv pip install -e
       ${OMNIVOICE_INDEXTTS_DIR}`` to populate step-2's venv. Requires
       OMNIVOICE_INDEXTTS_DIR to be set (otherwise we don't know where
       the IndexTTS clone is); we raise with a clear error message that
       points at the install docs.

Caching: the resolution is memoised after the first successful call.
Tests reset the cache via :func:`invalidate`.

Threat model (Plan 02-03 frontmatter):

    T-02-08 — sidecar HF_TOKEN logging:
        Bootstrap never touches the token; the sidecar's stderr is
        drained by SubprocessBackend through the parent root logger
        where the Phase 1 ``HFTokenRedactor`` filter strips token bytes.
    T-02-09 — supply chain (uv pip install -e):
        Bootstrap installs from a user-controlled local directory
        (``OMNIVOICE_INDEXTTS_DIR``). The user already trusts that
        directory's contents (it's their own clone). Accepted for now; a
        later hardening pass can hash-pin the indextts requirements.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger("omnivoice.indextts.bootstrap")

# Absolute path to the sidecar entrypoint. ``IndexTTS2Backend.sidecar_script``
# returns this; SubprocessBackend spawns it with the resolved venv python.
INDEXTTS_SIDECAR_SCRIPT: Path = Path(__file__).parent / "main.py"

# Path to this package's owned venv (Probe 2). The IndexTTS clone, when
# bootstrapped, is installed into this venv via ``uv pip install -e``.
_ENGINES_VENV_DIR: Path = Path(__file__).parent / ".venv"

# Per-process resolution cache. Cleared by :func:`invalidate` for tests.
_resolved_python: Optional[Path] = None

# Timeouts. ``_venv_can_import_indextts`` is a bounded probe so we never
# hang waiting on a broken venv; the bootstrap install can take minutes
# on a cold cache (indextts pulls torch, transformers<5, etc.).
_IMPORT_PROBE_TIMEOUT_S = 10
_UV_VENV_TIMEOUT_S = 120
_UV_PIP_INSTALL_TIMEOUT_S = 900


# ── public API ────────────────────────────────────────────────────────────


def invalidate() -> None:
    """Clear the resolved-python cache. Tests call this between scenarios."""
    global _resolved_python
    _resolved_python = None


def is_indextts_installed() -> bool:
    """Quick file-existence check for a usable IndexTTS venv.

    Returns True if either Probe 1 or Probe 2 has a Python executable on
    disk. Does NOT spawn the sidecar Python and does NOT verify that
    ``import indextts`` actually succeeds — that's expensive enough that
    we save it for :func:`resolve_indextts_venv`, which is only invoked
    on the first generate() / health_check(). This function fires on
    every Settings page render via ``IndexTTS2Backend.is_available()``,
    so it stays cheap.
    """
    for cand in _probe_paths():
        if cand.is_file():
            return True
    return False


def resolve_indextts_venv() -> Path:
    """Resolve the path to the Python interpreter that runs the sidecar.

    Probe order described in the module docstring. Memoised. Raises
    :exc:`RuntimeError` if no working venv can be located AND the
    bootstrap path is unavailable.
    """
    global _resolved_python
    if _resolved_python is not None:
        return _resolved_python

    # Probe 1 — user's clone-level venv (highest priority for back-compat).
    omv_dir = os.environ.get("OMNIVOICE_INDEXTTS_DIR")
    if omv_dir:
        cand = _venv_python_path(Path(omv_dir) / ".venv")
        if cand.is_file() and _venv_can_import_indextts(cand):
            logger.info(
                "IndexTTS venv resolved from OMNIVOICE_INDEXTTS_DIR: %s", cand,
            )
            _resolved_python = cand
            return cand

    # Probe 2 — this package's own venv.
    cand = _venv_python_path(_ENGINES_VENV_DIR)
    if cand.is_file() and _venv_can_import_indextts(cand):
        logger.info("IndexTTS venv resolved from engines path: %s", cand)
        _resolved_python = cand
        return cand

    # Probe 3 — bootstrap.
    if not omv_dir:
        raise RuntimeError(
            "IndexTTS-2 is not installed. Set the OMNIVOICE_INDEXTTS_DIR "
            "environment variable to your IndexTTS clone (the directory "
            "that contains checkpoints/ and pyproject.toml), then restart "
            "OmniVoice. See docs/engines/indextts.md for the full install "
            "walk-through."
        )

    cand = _bootstrap_engines_venv(Path(omv_dir))
    _resolved_python = cand
    return cand


# ── internals ─────────────────────────────────────────────────────────────


def _venv_python_path(venv_dir: Path) -> Path:
    """Return the python executable path inside a venv directory.

    Handles the Unix (``bin/python``) vs Windows (``Scripts/python.exe``)
    layout. No filesystem access — caller checks .is_file().
    """
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _probe_paths() -> list[Path]:
    """Ordered list of candidate venv-python paths (no .is_file() check)."""
    out: list[Path] = []
    omv_dir = os.environ.get("OMNIVOICE_INDEXTTS_DIR")
    if omv_dir:
        out.append(_venv_python_path(Path(omv_dir) / ".venv"))
    out.append(_venv_python_path(_ENGINES_VENV_DIR))
    return out


def _venv_can_import_indextts(python_path: Path) -> bool:
    """Spawn the candidate python and verify ``import indextts.infer_v2`` works.

    Bounded by ``_IMPORT_PROBE_TIMEOUT_S`` so a wedged venv never hangs
    the parent. Returns False on any failure (non-zero exit, timeout,
    OSError).
    """
    try:
        proc = subprocess.run(
            [str(python_path), "-c", "import indextts.infer_v2"],
            capture_output=True,
            timeout=_IMPORT_PROBE_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.debug("indextts import probe failed for %s: %s", python_path, exc)
        return False
    if proc.returncode != 0:
        logger.debug(
            "indextts import probe non-zero for %s: %s",
            python_path,
            proc.stderr.decode("utf-8", errors="replace")[:200],
        )
        return False
    return True


def _locate_uv() -> Optional[str]:
    """Find the uv binary — bundled first (Tauri-set env var), else PATH."""
    bundled = os.environ.get("OMNIVOICE_BUNDLED_UV")
    if bundled and Path(bundled).is_file():
        return bundled
    sys_uv = shutil.which("uv")
    if sys_uv:
        return sys_uv
    return None


def _bootstrap_engines_venv(indextts_clone: Path) -> Path:
    """Create engines/indextts/.venv and install the user's clone into it.

    Runs ``uv venv <engines_venv>`` then ``uv pip install --python
    <engines_venv>/bin/python -e <indextts_clone>``. Verifies the result
    by re-probing the import — a successful uv invocation that still
    can't import indextts indicates a deeper environment problem and
    we raise with whatever stderr we captured.
    """
    uv = _locate_uv()
    if not uv:
        raise RuntimeError(
            "uv is required to bootstrap the IndexTTS-2 venv but was not "
            "found on PATH (and the bundled uv path was not set via the "
            "OMNIVOICE_BUNDLED_UV env var). Install uv from "
            "https://docs.astral.sh/uv/ and re-launch OmniVoice, or set "
            "OMNIVOICE_BUNDLED_UV to the absolute path of a uv binary."
        )

    logger.info(
        "Bootstrapping IndexTTS venv at %s from %s (this can take several minutes on first launch)",
        _ENGINES_VENV_DIR, indextts_clone,
    )

    try:
        subprocess.run(
            [uv, "venv", str(_ENGINES_VENV_DIR)],
            check=True,
            timeout=_UV_VENV_TIMEOUT_S,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"uv venv failed for IndexTTS bootstrap at {_ENGINES_VENV_DIR}: "
            f"{exc.stderr.decode('utf-8', errors='replace') if exc.stderr else exc}"
        ) from exc

    python_path = _venv_python_path(_ENGINES_VENV_DIR)
    try:
        subprocess.run(
            [
                uv, "pip", "install",
                "--python", str(python_path),
                "-e", str(indextts_clone),
            ],
            check=True,
            timeout=_UV_PIP_INSTALL_TIMEOUT_S,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "uv pip install -e failed during IndexTTS bootstrap "
            f"({indextts_clone}): "
            f"{exc.stderr.decode('utf-8', errors='replace') if exc.stderr else exc}"
        ) from exc

    if not _venv_can_import_indextts(python_path):
        raise RuntimeError(
            "IndexTTS bootstrap completed but `import indextts.infer_v2` "
            f"still fails from {python_path}. Verify that "
            f"{indextts_clone} is a valid IndexTTS clone (contains "
            "pyproject.toml with the indextts package). See "
            "docs/engines/indextts.md."
        )

    logger.info("IndexTTS venv bootstrap successful: %s", python_path)
    return python_path


__all__ = [
    "INDEXTTS_SIDECAR_SCRIPT",
    "invalidate",
    "is_indextts_installed",
    "resolve_indextts_venv",
]
