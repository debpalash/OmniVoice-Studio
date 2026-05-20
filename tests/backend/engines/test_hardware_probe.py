"""Unit tests for backend/engines/omnivoice_gguf/hardware_probe.py (GGUF-01).

Covers the five behaviour bullets from Plan 04-01 Task 1:

  1. CUDA + 16 GB VRAM → compute_class="high-vram"
  2. CUDA + 4 GB VRAM  → compute_class="mid-vram"
  3. CUDA + 1.5 GB VRAM → compute_class="low-vram"
  4. MPS → uses psutil.virtual_memory().total // 2 as effective VRAM ceiling
  5. CPU-only → backend="cpu", vram_mb=0, compute_class="cpu"

Plus a re-export check so callers can keep importing
``detect_capabilities`` from either ``engines.omnivoice_gguf.hardware_probe``
or ``services.gpu_sandbox`` (per the "single entry point" decision in
RESEARCH.md "Architectural Responsibility Map").
"""
from __future__ import annotations

from unittest.mock import patch


def _make_torch_mock(*, cuda_available=False, total_vram_bytes=0, mps_available=False):
    """Build a torch-module mock with controllable cuda / mps shape."""
    import types

    cuda = types.SimpleNamespace(
        is_available=lambda: cuda_available,
        mem_get_info=lambda: (total_vram_bytes // 2, total_vram_bytes),
    )

    mps = types.SimpleNamespace(is_available=lambda: mps_available)
    backends = types.SimpleNamespace(mps=mps)

    return types.SimpleNamespace(cuda=cuda, backends=backends)


def test_cuda_16gb_returns_high_vram():
    from engines.omnivoice_gguf import hardware_probe

    fake_torch = _make_torch_mock(
        cuda_available=True,
        total_vram_bytes=16 * 1024 * 1024 * 1024,
    )
    with patch.dict("sys.modules", {"torch": fake_torch}):
        caps = hardware_probe.detect_capabilities()
    assert caps.backend == "cuda"
    assert caps.vram_mb == 16 * 1024
    assert caps.compute_class == "high-vram"


def test_cuda_4gb_returns_mid_vram():
    from engines.omnivoice_gguf import hardware_probe

    fake_torch = _make_torch_mock(
        cuda_available=True,
        total_vram_bytes=4 * 1024 * 1024 * 1024,
    )
    with patch.dict("sys.modules", {"torch": fake_torch}):
        caps = hardware_probe.detect_capabilities()
    assert caps.backend == "cuda"
    assert caps.vram_mb == 4 * 1024
    assert caps.compute_class == "mid-vram"


def test_cuda_1_5gb_returns_low_vram():
    from engines.omnivoice_gguf import hardware_probe

    fake_torch = _make_torch_mock(
        cuda_available=True,
        # 1.5 GB → 1536 MB ≥ 1000 threshold but < 4000.
        total_vram_bytes=int(1.5 * 1024 * 1024 * 1024),
    )
    with patch.dict("sys.modules", {"torch": fake_torch}):
        caps = hardware_probe.detect_capabilities()
    assert caps.backend == "cuda"
    assert caps.vram_mb == 1536
    assert caps.compute_class == "low-vram"


def test_mps_uses_half_of_system_ram_as_ceiling():
    """MPS unified memory: effective ceiling is half of system RAM."""
    from engines.omnivoice_gguf import hardware_probe
    import types

    fake_torch = _make_torch_mock(mps_available=True)

    # 32 GB system RAM → 16 GB effective MPS VRAM → high-vram bucket.
    fake_vmem = types.SimpleNamespace(total=32 * 1024 * 1024 * 1024)
    fake_psutil = types.SimpleNamespace(virtual_memory=lambda: fake_vmem)

    with patch.dict("sys.modules", {"torch": fake_torch, "psutil": fake_psutil}):
        caps = hardware_probe.detect_capabilities()
    assert caps.backend == "mps"
    assert caps.vram_mb == 16 * 1024
    assert caps.compute_class == "high-vram"


def test_cpu_only_returns_cpu_class():
    from engines.omnivoice_gguf import hardware_probe

    fake_torch = _make_torch_mock(cuda_available=False, mps_available=False)
    with patch.dict("sys.modules", {"torch": fake_torch}):
        caps = hardware_probe.detect_capabilities()
    assert caps.backend == "cpu"
    assert caps.vram_mb == 0
    assert caps.compute_class == "cpu"


def test_bucket_thresholds_directly():
    from engines.omnivoice_gguf.hardware_probe import _bucket

    assert _bucket(0) == "cpu"
    assert _bucket(999) == "cpu"
    assert _bucket(1_000) == "low-vram"
    assert _bucket(3_999) == "low-vram"
    assert _bucket(4_000) == "mid-vram"
    assert _bucket(11_999) == "mid-vram"
    assert _bucket(12_000) == "high-vram"
    assert _bucket(80_000) == "high-vram"


def test_detect_capabilities_reexported_from_gpu_sandbox():
    """Single-entry-point invariant: services.gpu_sandbox.detect_capabilities
    must resolve to the same function exported from
    engines.omnivoice_gguf.hardware_probe (per RESEARCH.md
    "Architectural Responsibility Map")."""
    from services import gpu_sandbox
    from engines.omnivoice_gguf import hardware_probe

    assert gpu_sandbox.detect_capabilities is hardware_probe.detect_capabilities
    assert gpu_sandbox.HardwareCapabilities is hardware_probe.HardwareCapabilities
    assert gpu_sandbox.ComputeClass is hardware_probe.ComputeClass
