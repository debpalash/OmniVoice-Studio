"""Canonical host compute-capability probe — the single source of truth for
"what can this machine actually accelerate on."

Every routing decision (the engine compatibility matrix, ``/setup/preflight``,
``/system/diagnose``, and the synth-time no-silent-fallback gating) reads from
``detect_host_caps()`` so the probe and the model loader can never disagree.

Design contract (load-bearing):
  - **Never raises** to a caller. A broken torch / driver crash degrades to a
    cached CPU-only ``probe_ok=False`` result; every endpoint stays responsive
    (local-first: the app must work with no GPU and even with a broken torch).
  - **No network call** — driver/sysctl reads only, no tensor allocation, so it
    stays kernel-free on cold start.
  - **No new regex** on any driver/device string (CodeQL py/polynomial-redos):
    the only string parse is the ``int(driver.split(".")[0])`` shape reused
    from the wizard, and arch comparison is plain list membership.
  - Distinguishes **ROCm from CUDA** (unlike the gguf ``hardware_probe``):
    ROCm-on-HIP presents through ``torch.cuda`` but is reported ``family="rocm"``.

The ``get_best_device()`` loader (``services.model_manager``) delegates its
*family* decision here while keeping its own DirectML branch and the ROCm
``HSA_OVERRIDE_GFX_VERSION`` env side-effect — the probe **reads**, the loader
**writes**. (The gguf ``hardware_probe.detect_capabilities()`` rebase onto this
module is a deliberate follow-up: it has its own torch-mocked test suite and a
VRAM-driven quant table that is unaffected by the family rename, so it is kept
out of this backend-only slice.)
"""
from __future__ import annotations

import functools
import platform as _platform
import sys
from dataclasses import dataclass
from typing import Literal

DeviceFamily = Literal["cuda", "rocm", "mps", "xpu", "cpu"]

# Stable substring stamped onto notes that represent a real kernel-launch risk
# (arch/driver mismatch) — as opposed to advisory notes (multi-GPU, VRAM query
# failed, DirectML present). ``engine_routing`` keys the "accelerated, but…"
# caveat off this marker so advisory notes never downgrade an accelerated badge.
KERNEL_RISK_MARKER = "may fail at kernel launch"

# Substring marking a DirectML-present (Windows GPU) host. The probe reports
# such hosts as ``family="cpu"`` (DirectML is not a torch device family); the
# router reads this marker to explain the neutral badge instead of "no GPU".
DIRECTML_MARKER = "DirectML device present"

# Mirrors ``wizard._MIN_NVIDIA_DRIVER`` — the minimum NVIDIA driver the bundled
# CUDA 12.8 runtime needs. Duplicated (not imported) to keep this module free of
# any dependency on the API/router layer.
_MIN_NVIDIA_DRIVER = 555


@dataclass(frozen=True)
class HostCaps:
    """Snapshot of the host's accelerator capability. Immutable + cached."""

    family: DeviceFamily
    """Best available accelerator family, else ``"cpu"``."""

    available_families: tuple[DeviceFamily, ...]
    """Everything usable; **always includes** ``"cpu"`` (invariant)."""

    device_name: str = ""
    """Device 0's name, e.g. ``"NVIDIA RTX 4090"`` / ``"Apple Silicon (MPS)"``."""

    vram_gb: float = 0.0
    """CUDA/ROCm total VRAM in GB; MPS = system RAM / 2; 0 for cpu/xpu."""

    driver: str | None = None
    """Raw ROCm HIP version string (``torch.version.hip``) or ``None``. The
    NVIDIA driver-version check is owned by ``wizard._detect_gpu`` (it already
    shells to ``nvidia-smi``); the probe stays subprocess-free."""

    notes: tuple[str, ...] = ()
    """Author-controlled English advisories (never user input). Empty on a
    clean accelerated host."""

    probe_ok: bool = True
    """``False`` only when torch could not be imported (degraded CPU-only)."""


