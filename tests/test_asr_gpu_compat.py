"""ASR backends now carry an explicit ``gpu_compat`` (mirroring TTSBackend) so
engine_routing can surface the effective device per host. Verifies the ABC
default and every subclass's declared tuple, plus the IndexTTS2 fix.

Backend classes are resolved at RUNTIME (inside each test, via the registry)
rather than imported at module scope — other suites purge ``services.*`` from
``sys.modules`` for DB isolation, which would otherwise leave this module
holding stale class objects depending on collection/run order.
"""
from __future__ import annotations

import pytest

# id → declared gpu_compat. NeMo is CUDA-only (its is_available() hard-fails
# without a GPU), so it legitimately has no cpu path.
_EXPECTED = {
    "whisperx": ("cuda", "cpu"),
    "faster-whisper": ("cuda", "cpu"),
    "mlx-whisper": ("mps", "cpu"),
    "pytorch-whisper": ("cuda", "mps", "cpu"),
    "nemo-parakeet": ("cuda",),
    "moonshine": ("cpu",),
    "funasr": ("cuda", "cpu"),
}

# Engines that legitimately have NO cpu path (hard GPU gate in is_available).
_GPU_ONLY = {"nemo-parakeet"}

_VALID = {"cuda", "rocm", "mps", "xpu", "cpu"}


def _cls(engine_id):
    from services.asr_backend import _REGISTRY
    return _REGISTRY[engine_id]


def test_abc_default_is_cpu_only():
    from services.asr_backend import ASRBackend
    assert ASRBackend.gpu_compat == ("cpu",)


@pytest.mark.parametrize("engine_id,expected", list(_EXPECTED.items()))
def test_subclass_gpu_compat(engine_id, expected):
    assert _cls(engine_id).gpu_compat == expected


@pytest.mark.parametrize("engine_id", list(_EXPECTED))
def test_compat_values_are_valid(engine_id):
    compat = _cls(engine_id).gpu_compat
    assert compat, "gpu_compat must be non-empty"
    assert set(compat) <= _VALID
    # Every engine has a cpu path EXCEPT the known hard-GPU-gated ones.
    if engine_id not in _GPU_ONLY:
        assert "cpu" in compat
    else:
        assert "cpu" not in compat  # would be a false claim — is_available gates on CUDA


def test_no_asr_engine_falsely_claims_rocm():
    # ROCm is intentionally unclaimed until verified per engine (see ABC note).
    for engine_id in _EXPECTED:
        assert "rocm" not in _cls(engine_id).gpu_compat


def test_indextts2_overrides_cpu_only_default():
    from engines.indextts import IndexTTS2Backend
    assert IndexTTS2Backend.gpu_compat == ("cuda", "cpu")
    # must NOT be the inherited TTSBackend default
    assert IndexTTS2Backend.gpu_compat != ("cpu",)
