"""A GPU job that overruns its budget must leave evidence of WHERE it stuck.

#1338 / #1329 / #1348: three reporters on v0.4.2 hit "TTS generate ran for more
than 300s of actual compute time and was abandoned" — two of them on an RTX 3050
and an RTX 3060, rendering a *single sentence*. That is not a machine too slow
for the job; the message says "too heavy for the available compute" because it
is the only story the timeout path can tell.

And nothing in the log could contradict it. The timeout branch logged *that* the
budget was exceeded, reset the pool, and returned. The worker thread cannot be
cancelled, so it was still running, still on a real stack — and we threw that
away. Every report of this class therefore arrived undiagnosable.

``log_gpu_pool_worker_stacks`` closes that: ``sys._current_frames()`` reads the
frame of every live thread, including one wedged inside a C call, which is
exactly the case that matters here. These tests pin the two things a future
change could quietly break — that it runs at all, and that it runs *before*
``reset()`` replaces the pool and makes the wedged thread unidentifiable.
"""
import asyncio
import importlib
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))


@pytest.fixture
def mm():
    """Resolve the module at call time — sibling suites reload/purge
    ``services.*``, so an import-time alias can go stale (#1269)."""
    return importlib.import_module("services.model_manager")


def _wedged_pool(mm, release: threading.Event):
    """A pool whose single worker parks until ``release`` is set, named exactly
    as the real GPU pool so the capture's filter applies."""
    return ThreadPoolExecutor(
        max_workers=1, thread_name_prefix=mm._GPU_POOL_THREAD_PREFIX
    )


def test_capture_names_the_function_the_worker_is_stuck_in(mm):
    release = threading.Event()
    ex = _wedged_pool(mm, release)
    entered = threading.Event()

    def a_deliberately_wedged_generate():
        entered.set()
        release.wait(10)

    fut = ex.submit(a_deliberately_wedged_generate)
    assert entered.wait(5), "worker never started"
    try:
        text = mm.log_gpu_pool_worker_stacks("TTS generate", 300.0)
        assert mm._GPU_POOL_THREAD_PREFIX in text, text
        # The whole point: the frame that names the stuck call must be present.
        assert "a_deliberately_wedged_generate" in text, (
            "the capture did not reach the frame the worker is actually in — "
            "which is the only part of it a maintainer reads:\n" + text
        )
    finally:
        release.set()
        fut.result(timeout=5)
        ex.shutdown(wait=True)


def test_capture_ignores_threads_that_are_not_pool_workers(mm):
    """The process has a web server, a watchdog and a watermark pool in it. A
    dump of everything is a dump nobody reads."""
    release = threading.Event()
    entered = threading.Event()

    def not_a_gpu_worker():
        entered.set()
        release.wait(10)

    other = ThreadPoolExecutor(max_workers=1, thread_name_prefix="watermark")
    fut = other.submit(not_a_gpu_worker)
    assert entered.wait(5)
    try:
        text = mm.log_gpu_pool_worker_stacks("TTS generate", 300.0)
        assert "not_a_gpu_worker" not in text, text
    finally:
        release.set()
        fut.result(timeout=5)
        other.shutdown(wait=True)


def test_capture_is_empty_when_no_pool_worker_exists(mm):
    """Nothing to report is not an error — the timeout path must not depend on
    this having found anything."""
    assert mm.log_gpu_pool_worker_stacks("TTS generate", 300.0) == ""


def test_capture_never_raises(mm, monkeypatch):
    """Diagnostics run inside the timeout handler. One that throws would
    replace a real GpuJobTimeoutError with an unrelated crash."""
    monkeypatch.setattr(
        mm.threading, "enumerate", lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    assert mm.log_gpu_pool_worker_stacks("TTS generate", 300.0) == ""


def test_timeout_captures_stacks_before_resetting_the_pool(mm):
    """Ordering is load-bearing, so it is asserted rather than assumed.

    ``reset()`` swaps in a fresh executor. Once that happens the wedged thread
    is no longer named as a pool worker, so the capture would find nothing —
    the diagnostic would still "run", still log, and still be empty, which is
    the worst of both worlds because it looks like it worked.
    """
    order = []
    release = threading.Event()
    entered = threading.Event()

    def wedged():
        entered.set()
        release.wait(10)

    inner = ThreadPoolExecutor(
        max_workers=1, thread_name_prefix=mm._GPU_POOL_THREAD_PREFIX
    )

    class _Pool:
        def submit(self, fn, *a, **kw):
            return inner.submit(fn, *a, **kw)

        def reset(self):
            order.append("reset")

    captured = {}

    def _spy(what, timeout):
        order.append("capture")
        captured["text"] = real(what, timeout)
        return captured["text"]

    real = mm.log_gpu_pool_worker_stacks
    mm.log_gpu_pool_worker_stacks = _spy
    try:
        async def _run():
            return await mm.run_on_gpu_pool_guarded(
                wedged, what="TTS generate", executor=_Pool(), timeout=0.4,
            )

        with pytest.raises(mm.GpuJobTimeoutError):
            asyncio.run(_run())
    finally:
        mm.log_gpu_pool_worker_stacks = real
        release.set()
        inner.shutdown(wait=True)

    assert order == ["capture", "reset"], (
        f"stacks must be captured before reset() replaces the pool: {order}"
    )
    assert "wedged" in captured.get("text", ""), captured
