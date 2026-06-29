"""#756: a GPU whose compute capability isn't in the installed PyTorch build's
arch list can't launch CUDA kernels ("no kernel image is available for
execution"), so every generate 500s. get_best_device() must fall back to CPU so
the app still works (slowly) instead of dead-ending — unless the user explicitly
forces CUDA. These tests pin that fallback (and the override) without a GPU.
"""
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import core.device_caps as _caps  # noqa: E402
import services.model_manager as mm  # noqa: E402


@pytest.fixture
def cuda_host(monkeypatch):
    # Pretend a CUDA GPU is present and the rocm config step is a no-op.
    monkeypatch.setattr(_caps, "detect_host_caps", lambda: SimpleNamespace(family="cuda"))
    monkeypatch.setattr(mm, "_lazy_torch", lambda: SimpleNamespace())
    monkeypatch.setattr(mm, "_configure_rocm_if_needed", lambda _torch: None)
    monkeypatch.delenv("OMNIVOICE_FORCE_CUDA", raising=False)


def test_unsupported_gpu_falls_back_to_cpu(cuda_host, monkeypatch):
    monkeypatch.setattr(
        mm, "check_device_compatibility",
        lambda: (False, "GTX 1080 Ti (sm_61) is not supported by this PyTorch build"),
    )
    assert mm.get_best_device() == "cpu"


def test_supported_gpu_stays_on_cuda(cuda_host, monkeypatch):
    monkeypatch.setattr(mm, "check_device_compatibility", lambda: (True, None))
    assert mm.get_best_device() == "cuda"


def test_force_cuda_overrides_the_fallback(cuda_host, monkeypatch):
    monkeypatch.setattr(
        mm, "check_device_compatibility",
        lambda: (False, "unsupported arch"),
    )
    monkeypatch.setenv("OMNIVOICE_FORCE_CUDA", "1")
    assert mm.get_best_device() == "cuda"
