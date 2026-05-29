"""`_pitch_preserving_stretch` must be async so it doesn't block the event
loop (Greptile P1 on PR #133's dub-timing path). It's awaited from the
`_stream` async generator; each ffmpeg invocation is ~50-100ms and on a
multi-segment job that froze health-checks / SSE / every concurrent request.
"""
from __future__ import annotations

import asyncio

import numpy as np
import torch

from api.routers.dub_generate import _pitch_preserving_stretch


def test_stretch_is_a_coroutine_and_hits_target_length():
    sr = 16000
    wav = torch.zeros((1, sr), dtype=torch.float32)  # 1s of silence
    target = sr // 2                                  # compress to 0.5s
    coro = _pitch_preserving_stretch(wav, target, sr)
    assert asyncio.iscoroutine(coro), "must be async so it can't block the loop"
    out = asyncio.run(coro)
    assert out.shape == (1, target)
    assert out.dtype == torch.float32


def test_stretch_noop_when_already_target_length():
    sr = 16000
    wav = torch.zeros((1, sr), dtype=torch.float32)
    out = asyncio.run(_pitch_preserving_stretch(wav, sr, sr))
    assert out.shape[-1] == sr
