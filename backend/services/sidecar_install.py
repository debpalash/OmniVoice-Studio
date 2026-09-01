"""One-click sidecar-engine provisioner.

Some engines (IndexTTS 2.5, MOSS-v1.5, dots.tts, and Confucius4) have the
same shape and can't live in the app venv because they pin a ``transformers``
version that conflicts with the parent's ``>=5.3``. They run as sidecars:
a source checkout + a dedicated venv + (for IndexTTS-2) model weights in
``<checkout>/checkpoints/``. Until now provisioning that trio was four
manual terminal steps; this module turns it into a resumable background
job the Model Catalogue → Engines UI can start and poll.

Design notes (single source of truth for the choices):

* **Fetch: git primary, tarball fallback.** ``git clone --depth 1`` is the
  primary path (fast, matches the documented manual flow, and leaves a
  repo the user can update). When git is absent — common on Windows — we
  fall back to downloading the GitHub source tarball over HTTPS (httpx,
  honours proxy env vars) and extracting it with :mod:`tarfile`. A
  ``pip install git+https://…`` path was rejected because the engine
  *directory* must exist on disk anyway: the sidecar resolves its venv
  and model weights relative to it.
* **Managed install root:** ``DATA_DIR/engines/<engine_id>/`` — always
  user-writable (works in frozen/packaged builds where ``backend/`` is
  read-only), survives app updates, and never collides with a user's own
  clone. A user-managed install (env var already pointing at their clone)
  is left completely alone.
* **Weights ARE part of the install** for engines whose sidecar loads
  from ``<checkout>/<weights_subdir>/`` (IndexTTS 2.5's ``main.py`` reads
  ``$OMNIVOICE_INDEXTTS_DIR/checkpoints/config_v2_5.yaml`` — verified). The
  download goes through ``huggingface_hub.snapshot_download`` with the
  endpoint from :mod:`services.endpoint_race` (HF endpoint auto-select;
  **no hardcoded huggingface.co**) and the token from
  :mod:`services.token_resolver`.
* **Idempotent + resumable:** every step no-ops when its output is
  already healthy and repairs it when it is half-there (a checkout
  without ``pyproject.toml`` is re-fetched; a venv that can't import the
  probe module is re-installed; ``snapshot_download`` resumes weights).
* **Persistence:** on success the checkout path is written to
  ``os.environ[<env_var>]`` (the engine's bootstrap reads the env var, so
  it works immediately — no restart) and to ``prefs.json`` under
  ``env.<env_var>`` (restored into the environment at startup by
  ``main.py``), the same mechanism Settings' env panel uses.

Cross-platform: no symlinks, no shell strings (argv lists only), venv
layout resolved per-OS (``Scripts/python.exe`` vs ``bin/python``).
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from core.config import DATA_DIR
from core.contained_subprocess import OwnedPopen, WindowsJobPopen, spawn_owned

logger = logging.getLogger("omnivoice.sidecar_install")

_GIB = 1024 ** 3

# Headroom kept free on the target volume on top of the estimated install
# size. Same needs-X/have-Y message shape as the model-install guard
# (api.routers.setup.models.disk_space_error), but a deliberately SMALLER
# floor than its MIN_FREE_GB=10: required_bytes here is already a
# conservative over-estimate, so stacking the full model-cache headroom on
# top would block legitimate installs on ~15 GB-free machines.
MIN_FREE_GB = 5

# Bounded in-memory log per job (last N lines survive; enough for the UI's
# log tail and for the failure remediation to quote real output).
_LOG_MAX_LINES = 200

_GIT_CLONE_TIMEOUT_S = 600
_TARBALL_TIMEOUT_S = 600
_UV_VENV_TIMEOUT_S = 300
_UV_PIP_INSTALL_TIMEOUT_S = 3600
_IMPORT_PROBE_TIMEOUT_S = 120


# ── Spec ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SidecarSpec:
    """Everything the provisioner needs to install one sidecar engine.

    Parametrized so future sidecar engines (MOSS-v1.5, dots.tts,
    Confucius4) become one SPECS entry, not another installer.
    """

    engine_id: str
    display_name: str
    repo_url: str                      # git clone URL (primary fetch path)
    tarball_url: str                   # source tarball (fallback when git is absent)
    checkout_dirname: str              # directory name of the checkout under the managed root
    env_var: str                       # env var the engine's bootstrap reads (install dir)
    probe_module: str                  # python -c "import <probe_module>" proves the venv works
    repo_ref: Optional[str] = None     # branch/tag selected by git clone
    source_revision: Optional[str] = None  # reviewed upstream commit
    source_required_path: Optional[str] = None  # distinguishes incompatible source generations
    weights_repo_id: Optional[str] = None   # HF repo downloaded into <checkout>/<weights_subdir>
    weights_revision: Optional[str] = None  # reviewed HF commit
    weights_subdir: str = "checkpoints"
    # Model-config filenames accepted inside weights_subdir. A tuple, not a
    # single name: IndexTTS 2.5's weights repo ships config.yaml, but installs
    # predating #1611 were only usable after hand-renaming it to
    # config_v2_5.yaml, and those must keep working without a reinstall.
    weights_config_names: tuple[str, ...] = ("config.yaml",)
    docs_path: str = "docs/engines"         # where the manual-install fallback lives
    required_bytes: int = 12 * _GIB    # conservative source+venv+weights estimate for preflight
    weights_bytes: Optional[int] = None
    dependency_bytes: Optional[int] = None
    potentially_shared_bytes: Optional[int] = None
    temporary_free_bytes: Optional[int] = None
    disk_confidence: str = "unknown"
    # Called after a successful install/uninstall so the engine's memoised
    # venv resolution re-probes (import inside the lambda — never at module load).
    invalidate: Callable[[], None] = field(default=lambda: None)
    # Cheap "is a healthy install already present?" probe (file existence only).
    installed_probe: Callable[[], bool] = field(default=lambda: False)


def _indextts_invalidate() -> None:
    from engines.indextts import bootstrap
    bootstrap.invalidate()


def _indextts_installed() -> bool:
    from engines.indextts.bootstrap import is_indextts_installed
    return is_indextts_installed()


SPECS: dict[str, SidecarSpec] = {
    "indextts2": SidecarSpec(
        engine_id="indextts2",
        display_name="IndexTTS 2.5",
        repo_url="https://github.com/index-tts/index-tts.git",
        tarball_url=(
            "https://github.com/index-tts/index-tts/archive/"
            "bf2e967fac7933197143b017a60820b1ad40c448.tar.gz"
        ),
        checkout_dirname="index-tts-2.5",
        env_var="OMNIVOICE_INDEXTTS_DIR",
        probe_module="indextts.infer_v2_5",
        repo_ref="indextts-2.5",
        source_revision="bf2e967fac7933197143b017a60820b1ad40c448",
        source_required_path="indextts/infer_v2_5.py",
        weights_repo_id="IndexTeam/IndexTTS-2.5",
        weights_revision="d0aa86e75bb6f3437f3831e95056fa72842d89ef",
        weights_subdir="checkpoints",
        weights_config_names=("config.yaml", "config_v2_5.yaml"),
        docs_path="docs/engines/indextts.md",
        # ~0.1 GB source + up to ~6 GB venv (torch + transformers<5) +
        # ~6 GB weights. Deliberately conservative; the preflight subtracts
        # whatever a partial install already put on disk.
        required_bytes=12 * _GIB,
        weights_bytes=6 * _GIB,
        dependency_bytes=6 * _GIB,
        potentially_shared_bytes=None,
        temporary_free_bytes=12 * _GIB,
        disk_confidence="estimated",
        invalidate=_indextts_invalidate,
        installed_probe=_indextts_installed,
    ),
}


def get_spec(engine_id: str) -> Optional[SidecarSpec]:
    return SPECS.get(engine_id)


def persistent_env_vars() -> set[str]:
    """Env vars the provisioner persists — merged into the Settings env-var
    allowlist (api.routers.system.PERSISTENT_KEYS) so users can inspect or
    clear them from the same panel as every other persisted var."""
    return {s.env_var for s in SPECS.values()}


# ── Paths ──────────────────────────────────────────────────────────────────


def managed_root(spec: SidecarSpec) -> Path:
    """Per-engine managed install root (checkout lives inside it)."""
    return Path(DATA_DIR) / "engines" / spec.engine_id


def managed_checkout(spec: SidecarSpec) -> Path:
    return managed_root(spec) / spec.checkout_dirname


def _legacy_managed_checkouts(spec: SidecarSpec) -> tuple[Path, ...]:
    """App-owned predecessor checkouts retained during in-place upgrades."""
    if spec.engine_id == "indextts2":
        return (managed_root(spec) / "index-tts",)
    return ()


def _venv_python(venv_dir: Path) -> Path:
    """Venv python path, per-OS layout (Windows: Scripts/, POSIX: bin/)."""
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _locate_uv() -> Optional[str]:
    """Find uv: bundled (Tauri-set OMNIVOICE_BUNDLED_UV) first, then PATH.

    Same resolution order as engines.indextts.bootstrap._locate_uv — the
    canonical uv-resolution pattern for sidecar venvs.
    """
    bundled = os.environ.get("OMNIVOICE_BUNDLED_UV")
    if bundled and Path(bundled).is_file():
        return bundled
    return shutil.which("uv")


# ── uv volume co-location ──────────────────────────────────────────────────
#
# uv keeps its wheel cache (and managed Pythons) under the OS cache/data
# roots on the SYSTEM drive (%LOCALAPPDATA%\uv\cache, ~/.cache/uv, …). When a
# sidecar venv lives on a different volume — DATA_DIR on D:, portable mode —
# every wheel (the sidecar's own multi-GB torch included) is downloaded and
# unpacked on the system drive first and then cross-volume *copied* into the
# venv (hardlinks can't cross volumes): the system drive silently needs as
# much space as the whole install and fills up even though the user pointed
# the install at another drive precisely because C: was tight (Discord
# report, tarbol6457 — same class as the Tauri bootstrap fix in
# frontend/src-tauri/src/setup.rs::uv_env_overrides_for).


def _nearest_existing(path: Path) -> Path:
    """Deepest existing ancestor of *path* (the target may not exist yet)."""
    p = Path(path).absolute()
    while not p.exists():
        parent = p.parent
        if parent == p:
            break
        p = parent
    return p


def _same_volume(a: Path, b: Path) -> bool:
    """True when *a* and *b* live on the same filesystem/volume.

    Windows drive letters, POSIX mount points, and not-yet-created targets
    (compared via their nearest existing ancestor) are all handled by
    ``st_dev``. Errs on ``True`` (→ no env override) when it can't tell, so a
    probe failure can never change behavior for default installs.
    """
    try:
        return os.stat(_nearest_existing(a)).st_dev == os.stat(_nearest_existing(b)).st_dev
    except OSError:
        return True


def _default_uv_cache_root() -> Path:
    """Volume anchor of uv's default cache (mirrors uv's platform defaults).

    Only the VOLUME matters — the exact subpath never has to match uv's."""
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "uv"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "uv"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "uv"


