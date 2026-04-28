"""First-run wizard endpoints — status, preflight, and warmup.

Extracted from the monolithic ``setup.py``.

- ``GET /setup/status``       — missing-model gate for boot screen
- ``GET /setup/preflight``    — system health check (OS, RAM, GPU, ffmpeg…)
- ``POST /setup/warmup``      — background model pre-load
"""
from __future__ import annotations

import asyncio
import logging
import os
import platform as _platform
import shutil as _shutil
import sys

from fastapi import APIRouter

from api.schemas import SetupStatusResponse, PreflightResponse
from .models import REQUIRED_MODELS, hf_cache_dir, is_cached

logger = logging.getLogger("omnivoice.setup.wizard")
router = APIRouter()

MIN_FREE_GB = 10


def _disk_free_gb(path: str) -> float:
    """Return free GB on the volume containing *path*.

    If *path* doesn't exist yet (e.g. after a fresh wipe), walk up to the
    nearest existing ancestor so ``shutil.disk_usage`` can still probe the
    correct mount point.
    """
    try:
        from pathlib import Path
        p = Path(path).resolve()
        # Walk up until we find a directory that exists
        while not p.exists():
            parent = p.parent
            if parent == p:  # root
                break
            p = parent
        return _shutil.disk_usage(str(p)).free / (1024 ** 3)
    except Exception:
        return 0.0


# ── Setup Status ───────────────────────────────────────────────────────────

@router.get("/setup/status", response_model=SetupStatusResponse)
def setup_status():
    """Snapshot the setup state so the client can pick its boot screen."""
    missing = [
        {"repo_id": rid, "label": label}
        for (rid, label) in REQUIRED_MODELS
        if not is_cached(rid)
    ]
    cache = hf_cache_dir()
    free_gb = _disk_free_gb(cache)
    return {
        "models_ready": len(missing) == 0,
        "missing": missing,
        "hf_cache_dir": cache,
        "disk_free_gb": round(free_gb, 2),
        "min_free_gb": MIN_FREE_GB,
        "enough_disk": free_gb >= MIN_FREE_GB,
    }


# ── Pre-flight System Check ───────────────────────────────────────────────

_MIN_NVIDIA_DRIVER = 555
_RAM_FAIL_GB = 8
_RAM_WARN_GB = 12


def _run_cmd(args: list[str], timeout: float = 2.0) -> tuple[int, str]:
    """Run a subprocess synchronously with a short timeout."""
    import subprocess
    try:
        out = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False,
        )
        return out.returncode, out.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return -1, ""


def _detect_gpu() -> dict:
    """Best-effort detection of GPU vendor + driver + compute backend."""
    info = {
        "vendor": "none", "driver": None, "device_name": None,
        "backend": "cpu", "available": False, "notes": [],
    }

    # Apple Silicon → MPS
    if sys.platform == "darwin" and _platform.machine() == "arm64":
        info["vendor"] = "apple"
        info["backend"] = "mps"
        info["device_name"] = "Apple Silicon GPU (Metal)"
        try:
            import torch
            info["available"] = bool(torch.backends.mps.is_available())
        except Exception:
            info["available"] = False
        return info

    # NVIDIA
    rc, out = _run_cmd([
        "nvidia-smi",
        "--query-gpu=driver_version,name",
        "--format=csv,noheader",
    ])
    if rc == 0 and out.strip():
        line = out.strip().splitlines()[0]
        parts = [p.strip() for p in line.split(",")]
        driver = parts[0] if parts else None
        name = parts[1] if len(parts) > 1 else None
        info.update({"vendor": "nvidia", "driver": driver, "device_name": name})
        try:
            import torch
            info["available"] = bool(torch.cuda.is_available())
            info["backend"] = "cuda" if info["available"] else "cpu"
        except Exception:
            pass
        try:
            major = int((driver or "0").split(".")[0])
            if major < _MIN_NVIDIA_DRIVER:
                info["notes"].append(
                    f"NVIDIA driver {driver} below {_MIN_NVIDIA_DRIVER} required "
                    f"by the bundled CUDA 12.8 runtime — GPU will fail to launch "
                    f"kernels. Update drivers before dubbing."
                )
                info["available"] = False
        except Exception:
            pass
        return info

    # AMD
    rc, out = _run_cmd(["rocm-smi", "--showproductname"])
    if rc == 0 and out.strip():
        info["vendor"] = "amd"
        info["device_name"] = out.strip().splitlines()[0][:120]
        try:
            import torch
            has_hip = getattr(torch.version, "hip", None) is not None
            if has_hip and torch.cuda.is_available():
                info["backend"] = "rocm"
                info["available"] = True
            else:
                info["backend"] = "cpu"
                info["notes"].append(
                    "AMD GPU detected but torch was installed with CUDA wheels. "
                    "Re-run `uv sync --index-url https://download.pytorch.org/whl/rocm6.1` "
                    "to enable ROCm acceleration."
                )
        except Exception:
            info["notes"].append("AMD GPU detected but torch not importable.")
        return info

    # Fallback
    try:
        import torch
        if torch.cuda.is_available():
            info["vendor"] = "unknown"
            info["backend"] = "cuda"
            info["available"] = True
            info["notes"].append(
                "torch.cuda.is_available() is True but no nvidia-smi/rocm-smi "
                "found — running through WSL or virtual GPU?"
            )
    except Exception:
        pass
    return info


