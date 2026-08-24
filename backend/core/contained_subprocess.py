"""Nested subprocess ownership for desktop-managed backend operations.

The desktop owns the backend with an OS process group/Job.  Engine and
installer operations also need an independently terminable subtree: killing
only their direct child on a timeout leaves uv/git/model workers holding pipes
and mutating files.  A small direct-child supervisor bridges both lifetimes.

On POSIX the supervisor is the unreaped leader of a nested process group.  A
control-pipe EOF (including kernel EOF when the backend dies) kills that group;
the parent also drains the group before reaping its stable leader.  On Windows
the supervisor assigns the operation, while suspended, to a nested
kill-on-close Job.  The outer desktop Job still contains both levels.

Standalone/server launches use the same nested owner, preserving their
independently terminable subtree without relying on ``taskkill`` or discovery.
"""
from __future__ import annotations

import os
import signal
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional


_RESULT = struct.Struct("!i")
_DESKTOP_MARKER = "OMNIVOICE_DESKTOP_CONTAINED"
_DRAIN_FD_ENV = "OMNIVOICE_DESKTOP_DRAIN_FD"


def backend_drain_fd(*, required: bool = False) -> Optional[int]:
    """Validated Rust-owned drain writer inherited by the desktop backend."""
    if os.name != "posix" or os.environ.get(_DESKTOP_MARKER) != "1":
        return None
    try:
        fd = int(os.environ[_DRAIN_FD_ENV])
        os.fstat(fd)
    except (KeyError, ValueError, OSError) as exc:
        if required:
            raise RuntimeError(
                "desktop backend is missing its live nested-operation drain descriptor"
            ) from exc
        return None
    return fd


def secure_backend_drain_fd() -> None:
    """Restore CLOEXEC after Rust's one intentional backend inheritance."""
    fd = backend_drain_fd(required=True)
    if fd is not None:
        os.set_inheritable(fd, False)