def uv_subprocess_env(cache_parent: Path) -> "dict[str, str] | None":
    """Environment for ``uv`` subprocesses that install into *cache_parent*'s volume.

    Returns ``None`` (inherit the parent environment untouched) when uv's
    default cache already shares a volume with *cache_parent* or the user
    pinned both variables themselves. Otherwise returns a copy of
    ``os.environ`` with the *unset* one(s) of ``UV_CACHE_DIR`` /
    ``UV_PYTHON_INSTALL_DIR`` placed inside *cache_parent*, so downloads, the
    unpacked wheel cache, managed Pythons, and the venv all stay on the
    target volume — and same-volume hardlink installs work again. The two
    variables are independent (mirrors ``uv_env_overrides_for`` in
    ``frontend/src-tauri/src/setup.rs``): a user-pinned value is never
    overridden, but pinning one must not leave the other's multi-GB state on
    the system drive.

    Canonical helper for every sidecar/engine bootstrap (like ``_locate_uv``):
    pass the directory that should hold the shared ``.uv-cache`` — typically
    the common parent of the engine venvs on that volume.
    """
    if _same_volume(cache_parent, _default_uv_cache_root()):
        return None
    env = dict(os.environ)
    overrode = False
    if not env.get("UV_CACHE_DIR"):  # explicit user choice always wins
        env["UV_CACHE_DIR"] = str(Path(cache_parent) / ".uv-cache")
        overrode = True
    if not env.get("UV_PYTHON_INSTALL_DIR"):
        env["UV_PYTHON_INSTALL_DIR"] = str(Path(cache_parent) / ".uv-python")
        overrode = True
    return env if overrode else None


