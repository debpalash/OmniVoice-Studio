"""L5 env/first-run layer — boot the app in a fresh environment and capture the
signals the judges verify.

The core value OmniVoice is built around is "a first-run that actually works".
This layer tests exactly that: point the backend at an empty data dir, boot it,
and confirm it reaches health, initializes its database, and answers the
lowest-cost endpoints — the path a brand-new user hits.

The boot runs **in a subprocess** (``_boot_runner.py``) so it never mutates the
parent test session. Booting in-process would require purging and re-importing
the backend (``core.config`` caches DB_PATH at import), which corrupts state for
every other test in the suite. A subprocess is both safe and more faithful to a
real first run — a fresh process against a fresh data dir.

Docker / live-container boot is gated behind :func:`docker_available` and skips
cleanly where no daemon is present.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BOOT_RUNNER = Path(__file__).resolve().parent / "_boot_runner.py"


@contextlib.contextmanager
def fresh_data_dir(tmp_path: str | os.PathLike | None = None):
    """Yield a brand-new, empty OMNIVOICE_DATA_DIR (true first-run state)."""
    created = None
    if tmp_path is None:
        created = tempfile.mkdtemp(prefix="probe-firstrun-")
        target = created
    else:
        target = str(tmp_path)
        os.makedirs(target, exist_ok=True)
    try:
        yield Path(target)
    finally:
        if created:
            import shutil

            shutil.rmtree(created, ignore_errors=True)


def capture_first_run(data_dir: str | os.PathLike, timeout: float = 180.0) -> dict:
    """Boot the backend against ``data_dir`` in a subprocess and return the
    captured first-run context (endpoint status/body/latency + on-disk
    artifacts). Raises RuntimeError if the boot fails or times out.

    The parent process's modules and environment are left completely untouched.
    """
    fd, out_path = tempfile.mkstemp(suffix=".json", prefix="probe-capture-")
    os.close(fd)
    child_env = dict(os.environ)
    child_env.update(
        OMNIVOICE_MODEL="test",
        OMNIVOICE_DISABLE_FILE_LOG="1",
        OMNIVOICE_DATA_DIR=str(data_dir),
    )
    try:
        proc = subprocess.run(
            [sys.executable, str(_BOOT_RUNNER), str(data_dir), out_path],
            cwd=str(_REPO_ROOT),
            env=child_env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"first-run boot subprocess failed (rc={proc.returncode}):\n"
                + (proc.stderr or "")[-2000:]
            )
        with open(out_path, encoding="utf-8") as fh:
            return json.load(fh)
    finally:
        with contextlib.suppress(OSError):
            os.remove(out_path)


# ── optional runtimes (skip cleanly when absent) ────────────────────────────────


def docker_available() -> bool:
    """True only if a Docker CLI *and* a responsive daemon are present."""
    import shutil

    if shutil.which("docker") is None:
        return False
    try:
        return (
            subprocess.run(["docker", "info"], capture_output=True, timeout=10).returncode == 0
        )
    except Exception:  # noqa: BLE001
        return False


def compose_file() -> Path:
    """Path to the project's docker-compose (the L5 Docker Actor target)."""
    return _REPO_ROOT / "deploy" / "docker-compose.yml"
