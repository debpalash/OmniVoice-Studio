"""Regression (#730 class; residual #850/#802/#755): a wedged GPU **generate**
must not brick the backend.

Before this fix, the TTS generate paths (`generation.py`, `tts_stream.py`)
dispatched to the GPU pool with no wall-clock bound and no recovery — unlike
ASR/dub/model-load, which already bound+reset on hang. On the 1–2 worker pools
we ship, one wedged generate (a Windows+CUDA hang) occupied its worker forever,
starving every other request so the next user action surfaced as the misleading
"Can't reach the local backend" even though the process was alive.

`run_on_gpu_pool_guarded` gives every GPU dispatch the same bound+reset recovery:
on timeout it abandons the wedged worker (pool `reset()`), restoring capacity,
and raises `GpuJobTimeoutError` with an actionable message.
"""
from __future__ import annotations

import asyncio
import sys
import threading

import pytest


@pytest.fixture
def model_manager(monkeypatch):
    for mod_name in ("core.config", "services.model_manager"):
        if getattr(sys.modules.get(mod_name), "__file__", None) is None:
            sys.modules.pop(mod_name, None)
    import services.model_manager as mm
    return mm


def test_guard_times_out_resets_pool_and_restores_capacity(model_manager):
    mm = model_manager
    pool = mm._ResilientGpuPool()

    release = threading.Event()

    def _hang():  # a wedged generate that never returns on its own
        release.wait(2.0)
        return "late"

    try:
        # Force the inner pool to exist so we can prove reset() drops it.
        assert pool._live_pool() is not None
        assert pool._pool is not None

        with pytest.raises(mm.GpuJobTimeoutError, match="abandoned"):
            asyncio.run(
                mm.run_on_gpu_pool_guarded(_hang, what="TTS generate",
                                           timeout=0.2, executor=pool)
            )

        # The wedged worker was abandoned: the inner pool is dropped so the next
        # submit builds a fresh one instead of queueing behind the hang.
        assert pool._pool is None

        # Capacity is genuinely restored — a follow-up job runs on a new worker
        # even while the orphaned one is still stuck.
        result = asyncio.run(
            mm.run_on_gpu_pool_guarded(lambda: "ok", what="TTS generate",
                                       timeout=5.0, executor=pool)
        )
        assert result == "ok"
    finally:
        release.set()  # let the orphaned worker exit immediately


def test_guard_happy_path_returns_value(model_manager):
    mm = model_manager
    pool = mm._ResilientGpuPool()
    try:
        result = asyncio.run(
            mm.run_on_gpu_pool_guarded(lambda: 42, what="TTS generate",
                                       timeout=5.0, executor=pool)
        )
        assert result == 42
    finally:
        pool.shutdown(wait=False)


def test_guard_timeout_env_default(model_manager, monkeypatch):
    """The generate bound is env-overridable (parity with the ASR bound)."""
    import importlib
    monkeypatch.setenv("OMNIVOICE_GENERATE_TIMEOUT_S", "123.5")
    mm = importlib.reload(model_manager)
    try:
        assert mm.GPU_JOB_TIMEOUT_S == 123.5
    finally:
        monkeypatch.delenv("OMNIVOICE_GENERATE_TIMEOUT_S", raising=False)
        importlib.reload(mm)


def test_guard_without_reset_still_bounds(model_manager):
    """A plain executor (no `reset`, e.g. in other call sites/tests) still gets
    the wall-clock bound + actionable error — reset is best-effort, not required.
    """
    from concurrent.futures import ThreadPoolExecutor
    mm = model_manager
    ex = ThreadPoolExecutor(max_workers=1)
    release = threading.Event()

    def _hang():
        release.wait(2.0)

    try:
        with pytest.raises(mm.GpuJobTimeoutError):
            asyncio.run(
                mm.run_on_gpu_pool_guarded(_hang, timeout=0.2, executor=ex)
            )
    finally:
        release.set()
        ex.shutdown(wait=False)


# ── Device-aware timeout guidance (#896) ────────────────────────────────────
# A CPU-only host was told "the GPU is VRAM-starved … set the engine to CPU
# in Settings" — nonsense when the resolved device already IS cpu.

def _guidance_for(monkeypatch, family):
    import types
    from services import model_manager as mm
    import core.device_caps as caps
    monkeypatch.setattr(
        caps, "detect_host_caps", lambda: types.SimpleNamespace(family=family)
    )
    return mm._timeout_guidance("TTS generate", 300.0)


def test_cpu_host_gets_compute_bound_guidance(monkeypatch):
    msg = _guidance_for(monkeypatch, "cpu")
    assert "VRAM" not in msg
    assert "set the engine to CPU" not in msg
    assert "compute-bound" in msg
    assert "OMNIVOICE_GENERATE_TIMEOUT_S" in msg


def test_gpu_host_keeps_vram_guidance(monkeypatch):
    msg = _guidance_for(monkeypatch, "cuda")
    assert "VRAM-starved" in msg
    assert "set the engine to CPU" in msg


def test_probe_failure_defaults_to_gpu_wording(monkeypatch):
    import core.device_caps as caps
    from services import model_manager as mm

    def _boom():
        raise RuntimeError("probe failed")

    monkeypatch.setattr(caps, "detect_host_caps", _boom)
    msg = mm._timeout_guidance("TTS generate", 300.0)
    assert "VRAM-starved" in msg  # conservative default, never crashes