# ── Disk preflight ─────────────────────────────────────────────────────────


def _dir_size_bytes(path: Path) -> int:
    """Best-effort recursive size (bytes already spent by a partial install)."""
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    continue
    except OSError:
        pass  # unreadable dir — treat as zero bytes spent
    return total


def _preserved_install_bytes(spec: SidecarSpec, checkout: Path) -> tuple[int, int]:
    """Return bytes preserved for the final install and dependency peak.

    Resumable weights reduce the final download requirement, but they do not
    reduce uv's separate environment-build peak. Only source and a usable
    existing venv count against that peak.
    """
    if not _source_present(spec, checkout):
        return 0, 0

    weights_dir = checkout / spec.weights_subdir
    weights = _dir_size_bytes(weights_dir) if spec.weights_repo_id else 0
    venv_dir = checkout / ".venv"
    venv = _dir_size_bytes(venv_dir)
    source = max(0, _dir_size_bytes(checkout) - weights - venv)
    usable_venv = venv if _venv_python(venv_dir).is_file() else 0
    return source + usable_venv + weights, source + usable_venv


def disk_free_bytes(path: Path) -> int:
    """Free bytes on the volume backing *path* (nearest existing ancestor).
    Never raises; 0 when the volume can't be probed."""
    try:
        p = path.resolve()
        while not p.exists():
            parent = p.parent
            if parent == p:
                break
            p = parent
        return int(shutil.disk_usage(str(p)).free)
    except Exception:
        return 0


def disk_space_error(spec: SidecarSpec) -> Optional[str]:
    """Actionable message when the estimated remaining install won't fit
    (needs X + headroom Y, have Z — same shape as the model-install guard);
    ``None`` when it fits or the volume can't be probed."""
    root = managed_root(spec)
    # A preserved predecessor is not a partial copy of the new install: the
    # upgrade needs its full space until the new sidecar is verified.
    checkout = managed_checkout(spec)
    # Credit only bytes the later steps preserve. An invalid layout or revision
    # marker makes _step_fetch_source delete the whole checkout.
    preserved, dependency_peak_credit = _preserved_install_bytes(spec, checkout)
    remaining = max(0, spec.required_bytes - preserved)
    if spec.temporary_free_bytes is not None:
        # Resumable model weights are unrelated to uv's dependency-build peak.
        remaining = max(
            remaining,
            max(0, spec.temporary_free_bytes - dependency_peak_credit),
        )
    free = disk_free_bytes(root)
    if free <= 0:
        return None  # can't probe → never block on missing information
    required = remaining + MIN_FREE_GB * _GIB
    if free >= required:
        return None

    def _gb(n: int) -> str:
        return f"{n / _GIB:.1f} GB"

    return (
        f"Not enough disk space to install {spec.display_name}: it needs about "
        f"{_gb(remaining)} plus {MIN_FREE_GB} GB free headroom ({_gb(required)} total), "
        f"but only {_gb(free)} is free at {root}. Free up space and retry."
    )


# ── Job state ──────────────────────────────────────────────────────────────

STEP_IDS = (
    "preflight",
    "fetch_source",
    "create_venv",
    "install_deps",
    "verify",
    "fetch_weights",
    "persist",
)

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()

