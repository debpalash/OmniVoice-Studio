"""Whole-file ASR transcribe must be wall-clock bounded (TamKieu / Vietnam report).

The chunked dub pipeline already bounds each chunk, but the whole-file paths
(dub QC re-transcribe, dictation, OpenAI-compat) ran unbounded — a slow/stuck
transcribe (e.g. large-v3 on a VRAM-starved GPU) hung the request *and* held a
GPU-pool worker, surfacing in the UI as the misleading "can't reach the local
backend". `run_transcribe_guarded` bounds them and raises `ASRTimeoutError` with
actionable guidance. These tests pin the timeout path, the pass-through path, and
that the error message tells the user what to do.
"""
import asyncio
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from services import asr_backend  # noqa: E402
from services.asr_backend import (  # noqa: E402
    ASRTimeoutError,
    ASR_TRANSCRIBE_TIMEOUT_S,
    reset_pool_after_wedge,
    run_transcribe_guarded,
)
from concurrent.futures import ThreadPoolExecutor  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_timeout_streak(monkeypatch):
    """The consecutive-timeout streak (#730 residual B) is process-global
    session state; zero it per test so ordering can't leak recommendations,
    and pin the active engine so a dev box's prefs can't flip the hint."""
    monkeypatch.setattr(asr_backend, "_timeout_streak", 0)
    monkeypatch.setattr(asr_backend, "active_backend_id", lambda: "whisperx")


def test_default_timeout_is_env_overridable(monkeypatch):
    # The constant is read at import; just assert it's a sane positive default.
    assert ASR_TRANSCRIBE_TIMEOUT_S > 0


def test_slow_transcribe_raises_actionable_timeout():
    pool = ThreadPoolExecutor(max_workers=1)

    def _hang():
        time.sleep(5)  # would block far past our tiny timeout
        return "never"

    async def _go():
        with pytest.raises(ASRTimeoutError) as ei:
            await run_transcribe_guarded(pool, _hang, what="QC", timeout=0.2)
        msg = str(ei.value)
        # Message must reassure (backend alive) + give concrete remedies.
        assert "backend is running" in msg
        assert "Settings → Models" in msg
        assert "CPU" in msg

    asyncio.run(_go())
    pool.shutdown(wait=False)


def test_fast_transcribe_passes_through():
    pool = ThreadPoolExecutor(max_workers=1)

    def _quick():
        return {"segments": [{"text": "hi"}]}, "whisperx"

    async def _go():
        out = await run_transcribe_guarded(pool, _quick, what="Dictation", timeout=5.0)
        assert out == ({"segments": [{"text": "hi"}]}, "whisperx")

    asyncio.run(_go())
    pool.shutdown(wait=True)


def test_timeout_error_is_a_timeouterror_subclass():
    # Routers that catch broad TimeoutError (openai_compat) must also catch ours.
    assert issubclass(ASRTimeoutError, TimeoutError)


def test_timeout_resets_a_resilient_pool_to_restore_capacity():
    # #730: a wedged transcribe holds its GPU-pool worker forever; with a 1-2
    # worker pool that starves TTS generate and surfaces as "can't reach
    # backend". On timeout, run_transcribe_guarded must reset() a pool that
    # supports it (the real _ResilientGpuPool) so the next submit gets a fresh
    # worker — capacity restored without an app restart.
    class _FakePool(ThreadPoolExecutor):
        def __init__(self):
            super().__init__(max_workers=1)
            self.reset_calls = 0

        def reset(self):
            self.reset_calls += 1

    pool = _FakePool()

    def _hang():
        time.sleep(5)
        return "never"

    async def _go():
        with pytest.raises(ASRTimeoutError):
            await run_transcribe_guarded(pool, _hang, what="Dub", timeout=0.2)

    asyncio.run(_go())
    assert pool.reset_calls == 1
    pool.shutdown(wait=False)


def test_timeout_without_reset_capable_pool_does_not_crash():
    # A plain ThreadPoolExecutor (no reset) must still bound + raise cleanly —
    # the reset() is best-effort, never required.
    pool = ThreadPoolExecutor(max_workers=1)

    def _hang():
        time.sleep(5)
        return "never"

    async def _go():
        with pytest.raises(ASRTimeoutError):
            await run_transcribe_guarded(pool, _hang, what="QC", timeout=0.2)

    asyncio.run(_go())
    pool.shutdown(wait=False)


