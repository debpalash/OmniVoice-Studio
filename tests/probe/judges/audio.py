"""L4 audio judges — deterministic DSP checks on generated audio.

These are the cheapest, most stable rungs of the verification ladder and the
ones that survive the CUDA/MPS/ROCm/CPU matrix unchanged (they compare
*measurements*, never waveform bytes — there is deliberately no golden-WAV
comparison here; PyTorch is non-reproducible CPU-vs-GPU even with fixed seeds,
so a byte compare would manufacture platform-only regressions).

All loaders go through soundfile + numpy, which are already in the base venv.
WAV/FLAC/OGG decode natively; MP3 depends on the host libsndfile build.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

import numpy as np

from ..spec import JudgeResult


@dataclass(frozen=True)
class AudioStats:
    """Cheap, device-stable measurements of a decoded signal."""

    path: str
    sample_rate: int
    n_frames: int
    n_channels: int
    duration_s: float
    peak: float          # max |sample|, 0..1+ (clipping shows as ~1.0)
    rms_dbfs: float      # full-scale RMS in dBFS; -inf for digital silence
    has_nan: bool


def load_mono(path: str) -> tuple[np.ndarray, int]:
    """Decode ``path`` to a float32 mono signal in [-1, 1] and its sample rate."""
    import soundfile as sf

    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)  # downmix; correctness checks don't need channels
    return mono, int(sr)


def measure(path: str) -> AudioStats:
    """Decode once and compute every cheap stat the audio judges need."""
    import soundfile as sf

    info = sf.info(path)
    mono, sr = load_mono(path)
    has_nan = bool(np.isnan(mono).any())
    finite = mono[np.isfinite(mono)]
    peak = float(np.max(np.abs(finite))) if finite.size else 0.0
    if finite.size and np.any(finite):
        rms = float(np.sqrt(np.mean(np.square(finite))))
        rms_dbfs = 20.0 * math.log10(rms) if rms > 0 else float("-inf")
    else:
        rms_dbfs = float("-inf")
    return AudioStats(
        path=path,
        sample_rate=sr,
        n_frames=int(info.frames),
        n_channels=int(info.channels),
        duration_s=float(info.frames) / float(info.samplerate) if info.samplerate else 0.0,
        peak=peak,
        rms_dbfs=rms_dbfs,
        has_nan=has_nan,
    )


# ── individual judges ────────────────────────────────────────────────────────


def artifact_exists(path: str) -> JudgeResult:
    ok = bool(path) and os.path.isfile(path) and os.path.getsize(path) > 0
    size = os.path.getsize(path) if (path and os.path.isfile(path)) else 0
    return JudgeResult(
        name="artifact_exists",
        passed=ok,
        measured=size,
        detail=f"{path!r} exists and is non-empty ({size} bytes)"
        if ok
        else f"{path!r} missing or empty",
    )


def decodes(path: str) -> JudgeResult:
    try:
        st = measure(path)
        return JudgeResult(
            name="decodes",
            passed=True,
            measured=st.n_frames,
            detail=f"decoded {st.n_frames} frames @ {st.sample_rate} Hz",
        )
    except Exception as exc:  # noqa: BLE001 - any decode failure is a fail
        return JudgeResult(name="decodes", passed=False, detail=f"decode failed: {exc}")


def sample_rate_eq(path: str, expected: int) -> JudgeResult:
    st = measure(path)
    return JudgeResult(
        name="sample_rate_eq",
        passed=st.sample_rate == int(expected),
        measured=st.sample_rate,
        detail=f"sample_rate={st.sample_rate} (expected {expected})",
    )


def duration_between(path: str, lo: float, hi: float) -> JudgeResult:
    st = measure(path)
    ok = float(lo) <= st.duration_s <= float(hi)
    return JudgeResult(
        name="duration_between",
        passed=ok,
        measured=round(st.duration_s, 4),
        detail=f"duration={st.duration_s:.3f}s, expected [{lo}, {hi}]"
        + ("" if ok else " — truncation / runaway / silence?"),
    )


def not_silent(path: str, rms_floor_db: float = -45.0) -> JudgeResult:
    """Fail digital silence and near-silence (the classic 'it generated *something*
    but it's empty' failure)."""
    st = measure(path)
    floor = float(rms_floor_db)
    ok = st.rms_dbfs > floor
    shown = "-inf" if st.rms_dbfs == float("-inf") else f"{st.rms_dbfs:.1f}"
    return JudgeResult(
        name="not_silent",
        passed=ok,
        measured=None if st.rms_dbfs == float("-inf") else round(st.rms_dbfs, 2),
        detail=f"rms={shown} dBFS, floor={floor} dBFS",
    )


def not_clipping(path: str, peak_ceiling: float = 0.999) -> JudgeResult:
    st = measure(path)
    ok = st.peak <= float(peak_ceiling)
    return JudgeResult(
        name="not_clipping",
        passed=ok,
        measured=round(st.peak, 5),
        detail=f"peak={st.peak:.5f}, ceiling={peak_ceiling}",
    )


def no_nan(path: str) -> JudgeResult:
    st = measure(path)
    return JudgeResult(
        name="no_nan",
        passed=not st.has_nan,
        measured=st.has_nan,
        detail="signal contains NaN/inf" if st.has_nan else "signal is finite",
    )