# Guards each job's log deque: the worker thread appends while the status
# poll copies it, and list() over a deque raises RuntimeError if it mutates
# mid-iteration. One module-level lock is plenty — appends are tiny and at
# most one job runs per engine.
_log_lock = threading.Lock()


class _StepError(Exception):
    """Install-step failure carrying user-facing remediation text."""

    def __init__(self, message: str, remediation: str):
        super().__init__(message)
        self.remediation = remediation


def _new_job(engine_id: str) -> dict:
    return {
        "engine_id": engine_id,
        "state": "running",
        "steps": [{"id": s, "state": "pending", "detail": None} for s in STEP_IDS],
        "log": deque(maxlen=_LOG_MAX_LINES),
        "error": None,
        "remediation": None,
        "weights_progress": None,
        "started_at": time.time(),
        "finished_at": None,
    }


def _job_step(job: dict, step_id: str) -> dict:
    return next(s for s in job["steps"] if s["id"] == step_id)


def _log(job: dict, line: str) -> None:
    line = line.rstrip()
    if line:
        with _log_lock:
            job["log"].append(line)
        logger.info("[%s install] %s", job["engine_id"], line)


def _serialize_job(job: Optional[dict]) -> Optional[dict]:
    if job is None:
        return None
    out = dict(job)
    with _log_lock:
        out["log"] = list(job["log"])
    out["steps"] = [dict(s) for s in job["steps"]]
    return out


def get_status(engine_id: str) -> dict:
    """Install state + last/current job for one engine. Cheap (file probes)."""
    spec = get_spec(engine_id)
    if spec is None:
        raise KeyError(engine_id)
    with _jobs_lock:
        job = _serialize_job(_jobs.get(engine_id))
    installed = _healthy(spec)
    checkout = managed_checkout(spec)
    env_dir = os.environ.get(spec.env_var)
    return {
        "engine_id": engine_id,
        "installed": installed,
        # True when the on-disk install is the app-managed one (uninstallable
        # from the app). A user's own clone is never "managed".
        "managed": bool(
            (checkout.is_dir() and (not env_dir or Path(env_dir) == checkout))
            or (env_dir and Path(env_dir) in _legacy_managed_checkouts(spec))
        ),
        "install_dir": env_dir or (str(checkout) if checkout.is_dir() else None),
        "job": job,
    }


def _safe_installed(spec: SidecarSpec) -> bool:
    try:
        return bool(spec.installed_probe())
    except Exception:
        return False


def _user_managed_dir(spec: SidecarSpec) -> Optional[Path]:
    """The user's own install dir when the env var points anywhere but the
    app-managed checkout; None for managed/unset (ours to provision)."""
    env_dir = os.environ.get(spec.env_var)
    managed_paths = (managed_checkout(spec), *_legacy_managed_checkouts(spec))
    if env_dir and Path(env_dir) not in managed_paths:
        return Path(env_dir)
    return None


def _healthy(spec: SidecarSpec) -> bool:
    """A COMPLETE install: for a user-managed dir, trust the engine's own
    probe (their clone, their layout); for the app-managed install require
    the venv AND the fully-downloaded weights, so a partial install repairs
    instead of reporting already_installed."""
    if _user_managed_dir(spec) is not None:
        return _safe_installed(spec)
    checkout = managed_checkout(spec)
    if not checkout.is_dir():
        # A working app-managed predecessor stays available to the engine,
        # but the install endpoint must still offer the reviewed 2.5 upgrade.
        env_dir = os.environ.get(spec.env_var)
        if env_dir and Path(env_dir) in _legacy_managed_checkouts(spec):
            return False
        # No managed install at all. A legacy install may still exist (e.g.
        # IndexTTS's old lazy-bootstrap venv under backend/engines/) — trust
        # the engine's own probe so we never re-provision over a working one.
        return _safe_installed(spec)
    if not _source_present(spec, checkout):
        return False
    if not _venv_python(checkout / ".venv").is_file():
        return False
    if spec.weights_repo_id and not _weights_present(spec):
        return False
    return True


def _persist(spec: SidecarSpec) -> None:
    """Point the engine at the managed checkout: process env for immediate
    use, prefs.json ``env.*`` for the next launch, and invalidate the
    engine's memoised venv resolution so it re-probes without a restart."""
    checkout = managed_checkout(spec)
    os.environ[spec.env_var] = str(checkout)
    from core import prefs
    prefs.set_(f"env.{spec.env_var}", str(checkout))
    try:
        spec.invalidate()
    except Exception:
        pass  # best-effort cache invalidation — the env var is already set


def start_install(engine_id: str) -> dict:
    """Start (or report) the install job for *engine_id*.

    Returns ``{"status": "started"|"already_running"|"already_installed", ...}``.
    Raises KeyError for an engine with no sidecar spec.
    """
    spec = get_spec(engine_id)
    if spec is None:
        raise KeyError(engine_id)
    with _jobs_lock:
        existing = _jobs.get(engine_id)
        if existing and existing["state"] == "running":
            return {"status": "already_running", "engine": engine_id}
        # A healthy install (user-managed or app-managed) never reinstalls;
        # a PARTIAL managed install falls through so the job repairs it.
        if _healthy(spec):
            # Self-heal: a healthy MANAGED install whose env var was lost
            # (e.g. prefs.json wiped) just needs re-pointing, not a reinstall.
            if (
                _user_managed_dir(spec) is None
                and _venv_python(managed_checkout(spec) / ".venv").is_file()
                and not _safe_installed(spec)
            ):
                _persist(spec)
            return {"status": "already_installed", "engine": engine_id}
        job = _new_job(engine_id)
        _jobs[engine_id] = job
    th = threading.Thread(
        target=_run_install, args=(spec, job),
        name=f"sidecar-install-{engine_id}", daemon=True,
    )
    th.start()
    return {"status": "started", "engine": engine_id}