# ── Residual B on #730: consecutive timeouts recommend the isolated engine ──


def _hang_forever():
    time.sleep(5)
    return "never"


async def _timeout_once(pool, timeout=0.1) -> str:
    with pytest.raises(ASRTimeoutError) as ei:
        await run_transcribe_guarded(pool, _hang_forever, what="Dub", timeout=timeout)
    return str(ei.value)


def test_second_consecutive_timeout_recommends_isolated_engine():
    """When guarded timeouts hit twice in a row in one session, pool resets
    clearly aren't recovering the hang — the error the user sees must name the
    crash-isolated escape-hatch engine (and make clear we never auto-switch)."""
    pool = ThreadPoolExecutor(max_workers=2)

    async def _go():
        first = await _timeout_once(pool)
        assert "faster-whisper-isolated" not in first  # one timeout ≠ a pattern
        second = await _timeout_once(pool)
        assert "faster-whisper-isolated" in second
        assert "Settings → Engines" in second
        assert "never switches engines automatically" in second

    asyncio.run(_go())
    pool.shutdown(wait=False)


def test_successful_transcribe_resets_the_timeout_streak():
    """'Consecutive' must mean consecutive: a transcribe that completes between
    two timeouts proves the pool recovered, so the recommendation must not fire."""
    pool = ThreadPoolExecutor(max_workers=3)

    async def _go():
        await _timeout_once(pool)
        out = await run_transcribe_guarded(pool, lambda: "ok", what="Dub", timeout=5.0)
        assert out == "ok"
        second = await _timeout_once(pool)
        assert "faster-whisper-isolated" not in second

    asyncio.run(_go())
    pool.shutdown(wait=False)


def test_no_recommendation_when_already_on_isolated_engine(monkeypatch):
    """Recommending the isolated engine to a user already running it is noise —
    the base message's smaller-model/CPU guidance is all that's left."""
    monkeypatch.setattr(
        asr_backend, "active_backend_id", lambda: "faster-whisper-isolated"
    )
    pool = ThreadPoolExecutor(max_workers=2)

    async def _go():
        await _timeout_once(pool)
        second = await _timeout_once(pool)
        assert "faster-whisper-isolated) in Settings" not in second
        assert "never switches engines automatically" not in second

    asyncio.run(_go())
    pool.shutdown(wait=False)


def test_timeout_env_name_is_parameterized():
    """The chunked dub path passes its own knob; the message must name IT, not
    the whole-file env var (actionable errors point at the right dial)."""
    pool = ThreadPoolExecutor(max_workers=1)

    async def _go():
        with pytest.raises(ASRTimeoutError) as ei:
            await run_transcribe_guarded(
                pool, _hang_forever, what="Dub chunk 1/3", timeout=0.1,
                timeout_env="OMNIVOICE_TRANSCRIBE_CHUNK_TIMEOUT_S",
            )
        msg = str(ei.value)
        assert "OMNIVOICE_TRANSCRIBE_CHUNK_TIMEOUT_S" in msg
        assert "OMNIVOICE_ASR_TRANSCRIBE_TIMEOUT_S" not in msg

    asyncio.run(_go())
    pool.shutdown(wait=False)


def test_reset_pool_after_wedge_is_shared_and_best_effort():
    """One reset mechanism for every transcribe path (#730 residual A): it
    resets a reset-capable pool, no-ops a plain executor, and never raises."""

    class _Pool:
        resets = 0

        def reset(self):
            self.resets += 1

    p = _Pool()
    assert reset_pool_after_wedge(p, what="Dub chunk 1/2") is True
    assert p.resets == 1

    plain = ThreadPoolExecutor(max_workers=1)
    try:
        assert reset_pool_after_wedge(plain) is False
    finally:
        plain.shutdown(wait=False)

    class _Broken:
        def reset(self):
            raise RuntimeError("reset blew up")

    assert reset_pool_after_wedge(_Broken()) is False  # must not raise