def _probe() -> HostCaps:
    """Run the probe once. Enumerates every failure branch from the spec's
    degradation contract; never raises."""
    try:
        import torch
    except Exception:
        return HostCaps(
            family="cpu",
            available_families=("cpu",),
            notes=("torch not importable; treating host as CPU-only",),
            probe_ok=False,
        )

    notes: list[str] = []
    family: DeviceFamily = "cpu"
    device_name = ""
    vram_gb = 0.0
    driver: str | None = None

    # ── CUDA / ROCm (both present through torch.cuda) ────────────────────
    cuda_ok = False
    try:
        cuda_ok = bool(torch.cuda.is_available())
    except Exception as exc:  # broken CUDA init (forked process / driver crash)
        notes.append(f"CUDA init raised: {type(exc).__name__}")

    if cuda_ok:
        try:
            count = int(torch.cuda.device_count())
        except Exception:
            count = 0
        if count == 0:
            notes.append("CUDA reports available but device_count==0")
        else:
            is_rocm = getattr(torch.version, "hip", None) is not None
            family = "rocm" if is_rocm else "cuda"
            if is_rocm:
                driver = getattr(torch.version, "hip", None)
            if count > 1:
                notes.append(f"{count} GPUs detected; routing reflects device 0")
            try:
                device_name = torch.cuda.get_device_name(0)
            except Exception:
                device_name = ""
            try:
                _free, total = torch.cuda.mem_get_info()
                vram_gb = float(total) / (1024 ** 3)
            except Exception:
                notes.append("VRAM query failed")
            # SM-arch mismatch (mirrors model_manager.check_device_compatibility).
            try:
                major, minor = torch.cuda.get_device_capability(0)
                arch_list = getattr(torch.cuda, "_get_arch_list", lambda: [])()
                if arch_list:
                    sm_tag = f"sm_{major}{minor}"
                    compute_tag = f"compute_{major}{minor}"
                    if sm_tag not in arch_list and compute_tag not in arch_list:
                        notes.append(
                            f"{device_name or 'GPU'} ({sm_tag}) not in this torch "
                            f"build's archs ({', '.join(arch_list)}) — "
                            f"{KERNEL_RISK_MARKER}"
                        )
            except Exception:
                pass

    # ── Intel XPU via IPEX ───────────────────────────────────────────────
    if family == "cpu":
        try:
            import intel_extension_for_pytorch  # noqa: F401
            if hasattr(torch, "xpu") and torch.xpu.is_available():
                family = "xpu"
                try:
                    device_name = torch.xpu.get_device_name(0)
                except Exception:
                    pass
                notes.append("XPU VRAM not queried (unreliable across IPEX versions)")
        except Exception:
            pass

    # ── Apple Silicon MPS ────────────────────────────────────────────────
    if family == "cpu":
        try:
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                family = "mps"
                device_name = device_name or "Apple Silicon (MPS)"
                try:
                    import psutil
                    vram_gb = float(psutil.virtual_memory().total) / (1024 ** 3) / 2
                except Exception:
                    notes.append("psutil unavailable; MPS VRAM unknown")
        except Exception:
            pass

    # ── DirectML — Windows GPU, NOT a torch device family ────────────────
    if family == "cpu":
        try:
            import torch_directml
            if torch_directml.device_count() > 0:
                notes.append(
                    f"{DIRECTML_MARKER} (Windows GPU); torch-family probe treats "
                    f"as non-accelerated"
                )
        except Exception:
            pass

    available: tuple[DeviceFamily, ...] = (
        (family, "cpu") if family != "cpu" else ("cpu",)
    )
    return HostCaps(
        family=family,
        available_families=available,
        device_name=device_name,
        vram_gb=vram_gb,
        driver=driver,
        notes=tuple(notes),
        probe_ok=True,
    )


@functools.lru_cache(maxsize=1)
def detect_host_caps() -> HostCaps:
    """Cached per-process host capabilities. Never raises, makes no network
    call, kernel-free on cold start. Host compute capability does not change at
    runtime in any supported desktop flow (no GPU hot-plug; switching the active
    engine does not re-probe — routing is recomputed from these same caps), so
    a single probe per process is correct. ``probe_ok=False`` is cached too."""
    return _probe()


def refresh() -> HostCaps:
    """Clear the cache and re-probe. **TEST-ONLY** — nothing in the running app
    calls this (host caps are immutable per process)."""
    detect_host_caps.cache_clear()
    return detect_host_caps()


def mlx_supported() -> tuple[bool, str]:
    """``(ok, reason)``. ``ok=True`` **only** on Apple Silicon
    (``sys.platform == "darwin"`` and ``platform.machine() == "arm64"``) with
    torch MPS available — the shared gate for MLX-Audio / MLX-Whisper (#390).

    Gates on exact-string equality (no regex → no CodeQL surface). On any
    non-Apple host it returns ``False`` **before** any package import, so a
    stray ``mlx_*`` wheel on Linux/Windows never reports available.
    """
    if sys.platform != "darwin" or _platform.machine() != "arm64":
        if sys.platform == "darwin":
            return (False, "MLX requires Apple Silicon; this Mac is Intel")
        return (
            False,
            f"MLX requires Apple Silicon; this host is "
            f"{sys.platform}/{_platform.machine()}",
        )
    try:
        import torch
    except Exception:
        return (False, "torch not importable; cannot confirm MPS")
    try:
        if torch.backends.mps.is_available():
            return (True, "")
    except Exception:
        pass
    return (
        False,
        "Apple Silicon detected but torch MPS unavailable; "
        "reinstall torch with MPS support",
    )


__all__ = [
    "DeviceFamily",
    "HostCaps",
    "detect_host_caps",
    "refresh",
    "mlx_supported",
    "KERNEL_RISK_MARKER",
    "DIRECTML_MARKER",
]