def uninstall(engine_id: str) -> dict:
    """Remove the app-managed install and clear the persisted path.

    Refuses to touch a user-managed install (env var pointing anywhere but
    the managed checkout) — those were never ours to delete.
    """
    spec = get_spec(engine_id)
    if spec is None:
        raise KeyError(engine_id)
    with _jobs_lock:
        job = _jobs.get(engine_id)
        if job and job["state"] == "running":
            return {"status": "install_in_progress", "engine": engine_id}
    env_dir = os.environ.get(spec.env_var)
    checkout = managed_checkout(spec)
    managed_paths = (checkout, *_legacy_managed_checkouts(spec))
    if env_dir and Path(env_dir) not in managed_paths:
        return {
            "status": "not_managed",
            "engine": engine_id,
            "detail": (
                f"{spec.display_name} points at {env_dir}, which VoiceStudio did not "
                f"install. Remove that directory yourself if you want it gone, or "
                f"clear {spec.env_var} in Settings."
            ),
        }
    root = managed_root(spec)
    removed = root.is_dir()
    shutil.rmtree(root, ignore_errors=True)
    if env_dir:  # only ever the managed checkout at this point
        os.environ.pop(spec.env_var, None)
    from core import prefs
    if prefs.get(f"env.{spec.env_var}") in {str(path) for path in managed_paths}:
        prefs.delete(f"env.{spec.env_var}")
    try:
        spec.invalidate()
    except Exception:
        pass  # best-effort cache invalidation — uninstall already succeeded
    with _jobs_lock:
        _jobs.pop(engine_id, None)
    return {"status": "uninstalled" if removed else "not_installed", "engine": engine_id}


# ── Worker ─────────────────────────────────────────────────────────────────


def _run_install(spec: SidecarSpec, job: dict) -> None:
    step_fns: list[tuple[str, Callable[[SidecarSpec, dict], None]]] = [
        ("preflight", _step_preflight),
        ("fetch_source", _step_fetch_source),
        ("create_venv", _step_create_venv),
        ("install_deps", _step_install_deps),
        ("verify", _step_verify),
        ("fetch_weights", _step_fetch_weights),
        ("persist", _step_persist),
    ]
    try:
        for step_id, fn in step_fns:
            step = _job_step(job, step_id)
            step["state"] = "running"
            try:
                fn(spec, job)
            except _StepError:
                step["state"] = "error"
                raise
            except Exception as exc:  # noqa: BLE001 — surfaced into the job
                step["state"] = "error"
                raise _StepError(
                    f"{type(exc).__name__}: {exc}",
                    "Re-run the install — it resumes from where it stopped. If it "
                    f"keeps failing, see {spec.docs_path} for the manual steps.",
                ) from exc
            if step["state"] == "running":
                step["state"] = "done"
        job["state"] = "succeeded"
        _log(job, f"{spec.display_name} installed successfully.")
    except _StepError as exc:
        job["state"] = "failed"
        job["error"] = str(exc)
        job["remediation"] = exc.remediation
        _log(job, f"FAILED: {exc}")
    finally:
        job["finished_at"] = time.time()


def _step_preflight(spec: SidecarSpec, job: dict) -> None:
    if _locate_uv() is None:
        raise _StepError(
            "uv was not found (checked the bundled path via OMNIVOICE_BUNDLED_UV, "
            "then PATH).",
            "Install uv from https://docs.astral.sh/uv/ and relaunch VoiceStudio, or "
            "set OMNIVOICE_BUNDLED_UV to the absolute path of a uv binary.",
        )
    err = disk_space_error(spec)
    if err:
        raise _StepError(err, "Free up disk space (or move VoiceStudio's data directory "
                              "to a larger volume) and retry.")
    managed_root(spec).mkdir(parents=True, exist_ok=True)
    _job_step(job, "preflight")["detail"] = "uv found, disk space OK"
    _log(job, "Preflight OK — uv resolved and enough free disk space.")


