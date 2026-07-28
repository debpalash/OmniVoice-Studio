"""A retry that trusts a lying exit code is not a retry.

On 2026-07-28 the chocolatey community feed returned 503. `choco install
ffmpeg` printed "Unable to find package 'ffmpeg'" and "installed 0/0 packages"
— then exited **0**. The retry loop added on 2026-07-20 was written as
`choco install ... && break`, so it broke out on the first attempt, no backoff
ran, and the job died one line later on `ffmpeg: command not found`.

This runs the real loop body from ci.yml against a stubbed `choco` that
reproduces that behaviour, so the guard is pinned to what actually happened
rather than to what the exit code claimed.
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys

import pytest
import yaml

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="the step is bash; exercised here on POSIX"
)

_WORKFLOW = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".github", "workflows", "ci.yml",
)
_STEP = "System deps (Windows)"


def _step_script():
    with open(_WORKFLOW, encoding="utf-8") as fh:
        wf = yaml.safe_load(fh)
    for job in wf["jobs"].values():
        for step in job.get("steps", []):
            if step.get("name") == _STEP:
                return step["run"]
    raise AssertionError(f"step {_STEP!r} not found in ci.yml")


def _run(tmp_path, *, choco_exit, succeed_on_attempt=None):
    """Run the step with stub `choco`/`ffmpeg`/`sleep` on PATH.

    `succeed_on_attempt` is the 1-based attempt on which choco finally puts
    ffmpeg on PATH; None means it never does.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    counter = tmp_path / "attempts"
    ffmpeg_path = bin_dir / "ffmpeg"

    # ffmpeg must be genuinely ABSENT from PATH until a "successful" install
    # creates it — `command -v` tests existence, so a stub that merely exits
    # 127 would look installed and the retry would never be exercised.
    (bin_dir / "choco").write_text(
        "#!/usr/bin/env bash\n"
        f"n=$(cat {str(counter)!r} 2>/dev/null || echo 0); n=$((n+1));"
        f" echo $n > {str(counter)!r}\n"
        + (
            f'if [ "$n" -ge {succeed_on_attempt} ]; then\n'
            f"  printf '%s\\n' '#!/usr/bin/env bash'"
            f" \"echo 'ffmpeg version 8.1.2'\" > {str(ffmpeg_path)!r}\n"
            f"  chmod +x {str(ffmpeg_path)!r}\n"
            f"fi\n"
            if succeed_on_attempt
            else ""
        )
        + 'echo "Chocolatey installed 0/0 packages."\n'
        f"exit {choco_exit}\n"
    )
    # Keep the backoff from actually sleeping 90s in the test.
    (bin_dir / "sleep").write_text("#!/usr/bin/env bash\nexit 0\n")
    for name in ("choco", "sleep"):
        p = bin_dir / name
        p.chmod(p.stat().st_mode | stat.S_IEXEC)

    script = tmp_path / "step.sh"
    script.write_text(_step_script())
    # A minimal PATH on purpose: inheriting the dev machine's would let a real
    # /opt/homebrew/bin/ffmpeg satisfy `command -v` and silently neuter every
    # assertion here. The stub dir plus the base system dirs is all the step
    # needs (`cat`, and bash builtins for the rest).
    env = dict(os.environ, PATH=f"{bin_dir}:/usr/bin:/bin")
    proc = subprocess.run(
        [shutil.which("bash") or "/bin/bash", str(script)],
        capture_output=True, text=True, env=env, timeout=120,
    )
    attempts = int(counter.read_text().strip()) if counter.exists() else 0
    return proc, attempts


def test_retries_when_choco_lies_about_success(tmp_path):
    """The 2026-07-28 regression: exit 0, nothing installed, no retry."""
    proc, attempts = _run(tmp_path, choco_exit=0, succeed_on_attempt=2)
    assert attempts >= 2, (
        "choco exited 0 without installing ffmpeg and the loop moved on — "
        "the retry must test whether ffmpeg exists, not what choco returned"
    )
    assert proc.returncode == 0, proc.stderr


def test_retries_on_a_normal_nonzero_failure(tmp_path):
    proc, attempts = _run(tmp_path, choco_exit=1, succeed_on_attempt=3)
    assert attempts >= 3
    assert proc.returncode == 0, proc.stderr


def test_gives_up_loudly_when_ffmpeg_never_arrives(tmp_path):
    """Exhausting the retries must fail the job — a silent pass would push a
    broken toolchain into the test run."""
    proc, attempts = _run(tmp_path, choco_exit=0, succeed_on_attempt=None)
    assert attempts == 3
    assert proc.returncode != 0


def test_does_not_retry_when_the_first_attempt_works(tmp_path):
    """Backoff is 30s+60s; burning it when nothing is wrong is its own bug."""
    proc, attempts = _run(tmp_path, choco_exit=0, succeed_on_attempt=1)
    assert attempts == 1
    assert proc.returncode == 0, proc.stderr
