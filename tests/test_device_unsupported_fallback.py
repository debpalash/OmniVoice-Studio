"""#756: a GPU whose compute capability isn't in the installed PyTorch build's
arch list can't launch CUDA kernels ("no kernel image is available for
execution"), so every generate 500s. get_best_device() must fall back to CPU so
the app still works (slowly) instead of dead-ending — unless the user explicitly
forces CUDA. These tests pin that fallback (and the override) without a GPU.
"""
from types import SimpleNamespace

import pytest

import services.model_manager as mm


@pytest.fixture
def cuda_host(monkeypatch):
    # Pretend a CUDA GPU is present. Patch detect_host_caps via its string path so
    # the lookup resolves the same module object get_best_device imports locally
    # (`from core.device_caps import detect_host_caps`) — patching an aliased
    # import can miss that in a full-suite run.
    monkeypatch.setattr(
        "core.device_caps.detect_host_caps", lambda: SimpleNamespace(family="cuda")
    )
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
        mm, "check_device_compatibility", lambda: (False, "unsupported arch"),
    )
    monkeypatch.setenv("OMNIVOICE_FORCE_CUDA", "1")
    assert mm.get_best_device() == "cuda"
