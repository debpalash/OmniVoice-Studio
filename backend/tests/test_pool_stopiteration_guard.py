"""A bare ``StopIteration`` from a pool worker must fail, not hang (#1321).

asyncio refuses to put ``StopIteration`` into a Future. The refusal does not
raise where anyone can catch it: ``_copy_future_state`` raises ``TypeError:
StopIteration interacts badly with generators and cannot be raised into a
Future`` inside the event loop's *callback*, the ``run_in_executor`` future is
left pending, and the awaiting coroutine waits forever. No error, no event, no
timeout — an audiobook render simply stops emitting and the app looks wedged.

This is reachable from ordinary user input. Engines that drive a generator hit
it on text they cannot handle: VoxCPM's ``next_and_close`` is a bare
``next(gen)``, so a generator that ends without yielding raises ``StopIteration``
straight out of ``backend.generate`` and into the GPU-pool worker.

Both tests below hang forever without the guard (hence the explicit
``wait_for`` — a hang must fail the suite, not stall CI until the job timeout).
"""
import asyncio

import pytest

import services.model_manager as mm


def _raise_bare_stopiteration():
    raise StopIteration()


def _run_on(executor):
    async def _scenario():
        loop = asyncio.get_running_loop()
        # Bounded on purpose: the bug this guards against is an infinite wait.
        return await asyncio.wait_for(
            loop.run_in_executor(executor, _raise_bare_stopiteration), timeout=15
        )

    return asyncio.run(_scenario())


def test_gpu_pool_translates_bare_stopiteration():
    """The GPU pool is where every engine/model dispatch runs."""
    with pytest.raises(mm.WorkerStopIteration):
        _run_on(mm._get_gpu_pool())


def test_cpu_pool_translates_bare_stopiteration():
    """The CPU offload pool takes the same class of callable (dub_core parks
    loads and mixes on it), so the guard has to cover it too."""
    with pytest.raises(mm.WorkerStopIteration):
        _run_on(mm._cpu_pool)


def test_translated_error_is_a_runtimeerror():
    """Upstream handlers catch ``Exception`` (and often ``RuntimeError``) — the
    translation must not slip past them into a bare-except crash path."""
    assert issubclass(mm.WorkerStopIteration, RuntimeError)


def test_reason_is_non_empty_and_actionable():
    """``str(StopIteration())`` is ``''``. A translation that kept an empty
    message would trade a hang for "unknown error", which is the failure class
    core.failure exists to prevent."""
    with pytest.raises(mm.WorkerStopIteration) as ei:
        _run_on(mm._get_gpu_pool())
    text = str(ei.value)
    assert text.strip()
    assert "StopIteration" in text
    # The original is kept as the cause, so the traceback still points at the
    # engine frame that actually stopped.
    assert isinstance(ei.value.__cause__, StopIteration)


def test_normal_exceptions_are_untouched():
    """The guard is narrow: only StopIteration is translated."""
    def _boom():
        raise ValueError("ordinary failure")

    async def _scenario():
        loop = asyncio.get_running_loop()
        return await asyncio.wait_for(
            loop.run_in_executor(mm._get_gpu_pool(), _boom), timeout=15
        )

    with pytest.raises(ValueError, match="ordinary failure"):
        asyncio.run(_scenario())


def test_return_values_pass_through():
    async def _scenario():
        loop = asyncio.get_running_loop()
        return await asyncio.wait_for(
            loop.run_in_executor(mm._get_gpu_pool(), lambda: 42), timeout=15
        )

    assert asyncio.run(_scenario()) == 42
