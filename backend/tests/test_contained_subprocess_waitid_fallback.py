"""macOS fallback for the os.waitid probe (#1656).

CPython on macOS does not expose os.waitid, so OwnedPopen's WNOWAIT dance
crashed with AttributeError on every poll after the first spawn. These tests
simulate that platform (monkeypatch os.waitid away) and pin the fallback:
poll/wait/kill must work, exit codes must be real, and an already-reaped
leader must be refused (ChildProcessError path), never signalled blind.
"""
import os
import subprocess
import sys
import time

import pytest

from core import contained_subprocess as owned


def _make_owned(argv):
    cr, cw = os.pipe()
    rr, rw = os.pipe()
    proc = subprocess.Popen(argv, start_new_session=True)
    os.close(cw)
    os.close(rw)  # result writer gone: _read_result falls back to wrapper rc
    return owned.OwnedPopen(proc, cr, rr), proc


@pytest.fixture()
def no_waitid(monkeypatch):
    monkeypatch.delattr(os, "waitid", raising=False)


def test_poll_running_then_exited_without_waitid(no_waitid):
    h, _ = _make_owned([sys.executable, "-c", "import time; time.sleep(1.5)"])
    try:
        assert h.poll() is None, "running child must poll None"
        h._proc.wait()
        deadline = time.monotonic() + 5
        rc = None
        while rc is None and time.monotonic() < deadline:
            rc = h.poll()
            time.sleep(0.05)
        assert rc == 0
        assert h.poll() == 0
    finally:
        h._close_control()
        if h._result_fd is not None:
            os.close(h._result_fd)


def test_poll_reports_real_exit_code_without_waitid(no_waitid):
    h, _ = _make_owned([sys.executable, "-c", "raise SystemExit(3)"])
    try:
        deadline = time.monotonic() + 5
        while h.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert h.poll() == 3
    finally:
        h._close_control()
        if h._result_fd is not None:
            os.close(h._result_fd)


def test_wait_returns_after_kill_without_waitid(no_waitid):
    h, _ = _make_owned([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        h.kill()
        rc = h.wait(timeout=5)
        assert rc != 0
    finally:
        h._close_control()
        if h._result_fd is not None:
            os.close(h._result_fd)


def test_reaped_by_own_popen_reports_code_without_waitid(no_waitid):
    h, proc = _make_owned([sys.executable, "-c", "pass"])
    try:
        proc.wait()  # reaped through OUR handle: known code, not a refusal
        assert h.poll() == 0
    finally:
        h._close_control()
        if h._result_fd is not None:
            os.close(h._result_fd)


def test_foreign_reaped_leader_is_refused_without_waitid(no_waitid):
    h, proc = _make_owned([sys.executable, "-c", "pass"])
    try:
        # Reap OUTSIDE this handle: Popen never learns the code, so poll must
        # refuse (None) rather than guess or signal a maybe-reused group.
        while True:
            pid, _ = os.waitpid(proc.pid, os.WNOHANG)
            if pid == proc.pid:
                break
            time.sleep(0.05)
        assert h.poll() is None
    finally:
        h._close_control()
        if h._result_fd is not None:
            os.close(h._result_fd)


def test_kill_after_pid_reuse_does_not_signal_without_waitid(no_waitid, monkeypatch):
    """A foreign-reaped leader's reused numeric pid must not authorize killpg."""
    import signal as _signal

    h, proc = _make_owned([sys.executable, "-c", "pass"])
    try:
        while True:
            pid, _ = os.waitpid(proc.pid, os.WNOHANG)
            if pid == proc.pid:
                break
            time.sleep(0.05)
        # Model the numeric pid being reused: kill(pid, 0) would succeed even
        # though waitpid still reports that the original child is no longer
        # ours. The old guard therefore reached killpg and fails this test.
        monkeypatch.setattr(os, "kill", lambda _pid, _sig: None)
        signalled = []
        monkeypatch.setattr(os, "killpg", lambda pid, sig: signalled.append((pid, sig)))
        h._signal_owned_group(_signal.SIGKILL)
        assert signalled == []
    finally:
        h._close_control()
        if h._result_fd is not None:
            os.close(h._result_fd)
