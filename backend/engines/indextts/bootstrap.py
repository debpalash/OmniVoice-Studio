"""IndexTTS 2.5/2 venv probe + lazy bootstrap (Phase 2 Plan 02-03).

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
       created by step 3 if needed. Survives across VoiceStudio upgrades;
       the IndexTTS clone is referenced via ``uv pip install -e`` so
       weights and code live in the user's clone, not under VoiceStudio.
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
import subprocess
from pathlib import Path
from typing import Optional

from engines._venv_probe import ProbeResult, log_safe, venv_can_import

logger = logging.getLogger("omnivoice.indextts.bootstrap")

# Absolute path to the sidecar entrypoint. ``IndexTTS2Backend.sidecar_script``
# returns this; SubprocessBackend spawns it with the resolved venv python.
INDEXTTS_SIDECAR_SCRIPT: Path = Path(__file__).parent / "main.py"

# Path to this package's owned venv (Probe 2). The IndexTTS clone, when
# bootstrapped, is installed into this venv via ``uv pip install -e``.
_ENGINES_VENV_DIR: Path = Path(__file__).parent / ".venv"


def _uv_env() -> "dict[str, str] | None":
    """uv cache co-location for installs on a non-system volume (D:-drive /
    portable installs): without it uv stages every wheel on the system drive
    and cross-volume COPIES it into the venv. Canonical logic lives in
    services.sidecar_install.uv_subprocess_env (lazy import, like _locate_uv).
    """
    from services.sidecar_install import uv_subprocess_env
    return uv_subprocess_env(_ENGINES_VENV_DIR.parent.parent)

# Per-process resolution cache. Cleared by :func:`invalidate` for tests.
_resolved_python: Optional[Path] = None

# Timeouts. The import probe's bound lives in ``engines._venv_probe`` (shared
# with every other subprocess engine, and tunable per host); the bootstrap
# install can take minutes on a cold cache (indextts pulls torch,
# transformers<5, etc.).
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

    # A candidate whose probe ran out of time (#1414). Preferred over
    # bootstrapping or declaring the engine missing, but only once every
    # candidate has had its chance to prove itself outright.
    unproven: Optional[Path] = None

    # Probe 1 — user's clone-level venv (highest priority for back-compat).
    omv_dir = os.environ.get("OMNIVOICE_INDEXTTS_DIR")
    if omv_dir:
        cand = _venv_python_path(Path(omv_dir) / ".venv")
        if cand.is_file():
            verdict = _venv_can_import_indextts(cand)
            if verdict == "yes":
                logger.info(
                    "IndexTTS venv resolved from OMNIVOICE_INDEXTTS_DIR: %s", cand,
                )
                _resolved_python = cand
                return cand
            if verdict == "unproven":
                unproven = cand

    # Probe 2 — this package's own venv.
    cand = _venv_python_path(_ENGINES_VENV_DIR)
    if cand.is_file():
        verdict = _venv_can_import_indextts(cand)
        if verdict == "yes":
            logger.info("IndexTTS venv resolved from engines path: %s", cand)
            _resolved_python = cand
            return cand
        if verdict == "unproven" and unproven is None:
            unproven = cand

    if unproven is not None:
        # Nothing proved itself, but something plausible is installed. Use it:
        # a venv that really is broken fails the sidecar handshake with a real
        # error, which beats reinstalling over the top of a working install or
        # telling the user their engine isn't there.
        logger.warning(
            "IndexTTS venv %s could not be verified in time; using it anyway "
            "rather than treating a slow import as a missing install (#1414).",
            log_safe(unproven),
        )
        _resolved_python = unproven
        return unproven

    # Probe 3 — bootstrap.
    if not omv_dir:
        raise RuntimeError(
            "IndexTTS 2.5 is not installed. Set the OMNIVOICE_INDEXTTS_DIR "
            "environment variable to your IndexTTS clone (the directory "
            "that contains checkpoints/ and pyproject.toml), then restart "
            "VoiceStudio. See docs/engines/indextts.md for the full install "
            "walk-through."
        )

    cand = _bootstrap_engines_venv(Path(omv_dir))
    _resolved_python = cand
    return cand


# ── internals ─────────────────────────────────────────────────────────────


def _venv_python_path(venv_dir: Path) -> Path:
    """Return the python executable path inside a venv directory.

    Handles the Unix (``bin/python``) vs Windows (``Scripts/python.exe``)
    layout. No filesystem access — caller checks .is_file(). Delegates to
    the canonical implementation in :mod:`services.sidecar_install` so the
    cross-platform venv-layout rule lives in exactly one place.
    """
    from services.sidecar_install import _venv_python
    return _venv_python(venv_dir)


def _probe_paths() -> list[Path]:
    """Ordered list of candidate venv-python paths (no .is_file() check)."""
    out: list[Path] = []
    omv_dir = os.environ.get("OMNIVOICE_INDEXTTS_DIR")
    if omv_dir:
        out.append(_venv_python_path(Path(omv_dir) / ".venv"))
    out.append(_venv_python_path(_ENGINES_VENV_DIR))
    return out


def _venv_can_import_indextts(python_path: Path) -> ProbeResult:
    """Verify IndexTTS 2.5, retaining user-managed IndexTTS-2 compatibility.

    Tri-state — "yes" / "no" / "unproven". See ``engines._venv_probe``: a
    probe that runs out of time proves nothing, and treating that as "no"
    is what discarded working OMNIVOICE_INDEXTTS_DIR installs (#1414).
    """
    probe = (
        "try:\n import indextts.infer_v2_5\n"
        "except ModuleNotFoundError as exc:\n"
        " if exc.name != 'indextts.infer_v2_5': raise\n"
        " import indextts.infer_v2\n"
    )
    return venv_can_import(python_path, probe, engine="indextts", logger=logger)


def _locate_uv() -> Optional[str]:
    """Find the uv binary — bundled first (Tauri-set env var), else PATH.

    Delegates to :mod:`services.sidecar_install`'s canonical resolver so the
    bundled-uv contract (env var name, precedence) can't drift between this
    lazy bootstrap and the one-click installer.
    """
    from services.sidecar_install import _locate_uv as _canonical_locate_uv
    return _canonical_locate_uv()


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
            "uv is required to bootstrap the IndexTTS 2.5 venv but was not "
            "found on PATH (and the bundled uv path was not set via the "
            "OMNIVOICE_BUNDLED_UV env var). Install uv from "
            "https://docs.astral.sh/uv/ and re-launch VoiceStudio, or set "
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
            env=_uv_env(),
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
            env=_uv_env(),
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "uv pip install -e failed during IndexTTS bootstrap "
            f"({indextts_clone}): "
            f"{exc.stderr.decode('utf-8', errors='replace') if exc.stderr else exc}"
        ) from exc

    # Only a *proven* failure is fatal here: a bootstrap that installed
    # correctly and is merely slow to import must not be thrown away after
    # spending minutes on the install (#1414).
    if _venv_can_import_indextts(python_path) == "no":
        raise RuntimeError(
            "IndexTTS bootstrap completed but neither the 2.5 nor 2 inference "
            f"module imports from {python_path}. Verify that "
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
