import io
import os
import subprocess
import sys
from pathlib import Path

def test_parent_pipe_eof_exits_cleanly():
    from core.parent_liveness import _watch_parent_pipe

    exits = []
    _watch_parent_pipe(io.BytesIO(b""), exits.append)
    assert exits == [0]


def test_parent_pipe_ignores_bytes_until_eof():
    from core.parent_liveness import _watch_parent_pipe

    exits = []
    _watch_parent_pipe(io.BytesIO(b"keepalive"), exits.append)
    assert exits == [0]


def test_watchdog_is_disabled_outside_desktop(monkeypatch):
    from core.parent_liveness import arm_desktop_parent_watchdog

    monkeypatch.delenv("OMNIVOICE_DESKTOP_CONTAINED", raising=False)
    assert arm_desktop_parent_watchdog() is False


def test_desktop_child_exits_when_parent_closes_stdin():
    env = os.environ.copy()
    env["OMNIVOICE_DESKTOP_CONTAINED"] = "1"
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from core.parent_liveness import arm_desktop_parent_watchdog; "
            "arm_desktop_parent_watchdog(); print('ready', flush=True); "
            "__import__('time').sleep(30)",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=Path(__file__).parents[3] / "backend",
        text=True,
    )
    try:
        assert child.stdout.readline().strip() == "ready"
        child.stdin.close()
        assert child.wait(timeout=3) == 0
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
