"""Stable nested operation ownership (model-free, cross-platform seams)."""
import ctypes
import builtins
import os
import runpy
import subprocess
import sys
import threading
import time
import types
from ctypes import wintypes
from pathlib import Path

import pytest

from core import contained_subprocess as owned


class _Call:
    def __init__(self, fn):
        self.fn = fn

    def __call__(self, *args):
        return self.fn(*args)


def test_supervisor_argv_uses_entry_module_for_source_and_frozen_binary(monkeypatch):
    monkeypatch.delattr(owned.sys, "frozen", raising=False)
    source = owned._supervisor_argv(3, 4, ["operation"])
    assert source[:2] == [sys.executable, str(Path(owned.__file__).parents[1] / "main.py")]
    assert source[2:] == ["--supervise", "3", "4", "--", "operation"]

    monkeypatch.setattr(owned.sys, "frozen", True, raising=False)
    frozen = owned._supervisor_argv(3, 4, ["operation"])
    assert frozen == [sys.executable, "--supervise", "3", "4", "--", "operation"]


def test_source_main_dispatches_supervisor_before_heavy_imports(monkeypatch):
    calls = []
    fake = types.ModuleType("core.contained_subprocess")
    fake.supervisor_main = lambda args: calls.append(args) or 23
    monkeypatch.setitem(sys.modules, "core.contained_subprocess", fake)
    main_path = Path(owned.__file__).parents[1] / "main.py"
    monkeypatch.setattr(
        sys,
        "argv",
        [str(main_path), "--supervise", "3", "4", "--", "operation"],
    )
    original_import = builtins.__import__

    def guard_heavy_import(name, *args, **kwargs):
        if name == "math":
            raise AssertionError("supervisor dispatch reached application imports")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guard_heavy_import)
    with pytest.raises(SystemExit, match="23"):
        runpy.run_path(str(main_path), run_name="__main__")
    assert calls == [["--supervise", "3", "4", "--", "operation"]]


