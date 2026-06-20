"""GPU worker-sizing policy (#567 crash prevention).

The "Can't reach the local backend" crash wave on 8 GB GPUs was an OOM/CUDA
fault from running 2 concurrent clone jobs (TTS + co-loaded WhisperX ASR) when
the pool was sized to >1 worker on a small card. These pin the sizing policy so
an 8 GB card serializes to a single worker (no contention → no crash) while
larger cards still parallelize, all without needing a GPU.
"""
from services.model_manager import (
    _workers_for_free_vram,
    _GPU_WORKER_CAP,
    _GPU_VRAM_PER_JOB_GB,
)


def test_eight_gb_card_serializes_to_one_worker():
    # An 8 GB card reports ~7 GB free when the pool is sized — must be 1 worker
    # so two concurrent clone jobs can't blow past VRAM (#567/#570/#571/#580+).
    assert _workers_for_free_vram(7.0) == 1
    assert _workers_for_free_vram(6.5) == 1
    # ≤10 GB stays single-worker under the 5 GB/job budget.
    assert _workers_for_free_vram(9.5) == 1


def test_larger_cards_still_parallelize():
    assert _workers_for_free_vram(11.0) == 2   # 12 GB
    assert _workers_for_free_vram(15.0) == 3   # 16 GB
    assert _workers_for_free_vram(23.0) == _GPU_WORKER_CAP  # 24 GB → capped


def test_floor_and_cap():
    # Never zero (a tiny/!-reported free figure still gets one worker)...
    assert _workers_for_free_vram(0.4) == 1
    assert _workers_for_free_vram(0.0) == 1
    # ...and never above the cap, however large the card.
    assert _workers_for_free_vram(256.0) == _GPU_WORKER_CAP


def test_budget_is_conservative_enough_for_the_asr_coload():
    # Guard the constant itself: the co-loaded WhisperX large-v3 (~3 GB) plus
    # TTS (~1.6 GB) means a concurrent clone job needs ~5 GB; a regression back
    # toward 2.5 GB would re-enable the 2-worker-on-8 GB crash.
    assert _GPU_VRAM_PER_JOB_GB >= 5.0