def _step_fetch_source(spec: SidecarSpec, job: dict) -> None:
    step = _job_step(job, "fetch_source")
    checkout = managed_checkout(spec)
    if _source_present(spec, checkout):
        step["state"] = "done"
        step["detail"] = "source already present"
        _log(job, f"Source already present at {checkout} — skipping fetch.")
        return
    if checkout.exists():
        # Half-fetched checkout — repair by refetching. Superseded managed
        # generations live at a different path and remain usable until this
        # replacement has completed successfully.
        _log(job, f"Removing incomplete or outdated checkout at {checkout} …")
        shutil.rmtree(checkout, ignore_errors=True)

    git = shutil.which("git")
    if git:
        _log(job, f"Cloning {spec.repo_url} (git, depth 1) …")
        clone_argv = [git, "clone", "--depth", "1"]
        if spec.repo_ref:
            clone_argv.extend(["--branch", spec.repo_ref])
        clone_argv.extend([spec.repo_url, str(checkout)])
        rc = _run_logged(job, clone_argv, timeout=_GIT_CLONE_TIMEOUT_S)
        if rc == 0 and spec.source_revision:
            rc = _run_logged(
                job,
                [git, "-C", str(checkout), "checkout", "--detach", spec.source_revision],
                timeout=_GIT_CLONE_TIMEOUT_S,
            )
        if rc == 0 and _source_layout_ok(spec, checkout):
            _write_source_marker(spec, checkout)
            step["detail"] = "git clone"
            return
        _log(job, f"git clone failed (exit {rc}) — falling back to source tarball.")
        shutil.rmtree(checkout, ignore_errors=True)
    else:
        _log(job, "git not found — using the source-tarball fallback.")

    _fetch_tarball(spec, job, checkout)
    if not _source_layout_ok(spec, checkout):
        raise _StepError(
            f"Fetched source at {checkout} has no pyproject.toml — the download "
            "appears incomplete or the upstream layout changed.",
            "Re-run the install; if it keeps failing, clone the repository "
            f"manually and set {spec.env_var} to the clone (see the engine docs).",
        )
    _write_source_marker(spec, checkout)
    step["detail"] = "source tarball"


_SOURCE_REVISION_MARKER = ".voicestudio_source_revision"


def _source_layout_ok(spec: SidecarSpec, checkout: Path) -> bool:
    if not (checkout / "pyproject.toml").is_file():
        return False
    return not spec.source_required_path or (checkout / spec.source_required_path).is_file()


def _write_source_marker(spec: SidecarSpec, checkout: Path) -> None:
    if spec.source_revision:
        (checkout / _SOURCE_REVISION_MARKER).write_text(
            f"{spec.source_revision}\n", encoding="utf-8",
        )


def _source_present(spec: SidecarSpec, checkout: Path) -> bool:
    if not _source_layout_ok(spec, checkout):
        return False
    if not spec.source_revision:
        return True
    try:
        marker = (checkout / _SOURCE_REVISION_MARKER).read_text(encoding="utf-8").strip()
    except OSError:
        return False
    return marker == spec.source_revision


def _fetch_tarball(spec: SidecarSpec, job: dict, checkout: Path) -> None:
    """Download + extract the GitHub source tarball (no git required).

    Extraction is member-validated (no absolute paths / parent escapes) and
    never uses symlinks, so it behaves identically on Windows.
    """
    import httpx

    root = managed_root(spec)
    root.mkdir(parents=True, exist_ok=True)
    _log(job, f"Downloading {spec.tarball_url} …")
    fd, tmp_tar = tempfile.mkstemp(suffix=".tar.gz", dir=str(root))
    try:
        with os.fdopen(fd, "wb") as out:
            with httpx.stream(
                "GET", spec.tarball_url, follow_redirects=True,
                timeout=_TARBALL_TIMEOUT_S,
            ) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_bytes():
                    out.write(chunk)
        _log(job, "Extracting source tarball …")
        with tempfile.TemporaryDirectory(dir=str(root)) as tmp_dir:
            with tarfile.open(tmp_tar, "r:gz") as tf:
                try:
                    tf.extractall(tmp_dir, filter="data")  # stdlib safe-extract (3.11.4+)
                except TypeError:  # pragma: no cover — pre-filter= interpreters
                    _safe_extract_members(tf, tmp_dir)
            entries = [p for p in Path(tmp_dir).iterdir() if p.is_dir()]
            if len(entries) != 1:
                raise _StepError(
                    f"Unexpected tarball layout ({len(entries)} top-level dirs).",
                    "Re-run the install; if it keeps failing, clone the repository "
                    f"manually and set {spec.env_var} (see the engine docs).",
                )
            # os.replace-style move keeps this atomic-ish on the same volume.
            shutil.move(str(entries[0]), str(checkout))
    finally:
        try:
            os.unlink(tmp_tar)
        except OSError:
            pass  # temp tarball already gone / locked — harmless leftover


def _safe_extract_members(tf: "tarfile.TarFile", dest: str) -> None:
    """Tar-slip-guarded extraction for interpreters without
    ``extractall(filter="data")`` (Python < 3.11.4).

    Mirrors what the "data" filter enforces: only regular files and
    directories (no symlinks/hardlinks/devices — also keeps Windows
    behaviour identical), no absolute paths, and every resolved target must
    stay inside *dest*.
    """
    dest_abs = os.path.abspath(dest)
    for member in tf.getmembers():
        if not (member.isreg() or member.isdir()):
            continue  # drop symlinks/hardlinks/devices/fifos
        name = member.name
        if name.startswith(("/", "\\")) or ".." in name.replace("\\", "/").split("/"):
            continue  # absolute path or parent-dir escape
        target = os.path.abspath(os.path.join(dest, name))
        if os.path.commonpath([dest_abs, target]) != dest_abs:
            continue  # resolved outside the extraction dir
        tf.extract(member, dest)