class OwnedPopen:
    """Popen-compatible handle for a desktop-owned nested operation."""

    def __init__(
        self,
        proc: subprocess.Popen,
        control_fd: int,
        result_fd: int,
    ) -> None:
        self._proc = proc
        self._control_fd: Optional[int] = control_fd
        self._result_fd: Optional[int] = result_fd
        self._returncode: Optional[int] = None
        self._lock = threading.RLock()

        # Popen callers use these directly (protocol pipes and log drains).
        self.stdin = proc.stdin
        self.stdout = proc.stdout
        self.stderr = proc.stderr

    @property
    def pid(self) -> int:
        return self._proc.pid

    @property
    def args(self) -> Any:
        return self._proc.args

    @property
    def returncode(self) -> Optional[int]:
        return self._returncode

    def _close_control(self) -> None:
        fd, self._control_fd = self._control_fd, None
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    def _read_result(self, fallback: int) -> int:
        fd, self._result_fd = self._result_fd, None
        if fd is None:
            return fallback
        try:
            payload = b""
            while len(payload) < _RESULT.size:
                chunk = os.read(fd, _RESULT.size - len(payload))
                if not chunk:
                    break
                payload += chunk
            return _RESULT.unpack(payload)[0] if len(payload) == _RESULT.size else fallback
        except OSError:
            return fallback
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

    def _posix_exited_unreaped(self) -> bool:
        flags = os.WEXITED | os.WNOHANG | os.WNOWAIT
        info = os.waitid(os.P_PID, self.pid, flags)
        return info is not None and info.si_pid != 0

    def _signal_owned_group(self, sig: int) -> None:
        # The numeric group is safe only while its direct-child leader remains
        # ours and unreaped.  ECHILD therefore refuses rather than guessing.
        try:
            os.waitid(os.P_PID, self.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            return
        try:
            os.killpg(self.pid, sig)
        except ProcessLookupError:
            pass

    def poll(self) -> Optional[int]:
        with self._lock:
            if self._returncode is not None:
                return self._returncode
            if os.name == "posix":
                try:
                    if not self._posix_exited_unreaped():
                        return None
                except ChildProcessError:
                    # Never signal a potentially reused group after another
                    # owner reaped the stable leader.
                    return None
                self._signal_owned_group(signal.SIGKILL)
                wrapper_rc = self._proc.wait()
            else:
                wrapper_rc = self._proc.poll()
                if wrapper_rc is None:
                    return None
            self._close_control()
            self._returncode = self._read_result(wrapper_rc)
            return self._returncode

    def wait(self, timeout: Optional[float] = None) -> int:
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            rc = self.poll()
            if rc is not None:
                return rc
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(self.args, timeout)
            time.sleep(0.01)

    def terminate(self) -> None:
        with self._lock:
            if self._returncode is not None:
                return
            self._close_control()
            if os.name == "posix":
                self._signal_owned_group(signal.SIGTERM)
            else:
                # Closing the control pipe asks the supervisor to terminate
                # its nested Job.  The stable wrapper handle is a fallback.
                try:
                    self._proc.terminate()
                except OSError:
                    pass

    def kill(self) -> None:
        with self._lock:
            if self._returncode is not None:
                return
            self._close_control()
            if os.name == "posix":
                self._signal_owned_group(signal.SIGKILL)
            else:
                try:
                    self._proc.kill()
                except OSError:
                    pass

    def __getattr__(self, name: str) -> Any:
        return getattr(self._proc, name)

    def __del__(self) -> None:
        self._close_control()
        fd, self._result_fd = self._result_fd, None
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def spawn_owned(argv: list[str], **kwargs: Any) -> "subprocess.Popen | OwnedPopen":
    """Spawn an operation with a stable, independently terminable owner."""

    drain_fd = backend_drain_fd(required=True) if os.name == "posix" else None
    control_read, control_write = os.pipe()
    result_read, result_write = os.pipe()
    control_token = control_read
    result_token = result_write
    if os.name == "nt":
        import msvcrt

        control_token = msvcrt.get_osfhandle(control_read)
        result_token = msvcrt.get_osfhandle(result_write)
    wrapper_argv = _supervisor_argv(
        control_token,
        result_token,
        argv,
    )
    wrapper_kwargs = dict(kwargs)
    if os.name == "posix":
        wrapper_kwargs["start_new_session"] = True
        pass_fds = [control_read, result_write]
        if drain_fd is not None:
            pass_fds.append(drain_fd)
            if wrapper_kwargs.get("env") is not None:
                wrapper_env = dict(wrapper_kwargs["env"])
                wrapper_env[_DESKTOP_MARKER] = "1"
                wrapper_env[_DRAIN_FD_ENV] = str(drain_fd)
                wrapper_kwargs["env"] = wrapper_env
        wrapper_kwargs["pass_fds"] = tuple(pass_fds)
    else:
        # Python's Windows fd inheritance requires inheritable CRT handles.
        # All unrelated descriptors are non-inheritable by default (PEP 446).
        os.set_handle_inheritable(control_token, True)
        os.set_handle_inheritable(result_token, True)
        wrapper_kwargs["close_fds"] = False
    try:
        proc = subprocess.Popen(wrapper_argv, **wrapper_kwargs)
    except BaseException:
        for fd in (control_read, control_write, result_read, result_write):
            try:
                os.close(fd)
            except OSError:
                pass
        raise
    finally:
        for fd in (control_read, result_write):
            try:
                os.close(fd)
            except OSError:
                pass
    return OwnedPopen(proc, control_write, result_read)


def _supervisor_argv(
    control_token: int,
    result_token: int,
    argv: list[str],
) -> list[str]:
    prefix = [sys.executable]
    if not getattr(sys, "frozen", False):
        prefix.append(str(Path(__file__).resolve().parents[1] / "main.py"))
    return [
        *prefix,
        "--supervise",
        str(control_token),
        str(result_token),
        "--",
        *map(str, argv),
    ]


def _write_result(fd: int, returncode: int) -> None:
    try:
        os.write(fd, _RESULT.pack(int(returncode)))
    except OSError:
        pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _operation_env() -> dict[str, str]:
    env = os.environ.copy()
    # The operation intentionally does not own the Rust drain writer. Avoid
    # exposing a stale numeric token which nested code could mistake as valid.
    env.pop(_DRAIN_FD_ENV, None)
    env.pop(_DESKTOP_MARKER, None)
    return env


def _supervise_posix(control_fd: int, result_fd: int, argv: list[str]) -> int:
    def cancel_on_eof() -> None:
        try:
            while os.read(control_fd, 1):
                pass
        except OSError:
            pass
        os.killpg(os.getpgrp(), signal.SIGKILL)

    threading.Thread(target=cancel_on_eof, daemon=True).start()
    try:
        child = subprocess.Popen(argv, close_fds=True, env=_operation_env())
        rc = child.wait()
    except OSError:
        rc = 127
    _write_result(result_fd, rc)
    # Drain children which outlived the operation before the stable group
    # leader exits.  SIGKILL intentionally includes this supervisor.
    os.killpg(os.getpgrp(), signal.SIGKILL)
    return rc  # unreachable


def _windows_job() -> tuple[Any, Any, Any]:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.ReadFile.argtypes = (
        wintypes.HANDLE,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.c_void_p,
    )
    kernel32.ReadFile.restype = wintypes.BOOL
    kernel32.WriteFile.argtypes = (
        wintypes.HANDLE,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.c_void_p,
    )
    kernel32.WriteFile.restype = wintypes.BOOL
    create = kernel32.CreateJobObjectW
    create.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    create.restype = wintypes.HANDLE
    job = create(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW")

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    info = ExtendedLimits()
    info.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
    set_info = kernel32.SetInformationJobObject
    set_info.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    set_info.restype = wintypes.BOOL
    if not set_info(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        error = ctypes.get_last_error()
        kernel32.CloseHandle(job)
        raise OSError(error, "SetInformationJobObject")
    return job, kernel32, wintypes


def _resume_windows_process(kernel32: Any, wintypes: Any, pid: int) -> None:
    import ctypes

    class ThreadEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ThreadID", wintypes.DWORD),
            ("th32OwnerProcessID", wintypes.DWORD),
            ("tpBasePri", wintypes.LONG),
            ("tpDeltaPri", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
        ]

    kernel32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Thread32First.argtypes = (wintypes.HANDLE, ctypes.POINTER(ThreadEntry))
    kernel32.Thread32First.restype = wintypes.BOOL
    kernel32.Thread32Next.argtypes = (wintypes.HANDLE, ctypes.POINTER(ThreadEntry))
    kernel32.Thread32Next.restype = wintypes.BOOL
    kernel32.OpenThread.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenThread.restype = wintypes.HANDLE
    kernel32.ResumeThread.argtypes = (wintypes.HANDLE,)
    kernel32.ResumeThread.restype = wintypes.DWORD

    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000004, 0)
    invalid = ctypes.c_void_p(-1).value
    if snapshot == invalid:
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot")
    try:
        entry = ThreadEntry(dwSize=ctypes.sizeof(ThreadEntry))
        found = kernel32.Thread32First(snapshot, ctypes.byref(entry))
        while found:
            if entry.th32OwnerProcessID == pid:
                thread = kernel32.OpenThread(0x0002, False, entry.th32ThreadID)
                if not thread:
                    raise OSError(ctypes.get_last_error(), "OpenThread")
                try:
                    if kernel32.ResumeThread(thread) == 0xFFFFFFFF:
                        raise OSError(ctypes.get_last_error(), "ResumeThread")
                    return
                finally:
                    kernel32.CloseHandle(thread)
            found = kernel32.Thread32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    raise OSError("suspended operation thread was not found")


def _supervise_windows(control_fd: int, result_fd: int, argv: list[str]) -> int:
    import ctypes

    job, kernel32, wintypes = _windows_job()
    cancelled = threading.Event()
    job_lock = threading.Lock()
    job_open = True

    def terminate_job() -> None:
        with job_lock:
            if job_open:
                kernel32.TerminateJobObject(job, 1)

    def cancel_on_eof() -> None:
        byte = ctypes.create_string_buffer(1)
        count = wintypes.DWORD()
        while kernel32.ReadFile(
            wintypes.HANDLE(control_fd), byte, 1, ctypes.byref(count), None
        ) and count.value:
            pass
        kernel32.CloseHandle(wintypes.HANDLE(control_fd))
        cancelled.set()
        terminate_job()

    threading.Thread(target=cancel_on_eof, daemon=True).start()
    child: Optional[subprocess.Popen] = None
    rc = 127
    try:
        child = subprocess.Popen(
            argv,
            close_fds=True,
            env=_operation_env(),
            creationflags=0x08000000 | 0x00000004,  # NO_WINDOW | SUSPENDED
        )
        assign = kernel32.AssignProcessToJobObject
        assign.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        assign.restype = wintypes.BOOL
        if not assign(job, wintypes.HANDLE(child._handle)):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject")
        if cancelled.is_set():
            terminate_job()
        else:
            _resume_windows_process(kernel32, wintypes, child.pid)
        rc = child.wait()
        # A successful direct child may leave helpers behind; terminate the
        # nested stable Job before reporting completion.
        terminate_job()
    except OSError:
        terminate_job()
        if child is not None:
            try:
                # Assignment itself may have failed, leaving this suspended
                # process outside the nested Job.  Terminate it through its
                # stable process handle before waiting; never strand an
                # unassigned operation or rely on the outer desktop Job.
                child.kill()
            except OSError:
                pass
            try:
                child.wait(timeout=5)
            except Exception:
                pass
    finally:
        payload = _RESULT.pack(int(rc))
        payload_buffer = ctypes.create_string_buffer(payload)
        written = wintypes.DWORD()
        kernel32.WriteFile(
            wintypes.HANDLE(result_fd),
            payload_buffer,
            len(payload),
            ctypes.byref(written),
            None,
        )
        kernel32.CloseHandle(wintypes.HANDLE(result_fd))
        with job_lock:
            job_open = False
            kernel32.CloseHandle(job)
    return rc


def supervisor_main(args: list[str]) -> int:
    if len(args) < 5 or args[0] != "--supervise" or args[3] != "--":
        return 2
    control_fd = int(args[1])
    result_fd = int(args[2])
    argv = args[4:]
    secure_backend_drain_fd()
    if os.name == "posix":
        return _supervise_posix(control_fd, result_fd, argv)
    return _supervise_windows(control_fd, result_fd, argv)


def _main() -> int:
    return supervisor_main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(_main())
