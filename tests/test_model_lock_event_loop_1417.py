"""A cold model load from a GPU-pool thread must not touch the asyncio lock.

#1417, second half. `_model_lock` is a module-level `asyncio.Lock`, so it binds
to whichever event loop first acquires it — in practice the server's. But
`OmniVoiceBackend._ensure_loaded()` runs on a GPU-pool worker thread with no
running loop, and bootstraps a *fresh* one via `asyncio.run(get_model())`.

Awaiting a lock owned by another loop doesn't block, it raises:

    RuntimeError: <asyncio.locks.Lock …> is bound to a different event loop

which reached users as a 500 from /v1/audio/speech. It stayed hidden until the
import bug in the same issue was fixed, because nothing got that far before.

`_heal_tts_placement` already carried a `running_on_gpu_pool()` guard for this
exact situation; the cold-load path in `get_model()` never got it. Occupying a
pool slot IS the mutual exclusion the lock provides, so the load runs inline.

The test drives the real failure shape: bind the lock on one loop, then call
`get_model()` from a thread named like a pool worker on a second loop.
"""

from __future__ import annotations

import asyncio
import importlib
import threading

import pytest


@pytest.fixture
def mm():
    """Resolve the module per test — binding it at collection lets another
    suite's `sys.modules` rebinding make this exercise a different object."""
    return importlib.import_module("services.model_manager")


class _ServerLoopHoldingTheLock:
    """A running event loop, in its own thread, holding `_model_lock`.

    Contention is the whole point. An *uncontended* `asyncio.Lock.acquire()`
    takes a fast path that returns without ever calling `_get_loop()`, so it
    never binds and never complains — a test that merely touches the lock on
    one loop and then uses it on another passes with or without the fix, and
    proves nothing. The RuntimeError only appears on the waiting path, which
    means the lock has to be genuinely held by a live foreign loop.
    """

    def __init__(self, mm):
        self._mm = mm
        self._held = threading.Event()
        self._release = threading.Event()
        self._thread = threading.Thread(target=self._run, name="server-loop", daemon=True)

    def _run(self):
        async def hold():
            async with self._mm._model_lock:
                self._held.set()
                # Wait on the Event itself rather than polling — the wait runs
                # in a worker thread so it never blocks this loop.
                await asyncio.get_running_loop().run_in_executor(
                    None, self._release.wait
                )

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(hold())
        finally:
            loop.close()

    def __enter__(self):
        self._thread.start()
        assert self._held.wait(10), "server loop never took _model_lock"
        return self

    def __exit__(self, *exc):
        self._release.set()
        self._thread.join(timeout=10)
        return False


def test_cold_load_from_a_pool_thread_does_not_await_the_server_lock(mm, monkeypatch):
    """Fail-before: raises 'is bound to a different event loop'."""
    sentinel = object()
    monkeypatch.setattr(mm, "model", None, raising=False)

    # Patch the LEAF loader, not `_load_model_with_timeout`. Faking the latter
    # is what hid the second deadlock in review: it dispatches back into
    # `_get_gpu_pool()`, so replacing it meant the test never exercised the
    # dispatch that a one-worker MPS pool wedges on (CodeRabbit, #1418).
    def _fake_load_sync():
        return sentinel

    monkeypatch.setattr(mm, "_load_model_sync", _fake_load_sync)
    monkeypatch.setattr(mm, "_make_room_before_tts_load", lambda: None)

    result: dict = {}

    def worker():
        try:
            result["value"] = asyncio.run(mm.get_model())
        except BaseException as exc:  # noqa: BLE001 - the failure IS the subject
            result["error"] = exc

    with _ServerLoopHoldingTheLock(mm):
        # The guard keys off the thread name, which is how the real pool marks
        # its workers (`running_on_gpu_pool`). Daemon, because the unfixed
        # behaviour is a DEADLOCK: without the guard this thread waits forever
        # on a future belonging to another loop, and a non-daemon thread would
        # take the whole test run down with it at interpreter exit instead of
        # reporting a failure.
        t = threading.Thread(
            target=worker, name=f"{mm._GPU_POOL_THREAD_PREFIX}0", daemon=True
        )
        t.start()
        t.join(timeout=30)
        assert not t.is_alive(), (
            "cold load from a pool thread blocked on a lock held by the server "
            "loop — it should not be waiting on that lock at all"
        )

    monkeypatch.setattr(mm, "model", None, raising=False)
    assert "error" not in result, f"cold load from a pool thread raised: {result.get('error')!r}"
    assert result.get("value") is sentinel


