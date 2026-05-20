"""Tests for backend/services/subprocess_backend.py — Plan 02-01 Task 1.

Covers the SubprocessBackend round-trip via the permanent echo sidecar at
backend/engines/_echo/main.py.

These tests intentionally spawn a real subprocess (the echo sidecar uses
the parent's `sys.executable` so no engine venv is required). They run on
macOS, Linux, and Windows.
"""
from __future__ import annotations

import io
import os
import struct
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import psutil
import pytest
import torch

# tests/conftest.py prepends ./backend to sys.path so `services.*` resolves.
from services.subprocess_backend import (
    MAX_FRAME_BYTES,
    PARENT_INBOUND_OPS,
    SubprocessBackend,
    _read_exact,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
ECHO_SCRIPT = REPO_ROOT / "backend" / "engines" / "_echo" / "main.py"


# ── test-only subclass ─────────────────────────────────────────────────────


class EchoBackend(SubprocessBackend):
    """In-test subclass — runs the echo sidecar under `sys.executable`."""

    id = "_echo"
    display_name = "Echo (test)"

    @property
    def sample_rate(self) -> int:
        return 24000

    @property
    def supported_languages(self) -> list[str]:
        return ["multi"]

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        if ECHO_SCRIPT.is_file():
            return True, "ready"
        return False, f"echo sidecar missing at {ECHO_SCRIPT}"

    @classmethod
    def venv_python(cls) -> Path:
        return Path(sys.executable)

    @classmethod
    def sidecar_script(cls) -> Path:
        return ECHO_SCRIPT


# ── fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def echo_backend():
    backend = EchoBackend()
    yield backend
    try:
        backend.shutdown()
    except Exception:
        pass


# ── round-trip tests ───────────────────────────────────────────────────────


def test_echo_script_exists():
    """Permanent CI regression infrastructure assertion."""
    assert ECHO_SCRIPT.is_file(), (
        f"Echo sidecar missing at {ECHO_SCRIPT}. This file is permanent "
        "CI regression infrastructure for SubprocessBackend — do not delete."
    )


def test_echo_round_trip(echo_backend):
    """Spawn → synthesize("hello") → expect 1 s of int16 silence as float32."""
    audio = echo_backend.generate("hello")
    assert isinstance(audio, torch.Tensor)
    assert audio.shape == (1, 24000), f"got shape {tuple(audio.shape)}"
    assert audio.dtype == torch.float32
    # Silence — exact zeros after int16 → float32 division.
    assert torch.max(torch.abs(audio)).item() == 0.0


def test_health_check_pings(echo_backend):
    ok, msg = echo_backend.health_check()
    assert ok, f"health_check failed: {msg}"
    assert msg == "pong"


def test_no_zombie_after_shutdown(echo_backend):
    """Spawn → record PID → shutdown → assert PID is gone within 3 s."""
    # Trigger spawn via a ping.
    ok, _ = echo_backend.health_check()
    assert ok
    assert echo_backend._proc is not None
    pid = echo_backend._proc.pid

    echo_backend.shutdown()

    # Poll for up to 3 s; the sidecar should be reaped by wait()/kill().
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if not psutil.pid_exists(pid):
            break
        # Or: zombie state is OK (parent reaped it via wait()).
        try:
            p = psutil.Process(pid)
            if p.status() == psutil.STATUS_ZOMBIE:
                # Reap it ourselves for the assertion below.
                p.wait(timeout=0.5)
                break
        except psutil.NoSuchProcess:
            break
        time.sleep(0.1)

    assert not psutil.pid_exists(pid) or _is_zombie_or_dead(pid), (
        f"sidecar PID {pid} still alive after shutdown"
    )


def _is_zombie_or_dead(pid: int) -> bool:
    try:
        p = psutil.Process(pid)
        return p.status() in (psutil.STATUS_ZOMBIE, psutil.STATUS_DEAD)
    except psutil.NoSuchProcess:
        return True


def test_shutdown_idempotent(echo_backend):
    """Calling shutdown twice must not raise."""
    echo_backend.health_check()
    echo_backend.shutdown()
    echo_backend.shutdown()  # second call is a no-op


def test_env_forwarding_contract(monkeypatch, tmp_path):
    """HF_TOKEN, HF_HOME, HF_ENDPOINT, HF_HUB_CACHE all reach the sidecar.

    Locked Decision D5 — verifies the os.environ.copy() contract that Phase
    2 Wave 2 (IndexTTS migration) relies on for cache discovery.
    """
    monkeypatch.setenv("HF_TOKEN", "hf_test_abc")
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf_home"))
    monkeypatch.setenv("HF_ENDPOINT", "https://hf-mirror.com")
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "hf_cache"))
    monkeypatch.setenv("OMNIVOICE_ECHO_TEST_MODE", "1")

    backend = EchoBackend()
    try:
        # Use the raw send/recv path to invoke the test-only probe_env op.
        with backend._lock:
            backend._spawn()
            backend._send({"op": "probe_env"})
        # probe_env_result isn't in the public PARENT_INBOUND_OPS allowlist
        # by design (it's test-only), so we read it directly via the wire
        # to avoid the allowlist drop. Reach into stdout for one frame.
        proc = backend._proc
        assert proc is not None
        header = _read_exact(proc.stdout, 4)
        assert header is not None
        (n,) = struct.unpack("!I", header)
        body = _read_exact(proc.stdout, n)
        assert body is not None
        import json as _json
        reply = _json.loads(body.decode("utf-8"))
        assert reply["op"] == "probe_env_result"
        keys = reply["keys"]
        assert keys["HF_TOKEN"] == "hf_test_abc"
        assert keys["HF_HOME"] == str(tmp_path / "hf_home")
        assert keys["HF_ENDPOINT"] == "https://hf-mirror.com"
        assert keys["HF_HUB_CACHE"] == str(tmp_path / "hf_cache")
    finally:
        backend.shutdown()