def _probe_network(host: str = "huggingface.co", timeout: float = 2.0) -> bool:
    """Tiny TCP connect test."""
    import socket
    try:
        with socket.create_connection((host, 443), timeout=timeout):
            return True
    except Exception:
        return False


def _ram_gb() -> float:
    try:
        import psutil
        return psutil.virtual_memory().total / (1024 ** 3)
    except Exception:
        return 0.0


@router.get("/setup/preflight", response_model=PreflightResponse)
def preflight():
    """One-shot system health check for the wizard."""
    checks: list[dict] = []

    # ── OS + arch
    arch = _platform.machine()
    os_ver = _platform.platform(terse=True)
    checks.append({
        "id": "os", "label": "Operating system", "status": "pass",
        "detail": f"{os_ver} ({arch})", "fix": None,
    })

    # ── Python runtime
    checks.append({
        "id": "python", "label": "Python runtime", "status": "pass",
        "detail": f"Python {sys.version.split()[0]}", "fix": None,
    })

    # ── RAM
    ram = _ram_gb()
    if ram == 0:
        ram_status, ram_detail, ram_fix = (
            "warn", "Could not detect system RAM.",
            "Install psutil in the backend environment or ignore this warning.",
        )
    elif ram < _RAM_FAIL_GB:
        ram_status, ram_detail, ram_fix = (
            "fail", f"{ram:.1f} GB total (need ≥ {_RAM_FAIL_GB} GB)",
            "The app will OOM on first dub. Close other apps or upgrade RAM.",
        )
    elif ram < _RAM_WARN_GB:
        ram_status, ram_detail, ram_fix = (
            "warn", f"{ram:.1f} GB total ({_RAM_WARN_GB}+ GB recommended)",
            "Long videos may hit swap. Keep other apps closed during dubbing.",
        )
    else:
        ram_status, ram_detail, ram_fix = ("pass", f"{ram:.1f} GB total", None)
    checks.append({
        "id": "ram", "label": "System RAM", "status": ram_status,
        "detail": ram_detail, "fix": ram_fix,
    })

    # ── Disk free
    cache = hf_cache_dir()
    free = _disk_free_gb(cache)
    if free < MIN_FREE_GB:
        disk = {
            "status": "fail",
            "detail": f"{free:.1f} GB free at {cache} (need ≥ {MIN_FREE_GB} GB)",
            "fix": f"Free up disk space or set HF_HOME to a larger partition.",
        }
    else:
        disk = {"status": "pass", "detail": f"{free:.1f} GB free at {cache}", "fix": None}
    checks.append({"id": "disk", **{"label": "Disk space", **disk}})

    # ── HF cache writable
    try:
        os.makedirs(cache, exist_ok=True)
        writable = os.access(cache, os.W_OK)
    except Exception:
        writable = False
    checks.append({
        "id": "hf_cache_writable", "label": "HuggingFace cache writable",
        "status": "pass" if writable else "fail",
        "detail": cache,
        "fix": None if writable else
            f"Fix write permissions on {cache} or point HF_HOME elsewhere.",
    })

    # ── FFmpeg
    ffmpeg_path = None
    try:
        from services.ffmpeg_utils import find_ffmpeg
        ffmpeg_path = find_ffmpeg()
    except Exception as e:
        checks.append({
            "id": "ffmpeg", "label": "FFmpeg", "status": "fail",
            "detail": str(e)[:200],
            "fix": "Install ffmpeg via your package manager "
                   "(brew install ffmpeg / apt install ffmpeg / choco install ffmpeg).",
        })
    else:
        checks.append({
            "id": "ffmpeg", "label": "FFmpeg", "status": "pass",
            "detail": ffmpeg_path, "fix": None,
        })

    # ── FFprobe
    ffprobe_path = None
    if ffmpeg_path:
        candidate = ffmpeg_path.replace("ffmpeg", "ffprobe")
        if os.path.exists(candidate):
            ffprobe_path = candidate
        else:
            system_probe = _shutil.which("ffprobe")
            if system_probe:
                ffprobe_path = system_probe
    if ffprobe_path:
        checks.append({
            "id": "ffprobe", "label": "FFprobe", "status": "pass",
            "detail": ffprobe_path, "fix": None,
        })
    else:
        checks.append({
            "id": "ffprobe", "label": "FFprobe", "status": "warn",
            "detail": "Not bundled alongside ffmpeg.",
            "fix": "File-probe endpoint (/tools/probe) will 501. "
                   "Install system ffmpeg (includes ffprobe) to enable it.",
        })

    # ── yt-dlp
    yt_dlp_path = _shutil.which("yt-dlp")
    if yt_dlp_path:
        rc_ytv, yt_ver = _run_cmd([yt_dlp_path, "--version"], timeout=3.0)
        yt_version = yt_ver.strip() if rc_ytv == 0 else "unknown"
        checks.append({
            "id": "yt-dlp", "label": "yt-dlp", "status": "pass",
            "detail": f"{yt_dlp_path} (v{yt_version})", "fix": None,
        })
    else:
        checks.append({
            "id": "yt-dlp", "label": "yt-dlp", "status": "warn",
            "detail": "Not found in system PATH.",
            "fix": "YouTube clip downloads in Voice Gallery will fail. Download the standalone binary from https://github.com/yt-dlp/yt-dlp/releases and place it in your PATH.",
        })

    # ── GPU
    gpu = _detect_gpu()
    if gpu["vendor"] == "apple" and gpu["available"]:
        gpu_status, gpu_fix = "pass", None
        gpu_detail = f"{gpu['device_name']} — Metal (MPS) ready"
    elif gpu["vendor"] == "nvidia" and gpu["available"]:
        gpu_status, gpu_fix = "pass", None
        gpu_detail = f"{gpu['device_name']} (driver {gpu['driver']}) — CUDA ready"
    elif gpu["vendor"] == "nvidia" and not gpu["available"]:
        gpu_status = "fail"
        gpu_detail = (
            f"{gpu['device_name']} found but CUDA not usable "
            f"(driver {gpu['driver']}). " + " ".join(gpu["notes"])
        )
        gpu_fix = (
            f"Update NVIDIA drivers to ≥ R{_MIN_NVIDIA_DRIVER} "
            "(https://www.nvidia.com/Download/index.aspx). Or run CPU-only "
            "by continuing past this step — dubbing will be ~10× slower."
        )
    elif gpu["vendor"] == "amd":
        gpu_status = "warn"
        gpu_detail = (
            f"{gpu['device_name']} — ROCm "
            + ("ready" if gpu["available"] else "not configured")
        )
        gpu_fix = (
            None if gpu["available"] else
            "AMD support is experimental. Re-run `uv sync --index-url "
            "https://download.pytorch.org/whl/rocm6.1` to enable. App works "
            "on CPU otherwise (slower)."
        )
    else:
        gpu_status = "warn"
        gpu_detail = "No compatible GPU detected — running CPU-only."
        gpu_fix = (
            "Dubbing will work but ~10× slower than GPU. If you have an "
            "NVIDIA/AMD card, check drivers are installed."
        )
    checks.append({
        "id": "gpu", "label": "GPU acceleration",
        "status": gpu_status, "detail": gpu_detail, "fix": gpu_fix,
    })

    # ── Network
    net_ok = _probe_network()
    checks.append({
        "id": "network", "label": "Network (huggingface.co)",
        "status": "pass" if net_ok else "fail",
        "detail": "Reachable" if net_ok else "Unreachable on port 443",
        "fix": None if net_ok else
            "Check internet connection, VPN, or corporate firewall "
            "whitelist for huggingface.co.",
    })

    # Aggregate
    any_fail = any(c["status"] == "fail" for c in checks)
    any_warn = any(c["status"] == "warn" for c in checks)

    return {
        "ok": not any_fail,
        "has_warnings": any_warn,
        "checks": checks,
        "device": {
            "os": sys.platform,
            "arch": arch,
            "gpu_vendor": gpu["vendor"],
            "gpu_backend": gpu["backend"],
            "gpu_available": gpu["available"],
            "gpu_driver": gpu["driver"],
            "gpu_device_name": gpu["device_name"],
            "ram_gb": round(ram, 1),
            "disk_free_gb": round(free, 1),
        },
    }


# ── Warmup ─────────────────────────────────────────────────────────────────

@router.post("/setup/warmup")
async def setup_warmup():
    """Trigger a model load in the background so the first dub doesn't pay
    the cold-start tax."""
    loop = asyncio.get_event_loop()

    async def _do_warmup():
        try:
            from services.model_manager import get_model
            await get_model()
        except Exception as e:
            logger.warning("setup/warmup: model load failed: %s", e)

    loop.create_task(_do_warmup())
    return {"status": "warmup_started"}