def _step_create_venv(spec: SidecarSpec, job: dict) -> None:
    step = _job_step(job, "create_venv")
    checkout = managed_checkout(spec)
    venv_dir = checkout / ".venv"
    py = _venv_python(venv_dir)
    if py.is_file():
        step["state"] = "done"
        step["detail"] = "venv already present"
        _log(job, f"Venv already present at {venv_dir} — skipping.")
        return
    uv = _locate_uv()
    _log(job, f"Creating venv at {venv_dir} …")
    # Keep uv's cache on the engines volume (D:-install class) — see
    # uv_subprocess_env. The cache parent is the shared engines root, so
    # every sidecar engine reuses one cache.
    uv_env = uv_subprocess_env(Path(DATA_DIR) / "engines")
    rc = _run_logged(job, [uv, "venv", str(venv_dir)], timeout=_UV_VENV_TIMEOUT_S,
                     env=uv_env)
    if rc != 0 or not py.is_file():
        raise _StepError(
            f"uv venv failed (exit {rc}) at {venv_dir}.",
            "Check the log above for the uv error; free disk space or fix "
            "permissions on the data directory, then re-run the install.",
        )
    step["detail"] = "venv created"


def _step_install_deps(spec: SidecarSpec, job: dict) -> None:
    """`uv pip install -e <checkout>` into the dedicated venv.

    Deliberately NOT `uv sync` — sync would apply the sidecar's lockfile
    semantics; `uv pip install -e` resolves the sidecar's own pins
    (e.g. transformers<5) inside ITS venv, never touching the parent app.
    Idempotent: re-running repairs a partial dependency set.
    """
    checkout = managed_checkout(spec)
    py = _venv_python(checkout / ".venv")
    uv = _locate_uv()
    _log(job, f"Installing {spec.display_name} into its venv (this can take several minutes) …")
    rc = _run_logged(
        job,
        [uv, "pip", "install", "--python", str(py), "-e", str(checkout)],
        timeout=_UV_PIP_INSTALL_TIMEOUT_S,
        env=uv_subprocess_env(Path(DATA_DIR) / "engines"),
    )
    if rc != 0:
        raise _StepError(
            f"uv pip install -e failed (exit {rc}).",
            "Usually a network hiccup — re-run the install to resume. Behind a "
            "proxy, set HTTPS_PROXY in Settings → Environment first.",
        )
    _job_step(job, "install_deps")["detail"] = "dependencies installed"