@pytest.mark.skipif(os.name != "posix", reason="Unix drain pipe contract")
def test_drain_fd_is_explicitly_inherited_by_wrapper_but_not_operation(monkeypatch):
    drain_read, drain_write = os.pipe()
    monkeypatch.setenv("OMNIVOICE_DESKTOP_CONTAINED", "1")
    monkeypatch.setenv("OMNIVOICE_DESKTOP_DRAIN_FD", str(drain_write))
    owned.secure_backend_drain_fd()
    assert not os.get_inheritable(drain_write)
    implicit_probe = subprocess.check_output(
        [
            sys.executable,
            "-c",
            "import os; "
            "fd=int(os.environ['OMNIVOICE_DESKTOP_DRAIN_FD']); "
            "\ntry: os.fstat(fd); print('leaked')"
            "\nexcept OSError: print('closed')",
        ],
        close_fds=False,
        text=True,
    )
    assert implicit_probe.strip() == "closed"
    script = (
        "import os,time; token=os.environ.get('OMNIVOICE_DESKTOP_DRAIN_FD'); "
        "marker=os.environ.get('OMNIVOICE_DESKTOP_CONTAINED'); "
        "\nif token is None and marker is None: state='stripped'"
        "\nelse:"
        "\n try: os.fstat(int(token)); state='leaked'"
        "\n except OSError: state='closed'"
        "\nprint(state, flush=True); time.sleep(60)"
    )
    proc = owned.spawn_owned(
        [sys.executable, "-c", script],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stdout.readline().strip() == "stripped"
        os.close(drain_write)
        drain_write = -1
        os.set_blocking(drain_read, False)
        with pytest.raises(BlockingIOError):
            os.read(drain_read, 1)  # wrapper still holds the only writer
        proc.kill()
        proc.wait(timeout=5)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                if os.read(drain_read, 1) == b"":
                    break
            except BlockingIOError:
                time.sleep(0.01)
        else:
            pytest.fail("wrapper exit did not close the desktop drain writer")
    finally:
        if drain_write >= 0:
            os.close(drain_write)
        os.close(drain_read)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_invalid_or_missing_desktop_drain_fd_fails_safe(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DESKTOP_CONTAINED", "1")
    monkeypatch.setenv("OMNIVOICE_DESKTOP_DRAIN_FD", "not-an-fd")
    with pytest.raises(RuntimeError, match="missing its live.*drain descriptor"):
        owned.spawn_owned([sys.executable, "-c", "print('unsafe')"])

    monkeypatch.delenv("OMNIVOICE_DESKTOP_DRAIN_FD")
    with pytest.raises(RuntimeError, match="missing its live.*drain descriptor"):
        owned.secure_backend_drain_fd()

    monkeypatch.delenv("OMNIVOICE_DESKTOP_CONTAINED")
    assert owned.backend_drain_fd(required=True) is None
    proc = owned.spawn_owned(
        [sys.executable, "-c", "print('standalone')"],
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout.readline().strip() == "standalone"
    assert proc.wait(timeout=5) == 0


def test_windows_operation_is_in_kill_on_close_job_before_resume(monkeypatch):
    """The child gets no instruction before stable nested Job assignment."""
    events = []
    job_closed = threading.Event()
    job = 99

    def close_handle(handle):
        value = getattr(handle, "value", handle)
        events.append(("close", value))
        if value == job:
            job_closed.set()
        return True

    kernel = type("Kernel", (), {})()
    kernel.AssignProcessToJobObject = _Call(
        lambda assigned_job, process: events.append(("assign", assigned_job, process)) or True
    )
    kernel.TerminateJobObject = _Call(
        lambda assigned_job, code: events.append(("terminate", assigned_job, code)) or True
    )
    kernel.WriteFile = _Call(
        lambda handle, payload, size, written, overlap: events.append(("write", size)) or True
    )
    kernel.CloseHandle = _Call(close_handle)

    def read_control(*_args):
        job_closed.wait(2)
        return False

    kernel.ReadFile = _Call(read_control)
    monkeypatch.setattr(owned, "_windows_job", lambda: (job, kernel, wintypes))
    monkeypatch.setattr(
        owned,
        "_resume_windows_process",
        lambda _kernel, _types, pid: events.append(("resume", pid)),
    )

    class Child:
        _handle = 77
        pid = 123

        def wait(self, timeout=None):
            events.append(("wait", timeout))
            return 0

    monkeypatch.setattr(
        owned.subprocess,
        "Popen",
        lambda *args, **kwargs: events.append(("spawn", kwargs["creationflags"])) or Child(),
    )

    assert owned._supervise_windows(11, 12, ["operation.exe"]) == 0
    assert job_closed.wait(1)

    names = [event[0] for event in events]
    assert names.index("assign") < names.index("resume") < names.index("wait")
    assert names.index("wait") < names.index("terminate") < names.index("write")


def test_windows_assignment_failure_kills_suspended_unowned_child(monkeypatch):
    """A child outside the nested Job must be killed through its stable handle."""
    events = []
    job_closed = threading.Event()
    job = 99

    def close_handle(handle):
        value = getattr(handle, "value", handle)
        events.append(("close", value))
        if value == job:
            job_closed.set()
        return True

    kernel = type("Kernel", (), {})()
    kernel.AssignProcessToJobObject = _Call(
        lambda assigned_job, process: events.append(("assign", assigned_job, process))
        or False
    )
    kernel.TerminateJobObject = _Call(
        lambda assigned_job, code: events.append(("terminate", assigned_job, code)) or True
    )
    kernel.WriteFile = _Call(
        lambda handle, payload, size, written, overlap: events.append(("write", size)) or True
    )
    kernel.CloseHandle = _Call(close_handle)

    def read_control(*_args):
        job_closed.wait(2)
        return False

    kernel.ReadFile = _Call(read_control)
    monkeypatch.setattr(owned, "_windows_job", lambda: (job, kernel, wintypes))
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)

    class Child:
        _handle = 77
        pid = 123

        def kill(self):
            events.append(("kill",))

        def wait(self, timeout=None):
            events.append(("wait", timeout))
            return 1

    monkeypatch.setattr(
        owned.subprocess,
        "Popen",
        lambda *args, **kwargs: events.append(("spawn", kwargs["creationflags"])) or Child(),
    )

    assert owned._supervise_windows(11, 12, ["operation.exe"]) == 127
    assert job_closed.wait(1)

    names = [event[0] for event in events]
    assert names.index("assign") < names.index("terminate") < names.index("kill")
    assert names.index("kill") < names.index("wait") < names.index("write")


def test_windows_direct_job_owner_assigns_before_resume(monkeypatch):
    """Windows skips the extra Python wrapper but retains pre-start Job ownership."""
    events = []
    job = 99

    kernel = type("Kernel", (), {})()
    kernel.AssignProcessToJobObject = _Call(
        lambda assigned_job, process: events.append(("assign", assigned_job, process)) or True
    )
    kernel.TerminateJobObject = _Call(
        lambda assigned_job, code: events.append(("terminate", assigned_job, code)) or True
    )
    kernel.CloseHandle = _Call(
        lambda handle: events.append(("close", getattr(handle, "value", handle))) or True
    )
    monkeypatch.setattr(owned, "_windows_job", lambda: (job, kernel, wintypes))
    monkeypatch.setattr(
        owned,
        "_resume_windows_process",
        lambda _kernel, _types, pid: events.append(("resume", pid)),
    )

    class Child:
        _handle = 77
        pid = 123
        args = ["operation.exe"]
        stdin = None
        stdout = object()
        stderr = object()
        returncode = None

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            events.append(("wait", timeout))
            return self.returncode

        def kill(self):
            events.append(("kill",))

    child = Child()

    def fake_popen(argv, **kwargs):
        events.append(("spawn", argv, kwargs))
        return child

    monkeypatch.setattr(owned.subprocess, "Popen", fake_popen)
    proc = owned._spawn_windows_owned(
        ["operation.exe"],
        {
            "env": {
                "KEEP": "yes",
                "OMNIVOICE_DESKTOP_CONTAINED": "1",
                "OMNIVOICE_DESKTOP_DRAIN_FD": "42",
            },
            "creationflags": 0x00000200,
        },
    )

    names = [event[0] for event in events]
    assert names[:3] == ["spawn", "assign", "resume"]
    spawn_argv, spawn_kwargs = events[0][1:]
    assert spawn_argv == ["operation.exe"]
    assert spawn_kwargs["creationflags"] == 0x08000204
    assert spawn_kwargs["env"] == {"KEEP": "yes"}
    assert proc.stdout is child.stdout

    child.returncode = 0
    assert proc.poll() == 0
    assert [event[0] for event in events][-2:] == ["terminate", "close"]


def test_spawn_owned_selects_direct_windows_job_path(monkeypatch):
    sentinel = object()
    calls = []
    monkeypatch.setattr(owned.os, "name", "nt")
    monkeypatch.setattr(
        owned,
        "_spawn_windows_owned",
        lambda argv, kwargs: calls.append((argv, kwargs)) or sentinel,
    )

    assert owned.spawn_owned(["sidecar.exe"], text=True) is sentinel
    assert calls == [(["sidecar.exe"], {"text": True})]
