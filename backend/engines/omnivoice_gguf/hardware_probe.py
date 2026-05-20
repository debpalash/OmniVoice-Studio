"""Hardware probe for OmniVoice GGUF quant selection (GGUF-01).

Extends ``backend/services/gpu_sandbox.py``'s existing
CUDA / MPS / ROCm / CPU detection with VRAM bucketing so the
``OmniVoiceGGUFBackend`` can pick the right quant from
``quant_map.json``.

Thresholds are deliberately conservative — see
``.planning/phases/04-adaptive-specialty-engines-spike-first/04-RESEARCH.md``
§"Hardware probe extension" (Pitfall 2). The "default Q8_0 once you have
~1 GB of free VRAM" rule means we step up to Q8_0 at the 4 GB total-VRAM
mark, not at the 1 GB free-VRAM mark — Q8_0 itself uses ~945 MB at runtime
and we want headroom for the rest of the app.

Public surface:
    ComputeClass            — Literal["cpu", "low-vram", "mid-vram", "high-vram"]
    HardwareCapabilities    — frozen dataclass with backend + vram_mb + compute_class
    detect_capabilities()   — runs the probe, returns a HardwareCapabilities

The probe MUST be cheap (no model loads, no CUDA kernel launches) so it
can run at app startup without slowing the cold-start path. Everything
in this module sticks to ``torch.cuda.mem_get_info`` (a CUDA driver
call, not a kernel), ``torch.backends.mps.is_available`` (a constant
check), and ``psutil.virtual_memory`` (a sysctl).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ComputeClass = Literal["cpu", "low-vram", "mid-vram", "high-vram"]


@dataclass(frozen=True)
class HardwareCapabilities:
    """Snapshot of the host's compute capability at the moment of probe.

    Attributes:
        backend: one of {"cuda", "mps", "rocm", "cpu"}. Identifies the
            accelerator family — quant selection itself uses
            ``compute_class`` (a bucketing of ``vram_mb``), not this.
        vram_mb: total VRAM in mebibytes for CUDA; for MPS this is half
            of system RAM (unified-memory bookkeeping per A4 in
            RESEARCH.md); 0 for CPU-only hosts.
        compute_class: bucket the host falls into. The
            ``quant_map.json`` table is keyed by this value.
    """

    backend: Literal["cuda", "mps", "rocm", "cpu"]
    vram_mb: int
    compute_class: ComputeClass


def _bucket(vram_mb: int) -> ComputeClass:
    """Bucket VRAM into the compute class used by ``quant_map.json``.

    Thresholds (mebibytes):
        ≥ 12_000 → "high-vram"   (~12 GB)
        ≥  4_000 → "mid-vram"    (~4 GB)
        ≥  1_000 → "low-vram"    (~1 GB)
        otherwise → "cpu"        (CPU-only fallback)
    """
    if vram_mb >= 12_000:
        return "high-vram"
    if vram_mb >= 4_000:
        return "mid-vram"
    if vram_mb >= 1_000:
        return "low-vram"
    return "cpu"


def detect_capabilities() -> HardwareCapabilities:
    """Probe the current host and return its compute capabilities.

    Cheap and side-effect free — no model loads, no kernel launches.
    Safe to call multiple times (the result is a new dataclass each
    time, but the underlying probes are themselves idempotent).

    Order of probes:
        1. ``torch.cuda.is_available()`` → "cuda" with total VRAM from
           ``torch.cuda.mem_get_info()``. (ROCm presents as CUDA via
           HIP — we tag as "cuda" since the user-facing distinction is
           by VRAM, not by silicon.)
        2. ``torch.backends.mps.is_available()`` → "mps" with half of
           system RAM. MPS unified memory means we can't query a
           dedicated VRAM pool the way we can on CUDA; the half-of-RAM
           heuristic matches what Apple uses for its own MPS budget
           recommendations.
        3. Otherwise → "cpu" with vram_mb=0.
    """
    # Import torch lazily so this module is importable even in environments
    # where torch isn't installed (e.g. doc-build CI). The cost is paid
    # once per process the first time detect_capabilities() is called.
    import torch

    if torch.cuda.is_available():
        try:
            _free, total = torch.cuda.mem_get_info()
            vram_mb = int(total // (1024 * 1024))
        except Exception:
            # Some driver/CUDA combinations refuse mem_get_info on
            # secondary devices. Fall back to device_count * 0 — we'd
            # rather report low-vram and degrade gracefully than crash
            # the probe.
            vram_mb = 0
        return HardwareCapabilities(
            backend="cuda",
            vram_mb=vram_mb,
            compute_class=_bucket(vram_mb),
        )

    if torch.backends.mps.is_available():
        # Lazy psutil import — only Apple Silicon hosts pay this cost.
        import psutil

        ram_mb = int(psutil.virtual_memory().total // (1024 * 1024))
        vram_mb = ram_mb // 2  # unified-memory ceiling
        return HardwareCapabilities(
            backend="mps",
            vram_mb=vram_mb,
            compute_class=_bucket(vram_mb),
        )

    return HardwareCapabilities(backend="cpu", vram_mb=0, compute_class="cpu")


__all__ = ["ComputeClass", "HardwareCapabilities", "detect_capabilities"]
