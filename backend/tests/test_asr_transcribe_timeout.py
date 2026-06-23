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

from services.asr_backend import (  # noqa: E402
    ASRTimeoutError,
    ASR_TRANSCRIBE_TIMEOUT_S,
    run_transcribe_guarded,
)
from concurrent.futures import ThreadPoolExecutor  # noqa: E402


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