def test_the_guard_keys_off_the_real_pool_thread_name(mm):
    """If the pool's thread-name prefix ever changes, the guard silently stops
    applying and the 500 comes back — so pin that they agree."""
    t = threading.Thread(target=lambda: None, name=f"{mm._GPU_POOL_THREAD_PREFIX}7")
    t.start()
    t.join()
    assert mm._GPU_POOL_THREAD_PREFIX, "pool threads have no name prefix to detect"

    seen = {}

    def check():
        seen["on_pool"] = mm.running_on_gpu_pool()

    t2 = threading.Thread(target=check, name=f"{mm._GPU_POOL_THREAD_PREFIX}1")
    t2.start()
    t2.join()
    assert seen["on_pool"] is True

    t3 = threading.Thread(target=check, name="unrelated-worker")
    t3.start()
    t3.join()
    assert seen["on_pool"] is False


def test_off_pool_callers_still_take_the_lock(mm, monkeypatch):
    """The guard must not disarm the lock for ordinary server-loop callers —
    that exclusion is what stops two cold loads racing into memory at once."""
    monkeypatch.setattr(mm, "model", None, raising=False)

    entered = []

    async def _fake_load():
        entered.append(mm._model_lock.locked())
        return object()

    monkeypatch.setattr(mm, "_load_model_with_timeout", _fake_load)
    asyncio.run(mm.get_model())
    monkeypatch.setattr(mm, "model", None, raising=False)

    assert entered == [True], "a non-pool cold load no longer holds _model_lock"


def test_the_pool_path_never_resubmits_to_the_pool(mm, monkeypatch):
    """The inline load must not go through `_get_gpu_pool()`.

    `_load_model_with_timeout` runs `_load_model_sync` *in the pool*. Calling
    it from a pool worker re-queues work behind the very slot we occupy, and
    MPS pins that pool to one worker — so it waits on itself. A single-worker
    pool here reproduces that exactly: if the fix ever routes back through the
    pool, this test hangs instead of returning, and the join times out.
    """
    sentinel = object()
    monkeypatch.setattr(mm, "model", None, raising=False)
    monkeypatch.setattr(mm, "_load_model_sync", lambda: sentinel)
    monkeypatch.setattr(mm, "_make_room_before_tts_load", lambda: None)

    class _PoolThatMustNotBeUsed:
        """Stands in for the occupied pool.

        A real one-worker executor would reproduce the wedge faithfully, but a
        regression would then HANG — and a hung pool thread blocks interpreter
        exit, taking the whole suite down instead of reporting a failure.
        Refusing the submit outright turns the same defect into an instant,
        readable failure.
        """

        def submit(self, *a, **kw):
            raise AssertionError(
                "cold load on a pool worker re-submitted to _get_gpu_pool(); "
                "on a one-worker MPS pool this waits on itself (#1417/#1418)"
            )

    monkeypatch.setattr(mm, "_get_gpu_pool", _PoolThatMustNotBeUsed)

    result: dict = {}

    def worker():
        try:
            result["value"] = asyncio.run(mm.get_model())
        except BaseException as exc:  # noqa: BLE001 - the failure IS the subject
            result["error"] = exc

    t = threading.Thread(
        target=worker, name=f"{mm._GPU_POOL_THREAD_PREFIX}0", daemon=True
    )
    t.start()
    t.join(timeout=30)
    # Before touching shared module state: a timed-out worker is still running
    # `get_model()`, and resetting `mm.model` under it leaks a live thread that
    # would mutate the module while later tests use it.
    assert not t.is_alive(), (
        "cold load on a pool worker never returned — it is waiting on the pool "
        "slot it already occupies"
    )
    monkeypatch.setattr(mm, "model", None, raising=False)

    assert "error" not in result, result.get("error")
    assert result.get("value") is sentinel