def _step_verify(spec: SidecarSpec, job: dict) -> None:
    checkout = managed_checkout(spec)
    py = _venv_python(checkout / ".venv")
    _log(job, f"Verifying `import {spec.probe_module}` inside the venv …")
    try:
        proc = subprocess.run(
            [str(py), "-c", f"import {spec.probe_module}"],
            capture_output=True, timeout=_IMPORT_PROBE_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise _StepError(
            f"Import probe failed to run: {exc}",
            "Re-run the install; if it keeps failing, delete the engine in "
            "Model Catalogue → Engines and install again.",
        ) from exc
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", errors="replace")[-500:]
        raise _StepError(
            f"`import {spec.probe_module}` failed in the new venv: {tail}",
            "Re-run the install — dependency resolution resumes and repairs "
            "partial installs. If it keeps failing, use the manual install in "
            "the engine docs.",
        )
    _job_step(job, "verify")["detail"] = f"import {spec.probe_module} OK"
    _log(job, "Venv verified.")


# Written into the weights dir after snapshot_download COMPLETES. A partial
# multi-shard download can leave a config + several plausible shards on
# disk, so file heuristics alone would declare a killed-mid-download install
# healthy and never resume it (the sidecar edition of #352). Only this
# installer writes the marker; user-managed clones never hit this path.
_WEIGHTS_COMPLETE_MARKER = ".omnivoice_weights_complete"


def _weights_present(spec: SidecarSpec) -> bool:
    """True only for a COMPLETED weights download: the completion marker
    plus a sanity floor (the expected config + one ≥5 MB weight file — the same
    truncated-download floor the model store uses)."""
    wdir = managed_checkout(spec) / spec.weights_subdir
    try:
        marker = (wdir / _WEIGHTS_COMPLETE_MARKER).read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    expected = [spec.weights_repo_id or "", spec.weights_revision or ""]
    actual = marker[:2] if len(marker) >= 2 else marker + [""]
    if actual != expected:
        return False
    return _weights_floor_ok(wdir, config_names=spec.weights_config_names)


def _weights_floor_ok(wdir: Path, *, config_names: tuple[str, ...] = ("config.yaml",)) -> bool:
    if not any((wdir / name).is_file() for name in config_names):
        return False
    floor = 5 * 1024 * 1024
    try:
        for root, _dirs, files in os.walk(wdir):
            for f in files:
                try:
                    if os.path.getsize(os.path.join(root, f)) >= floor:
                        return True
                except OSError:
                    continue
    except OSError:
        pass  # unreadable weights dir — treat as not present
    return False


def _step_fetch_weights(spec: SidecarSpec, job: dict) -> None:
    step = _job_step(job, "fetch_weights")
    if not spec.weights_repo_id:
        step["state"] = "skipped"
        step["detail"] = "engine has no bundled-weights requirement"
        return
    if _weights_present(spec):
        step["state"] = "done"
        step["detail"] = "weights already present"
        _log(job, "Model weights already present — skipping download.")
        return

    wdir = managed_checkout(spec) / spec.weights_subdir
    wdir.mkdir(parents=True, exist_ok=True)
    _log(job, f"Downloading {spec.weights_repo_id} → {wdir} (several GB — resumable) …")

    from huggingface_hub import snapshot_download
    from services import endpoint_race
    from services.token_resolver import resolve as resolve_token
    from utils import hf_progress

    # Mirror per-file byte progress into the job so the polling UI can show
    # it — same tqdm hook the model store's SSE feed uses.
    def _listener(ev: dict) -> None:
        try:
            # Only mirror events for OUR repo — a concurrent model-store
            # download must not scribble its progress into this job.
            if ev.get("repo_id") not in (None, spec.weights_repo_id):
                return
            job["weights_progress"] = {
                "filename": ev.get("filename"),
                "downloaded": ev.get("downloaded"),
                "total": ev.get("total"),
                "pct": ev.get("pct"),
            }
        except Exception:
            pass  # progress mirroring is advisory — never break the download

    listener_id = hf_progress.register_listener(_listener)
    repo_token = hf_progress.current_repo_id.set(spec.weights_repo_id)
    try:
        # Tracks the repo's default branch on purpose (same policy as every
        # other model download in the app — see setup/download.py): the
        # source checkout is unpinned upstream `main` anyway, and hf_hub
        # checksum-verifies each artifact. Hence the B615 waiver below.
        kwargs: dict = {
            "repo_id": spec.weights_repo_id,
            "local_dir": str(wdir),
            "token": resolve_token(),
        }
        if spec.weights_revision:
            kwargs["revision"] = spec.weights_revision
        endpoint = endpoint_race.effective_endpoint()
        if endpoint:
            kwargs["endpoint"] = endpoint
        tqdm_cls = hf_progress.tracked_tqdm_class()
        if tqdm_cls is not None:
            kwargs["tqdm_class"] = tqdm_cls
        try:
            snapshot_download(**kwargs)  # nosec B615 — deliberate default-branch policy, see above
        except Exception as exc:
            raise _StepError(
                f"Model weight download failed: {exc}",
                "Re-run the install — the download resumes where it stopped. "
                "Check Settings → Network (HF endpoint / proxy) if it keeps failing.",
            ) from exc
    finally:
        hf_progress.unregister_listener(listener_id)
        hf_progress.current_repo_id.reset(repo_token)

    if not _weights_floor_ok(wdir, config_names=spec.weights_config_names):
        raise _StepError(
            "Weight download finished but no plausible weight files were found — "
            "the download was likely interrupted.",
            "Re-run the install to resume the download.",
        )
    # snapshot_download returned AND the sanity floor holds → mark complete,
    # so _weights_present/_healthy stop treating this dir as a partial.
    (wdir / _WEIGHTS_COMPLETE_MARKER).write_text(
        f"{spec.weights_repo_id}\n{spec.weights_revision or ''}\n{time.time():.0f}\n",
        encoding="utf-8",
    )
    step["detail"] = "weights downloaded"
    _log(job, "Model weights downloaded.")


def _step_persist(spec: SidecarSpec, job: dict) -> None:
    _persist(spec)
    _job_step(job, "persist")["detail"] = f"{spec.env_var}={managed_checkout(spec)}"
    _log(job, f"Saved {spec.env_var} — the engine is ready to use, no restart needed.")


# ── Subprocess runner with live log capture ────────────────────────────────


def _install_containment_kwargs() -> dict:
    """Nested process-group/Job ownership is supplied by ``spawn_owned``."""
    return {}


def _run_logged(job: dict, argv: list[str], *, timeout: float,
                env: "dict[str, str] | None" = None) -> int:
    """Run *argv*, streaming combined stdout+stderr lines into the job log.

    Returns the exit code; -1 on timeout (process tree killed) or spawn
    failure. argv-list only — never a shell string — so paths with spaces
    are safe on every platform. ``env=None`` inherits the parent environment.

    The stdout drain runs on its own daemon thread and the main flow blocks
    on ``proc.wait(timeout=…)``. That bounds the step even when a grandchild
    (uv resolver worker, git helper) inherits the pipe and outlives the
    killed child — a blocking ``for line in proc.stdout`` on this thread
    would hang past the timeout waiting for pipe EOF.
    """
    # ``spawn_owned`` creates the local timeout group/Job before the operation
    # starts. POSIX links it to backend death through a control pipe; Windows
    # retains a kill-on-close Job handle in this backend process.
    popen_kwargs = _install_containment_kwargs()
    try:
        proc = spawn_owned(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            **popen_kwargs,
        )
    except OSError as exc:
        _log(job, f"failed to spawn {argv[0]}: {exc}")
        return -1

    def _drain() -> None:
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                _log(job, line)
        except (OSError, ValueError):
            pass  # pipe closed by the timeout kill — nothing left to read

    drain = threading.Thread(target=_drain, daemon=True)
    drain.start()
    try:
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        _log(job, f"process timed out after {timeout:.0f}s — killed")
        return -1
    drain.join(5.0)  # give the drain a moment to flush the tail
    return rc if rc is not None else -1


def _kill_tree(proc: "subprocess.Popen") -> None:
    """Kill an operation through its stable nested group/Job owner."""
    if isinstance(proc, (OwnedPopen, WindowsJobPopen)):
        # The retained supervisor/process-group or nested Job is the stable
        # per-operation owner.  Do not fall back to a direct PID kill.
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            return
        return
    # A test double or a legacy caller without the nested owner can only be
    # stopped through its stable direct-process handle.
    try:
        proc.kill()
    except OSError:
        pass  # process already exited


__all__ = [
    "SPECS",
    "SidecarSpec",
    "disk_space_error",
    "get_spec",
    "get_status",
    "managed_checkout",
    "managed_root",
    "persistent_env_vars",
    "start_install",
    "uninstall",
]