# ── frame protocol DoS guards ──────────────────────────────────────────────


class _FakeStdout:
    """Mock for stdin/stdout pipe in _recv unit tests."""

    def __init__(self, data: bytes):
        self._buf = io.BytesIO(data)

    def read(self, n: int) -> bytes:
        return self._buf.read(n)


class _MockProc:
    def __init__(self, stdout_data: bytes):
        self.stdout = _FakeStdout(stdout_data)
        self.stdin = None

    def poll(self) -> Optional[int]:
        return 0  # claim "already exited" so shutdown is a no-op

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        pass


def test_oversize_frame_rejected():
    """A length-prefix > MAX_FRAME_BYTES must raise IOError before allocation.

    T-02-01 — defends against malicious sidecar sending 0xFFFFFFFF to make
    the parent allocate 4 GB.
    """
    backend = EchoBackend()
    try:
        # Inject a fake proc whose stdout starts with a 100 MB length prefix.
        huge = MAX_FRAME_BYTES + 1
        backend._proc = _MockProc(struct.pack("!I", huge))  # type: ignore[assignment]
        with pytest.raises(IOError, match="frame too large"):
            backend._recv()
    finally:
        # Drop the mock so atexit shutdown doesn't try to wait on it.
        backend._proc = None


def test_short_read_rejected():
    """Length prefix says 100 bytes; only 50 arrive before EOF → IOError."""
    backend = EchoBackend()
    try:
        bad = struct.pack("!I", 100) + b"\x00" * 50  # only 50 of 100 bytes
        backend._proc = _MockProc(bad)  # type: ignore[assignment]
        with pytest.raises(IOError, match="short read"):
            backend._recv()
    finally:
        backend._proc = None


def test_op_allowlist_drops_unknown(monkeypatch):
    """An unknown sidecar op is logged and discarded; parent keeps reading.

    T-02-04 — set up the echo sidecar to emit an `exfiltrate` op followed
    by a legitimate `pong`; parent must silently drop the first and return
    the second.
    """
    monkeypatch.setenv("OMNIVOICE_ECHO_TEST_MODE", "1")
    backend = EchoBackend()
    try:
        with backend._lock:
            backend._spawn()
            backend._send({"op": "emit_unknown"})
            # The sidecar emits {exfiltrate}, then {pong}. _recv must skip
            # the first frame and return the pong.
            reply = backend._recv_with_timeout(5.0)
        assert reply is not None
        assert reply["op"] == "pong"
    finally:
        backend.shutdown()


def test_op_allowlist_constant_shape():
    """PARENT_INBOUND_OPS must contain exactly the documented set."""
    assert PARENT_INBOUND_OPS == frozenset({
        "ready", "pong", "audio", "progress", "error",
        "gpu_acquire", "gpu_release",
    })
    # Sentinel — common typo / accidental addition would fail this test.
    assert "exfiltrate" not in PARENT_INBOUND_OPS
    assert "synthesize" not in PARENT_INBOUND_OPS  # that's a sidecar-inbound op


# ── crash-recovery / GPU slot accounting ───────────────────────────────────


def test_sidecar_crash_releases_resources(monkeypatch, echo_backend):
    """A sidecar that os._exit(1)'s mid-frame must not leave the parent
    holding state — `_proc` becomes detectable as dead and a fresh spawn
    works."""
    monkeypatch.setenv("OMNIVOICE_ECHO_CRASH", "1")
    monkeypatch.setenv("OMNIVOICE_ECHO_TEST_MODE", "1")

    # First generate causes the sidecar to crash after sending the audio
    # frame (the crash hook fires after frames_handled >= 1).
    audio = echo_backend.generate("hello")
    assert audio.shape == (1, 24000)

    # Give the crashed child a moment to actually exit.
    time.sleep(0.5)

    # The next generate must spawn a fresh sidecar — the broken pipe from
    # the dead child should be detected, shutdown clears _proc, and a new
    # spawn succeeds. We allow the generate to fail OR to succeed after
    # respawn; the invariant is "the backend doesn't deadlock or wedge".
    try:
        echo_backend.shutdown()
    except Exception:
        pass
    # Disable the crash hook so the next spawn lives.
    monkeypatch.delenv("OMNIVOICE_ECHO_CRASH", raising=False)
    # Fresh spawn works.
    ok, msg = echo_backend.health_check()
    assert ok, f"recovery failed: {msg}"


# ── module-level helpers ───────────────────────────────────────────────────


def test_no_multiprocessing_imports():
    """Locked decision D4 — no `mp.Process`/`mp.fork`/`mp.spawn` allowed."""
    src = (REPO_ROOT / "backend" / "services" / "subprocess_backend.py").read_text()
    for bad in ("mp.Process", "mp.fork", "mp.spawn",
                "multiprocessing.Process", "multiprocessing.fork",
                "multiprocessing.spawn"):
        assert bad not in src, (
            f"Found forbidden multiprocessing pattern {bad!r} in "
            "subprocess_backend.py — see locked decision D4 / Pitfall 1."
        )


def test_max_frame_bytes_is_64mb():
    assert MAX_FRAME_BYTES == 64 * 1024 * 1024
