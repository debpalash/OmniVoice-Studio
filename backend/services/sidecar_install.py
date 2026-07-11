"""One-click sidecar-engine provisioner (issue: IndexTTS-2 in-app install).

Some engines (IndexTTS-2 today; MOSS-v1.5 / dots.tts / Confucius4 are the
same shape) can't live in the app venv because they pin a ``transformers``
version that conflicts with the parent's ``>=5.3``. They run as sidecars:
a source checkout + a dedicated venv + (for IndexTTS-2) model weights in
``<checkout>/checkpoints/``. Until now provisioning that trio was four
manual terminal steps; this module turns it into a resumable background
job the Settings → Engines UI can start and poll.

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
  from ``<checkout>/<weights_subdir>/`` (IndexTTS-2's ``main.py`` reads
  ``$OMNIVOICE_INDEXTTS_DIR/checkpoints/config.yaml`` — verified). The
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
    weights_repo_id: Optional[str] = None   # HF repo downloaded into <checkout>/<weights_subdir>
    weights_subdir: str = "checkpoints"
    docs_path: str = "docs/engines"         # where the manual-install fallback lives
    required_bytes: int = 12 * _GIB    # conservative source+venv+weights estimate for preflight
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
        display_name="IndexTTS-2",
        repo_url="https://github.com/index-tts/index-tts.git",
        tarball_url="https://github.com/index-tts/index-tts/archive/refs/heads/main.tar.gz",
        checkout_dirname="index-tts",
        env_var="OMNIVOICE_INDEXTTS_DIR",
        probe_module="indextts.infer_v2",
        weights_repo_id="IndexTeam/IndexTTS-2",
        weights_subdir="checkpoints",
        docs_path="docs/engines/indextts.md",
        # ~0.1 GB source + up to ~6 GB venv (torch + transformers<5) +
        # ~6 GB weights. Deliberately conservative; the preflight subtracts
        # whatever a partial install already put on disk.
        required_bytes=12 * _GIB,
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
    already = _dir_size_bytes(root)
    remaining = max(0, spec.required_bytes - already)
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
            checkout.is_dir()
            and (not env_dir or Path(env_dir) == checkout)
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
    if env_dir and Path(env_dir) != managed_checkout(spec):
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
        # No managed install at all. A legacy install may still exist (e.g.
        # IndexTTS's old lazy-bootstrap venv under backend/engines/) — trust
        # the engine's own probe so we never re-provision over a working one.
        return _safe_installed(spec)
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
    if env_dir and Path(env_dir) != checkout:
        return {
            "status": "not_managed",
            "engine": engine_id,
            "detail": (
                f"{spec.display_name} points at {env_dir}, which OmniVoice did not "
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
    if prefs.get(f"env.{spec.env_var}") == str(checkout):
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
            "Install uv from https://docs.astral.sh/uv/ and relaunch OmniVoice, or "
            "set OMNIVOICE_BUNDLED_UV to the absolute path of a uv binary.",
        )
    err = disk_space_error(spec)
    if err:
        raise _StepError(err, "Free up disk space (or move OmniVoice's data directory "
                              "to a larger volume) and retry.")
    managed_root(spec).mkdir(parents=True, exist_ok=True)
    _job_step(job, "preflight")["detail"] = "uv found, disk space OK"
    _log(job, "Preflight OK — uv resolved and enough free disk space.")


def _step_fetch_source(spec: SidecarSpec, job: dict) -> None:
    step = _job_step(job, "fetch_source")
    checkout = managed_checkout(spec)
    if (checkout / "pyproject.toml").is_file():
        step["state"] = "done"
        step["detail"] = "source already present"
        _log(job, f"Source already present at {checkout} — skipping fetch.")
        return
    if checkout.exists():
        # Half-fetched checkout (no pyproject.toml) — repair by refetching.
        _log(job, f"Removing incomplete checkout at {checkout} …")
        shutil.rmtree(checkout, ignore_errors=True)

    git = shutil.which("git")
    if git:
        _log(job, f"Cloning {spec.repo_url} (git, depth 1) …")
        rc = _run_logged(job, [git, "clone", "--depth", "1", spec.repo_url, str(checkout)],
                         timeout=_GIT_CLONE_TIMEOUT_S)
        if rc == 0 and (checkout / "pyproject.toml").is_file():
            step["detail"] = "git clone"
            return
        _log(job, f"git clone failed (exit {rc}) — falling back to source tarball.")
        shutil.rmtree(checkout, ignore_errors=True)
    else:
        _log(job, "git not found — using the source-tarball fallback.")

    _fetch_tarball(spec, job, checkout)
    if not (checkout / "pyproject.toml").is_file():
        raise _StepError(
            f"Fetched source at {checkout} has no pyproject.toml — the download "
            "appears incomplete or the upstream layout changed.",
            "Re-run the install; if it keeps failing, clone the repository "
            f"manually and set {spec.env_var} to the clone (see the engine docs).",
        )
    step["detail"] = "source tarball"


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
    rc = _run_logged(job, [uv, "venv", str(venv_dir)], timeout=_UV_VENV_TIMEOUT_S)
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
            "Settings → Engines and install again.",
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
# multi-shard download can leave config.yaml + several plausible shards on
# disk, so file heuristics alone would declare a killed-mid-download install
# healthy and never resume it (the sidecar edition of #352). Only this
# installer writes the marker; user-managed clones never hit this path.
_WEIGHTS_COMPLETE_MARKER = ".omnivoice_weights_complete"


def _weights_present(spec: SidecarSpec) -> bool:
    """True only for a COMPLETED weights download: the completion marker
    plus a sanity floor (config.yaml + one ≥5 MB weight file — the same
    truncated-download floor the model store uses)."""
    wdir = managed_checkout(spec) / spec.weights_subdir
    if not (wdir / _WEIGHTS_COMPLETE_MARKER).is_file():
        return False
    return _weights_floor_ok(wdir)


def _weights_floor_ok(wdir: Path) -> bool:
    if not (wdir / "config.yaml").is_file():
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

    if not _weights_floor_ok(wdir):
        raise _StepError(
            "Weight download finished but no plausible weight files were found — "
            "the download was likely interrupted.",
            "Re-run the install to resume the download.",
        )
    # snapshot_download returned AND the sanity floor holds → mark complete,
    # so _weights_present/_healthy stop treating this dir as a partial.
    (wdir / _WEIGHTS_COMPLETE_MARKER).write_text(
        f"{spec.weights_repo_id}\n{time.time():.0f}\n", encoding="utf-8",
    )
    step["detail"] = "weights downloaded"
    _log(job, "Model weights downloaded.")


def _step_persist(spec: SidecarSpec, job: dict) -> None:
    _persist(spec)
    _job_step(job, "persist")["detail"] = f"{spec.env_var}={managed_checkout(spec)}"
    _log(job, f"Saved {spec.env_var} — the engine is ready to use, no restart needed.")


# ── Subprocess runner with live log capture ────────────────────────────────


def _run_logged(job: dict, argv: list[str], *, timeout: float) -> int:
    """Run *argv*, streaming combined stdout+stderr lines into the job log.

    Returns the exit code; -1 on timeout (process tree killed) or spawn
    failure. argv-list only — never a shell string — so paths with spaces
    are safe on every platform.

    The stdout drain runs on its own daemon thread and the main flow blocks
    on ``proc.wait(timeout=…)``. That bounds the step even when a grandchild
    (uv resolver worker, git helper) inherits the pipe and outlives the
    killed child — a blocking ``for line in proc.stdout`` on this thread
    would hang past the timeout waiting for pipe EOF.
    """
    popen_kwargs: dict = {}
    if os.name == "posix":
        # New session → we can kill the whole process group on timeout
        # instead of only the direct child.
        popen_kwargs["start_new_session"] = True
    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
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
    """Kill the child and its whole process tree, on every platform.

    POSIX: the child was started in its own session, so SIGKILL the group.
    Windows: ``proc.kill()`` only terminates the direct child — a git/uv
    helper it spawned would keep running (and writing into the checkout)
    past our timeout — so use ``taskkill /T`` to fell the tree.
    """
    if os.name == "posix":
        import signal
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            return
        except (ProcessLookupError, PermissionError, OSError):
            pass  # group already gone / not ours — fall through to plain kill
    else:  # Windows
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True, timeout=15,
            )
            return
        except (OSError, subprocess.SubprocessError):
            pass  # taskkill unavailable/failed — fall through to plain kill
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
