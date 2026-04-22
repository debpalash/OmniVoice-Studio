"""First-run setup endpoints — model presence + live download progress.

`GET /setup/status` reports whether the primary model weights are cached on
disk + how much disk space remains. The frontend uses this on boot to decide
whether to show a setup wizard or the main UI.

`GET /setup/download-stream` is SSE that forwards every tqdm update emitted
by `huggingface_hub` through the monkey-patch in `utils/hf_progress`. The
frontend subscribes once and renders per-file progress bars until the wizard
completes.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import platform as _platform
import shutil
import sys
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from utils import hf_progress

logger = logging.getLogger("omnivoice.setup")
router = APIRouter()

# Minimum free disk space before we'd even attempt a full model download.
# Rough budget: ~6 GB for OmniVoice + Whisper-large-v3 + scratch; leave 4 GB
# of headroom so the machine isn't pinned on disk after install.
MIN_FREE_GB = 10

# Where HuggingFace caches downloads by default. If the user has overridden
# via HF_HOME or HUGGINGFACE_HUB_CACHE, we honour it — nothing to move.
def _hf_cache_dir() -> str:
    return (
        os.environ.get("HF_HUB_CACHE")
        or os.environ.get("HUGGINGFACE_HUB_CACHE")
        or os.environ.get("HF_HOME")
        or os.path.expanduser("~/.cache/huggingface")
    )


def _disk_free_gb(path: str) -> float:
    try:
        return shutil.disk_usage(path).free / (1024 ** 3)
    except Exception:
        return 0.0


# Every model the app knows about. `required=True` means the app doesn't
# function end-to-end without it (wizard blocks on these). `required=False`
# models are optional — ship with them uninstalled, user opts in from
# Settings > Models.
KNOWN_MODELS = [
    {
        "repo_id": "k2-fsa/OmniVoice",
        "label": "OmniVoice TTS (600+ languages, zero-shot)",
        "role": "TTS",
        "size_gb": 2.4,
        "required": True,
    },
    {
        # Cross-platform default ASR. CTranslate2-converted whisper-large-v3,
        # loads via faster-whisper (asr_backend.py:FasterWhisperBackend).
        # Works on Linux/Windows/mac-Intel/mac-ARM with no mlx dependency.
        "repo_id": "Systran/faster-whisper-large-v3",
        "label": "Whisper large-v3 (faster-whisper — default, cross-platform)",
        "role": "ASR",
        "size_gb": 2.9,
        "required": True,
    },
    {
        "repo_id": "mlx-community/whisper-large-v3-mlx",
        "label": "Whisper large-v3 (MLX — optional mac-ARM speedup)",
        "role": "ASR",
        "size_gb": 3.0,
        # Optional everywhere — only loadable on mac-ARM dev installs. The
        # frozen .app can't load mlx reliably (nanobind duplicate-registration
        # aborts on first mlx.core touch), and mlx doesn't exist on
        # Linux/Windows/mac-Intel at all. Users on a mac-ARM dev install can
        # opt in from Settings → Models for ~10-20% lower latency vs faster-
        # whisper int8 on large-v3.
        "required": False,
    },
    {
        "repo_id": "openai/whisper-large-v3",
        "label": "Whisper large-v3 (PyTorch — last-resort fallback)",
        "role": "ASR",
        "size_gb": 3.1,
        # Optional fallback. The faster-whisper repo above is the primary
        # ASR; openai/whisper-large-v3 is only needed if the user explicitly
        # picks pytorch-whisper in Settings (CUDA-heavy workflows or when
        # faster-whisper breaks on a specific host).
        "required": False,
    },
    {
        "repo_id": "mlx-community/whisper-tiny-mlx",
        "label": "Whisper tiny (MLX ASR — fast fallback)",
        "role": "ASR",
        "size_gb": 0.08,
        "required": False,
    },
    {
        "repo_id": "pyannote/speaker-diarization-3.1",
        "label": "pyannote speaker diarisation (multi-speaker videos)",
        "role": "Diarisation",
        "size_gb": 0.8,
        "required": False,
        "note": "Needs an HF_TOKEN with license accepted.",
    },
    {
        "repo_id": "OpenMOSS-Team/MOSS-TTS-Nano",
        "label": "MOSS-TTS-Nano (20 langs, CPU-realtime)",
        "role": "TTS",
        "size_gb": 0.4,
        "required": False,
    },
    {
        # Lightweight English "Turbo" TTS. Optional — the wizard doesn't
        # auto-download this; users opt in from Settings → Models when they
        # want fast English narration without voice cloning.
        "repo_id": "KittenML/kitten-tts-mini-0.8",
        "label": "KittenTTS (English, 8 preset voices, CPU realtime)",
        "role": "TTS",
        "size_gb": 0.08,
        "required": False,
    },
    # ── mlx-audio engines (mac-ARM only; opt-in from Settings → Models) ──
    # These come through backend.services.tts_backend:MLXAudioBackend. The
    # backend is only available on Apple Silicon; non-mac users never see
    # these download buttons as active because the backend is unavailable.
    {
        "repo_id": "mlx-community/Kokoro-82M-bf16",
        "label": "Kokoro 82M (8 langs, small, mlx-audio default)",
        "role": "TTS",
        "size_gb": 0.15,
        "required": False,
        "note": "Apple Silicon only — via mlx-audio backend.",
    },
    {
        "repo_id": "mlx-community/csm-1b-8bit",
        "label": "CSM 1B (voice cloning, mlx-audio)",
        "role": "TTS",
        "size_gb": 1.1,
        "required": False,
        "note": "Apple Silicon only — via mlx-audio backend.",
    },
    {
        "repo_id": "mlx-community/Qwen3-TTS-1.7B-4bit",
        "label": "Qwen3-TTS 1.7B 4bit (voice design, mlx-audio)",
        "role": "TTS",
        "size_gb": 1.4,
        "required": False,
        "note": "Apple Silicon only — via mlx-audio backend.",
    },
    {
        "repo_id": "mlx-community/Dia-1.6B",
        "label": "Dia 1.6B (expressive, mlx-audio)",
        "role": "TTS",
        "size_gb": 3.2,
        "required": False,
        "note": "Apple Silicon only — via mlx-audio backend.",
    },
    {
        "repo_id": "mlx-community/OuteTTS-0.3-500M",
        "label": "OuteTTS 0.3 500M (voice clone, mlx-audio)",
        "role": "TTS",
        "size_gb": 1.0,
        "required": False,
        "note": "Apple Silicon only — via mlx-audio backend.",
    },
]
# Back-compat tuple view for code that expects (repo_id, label) pairs.
REQUIRED_MODELS = [(m["repo_id"], m["label"]) for m in KNOWN_MODELS if m["required"]]


def _is_cached(repo_id: str) -> bool:
    """Best-effort check: does HF have this repo in its cache on disk?
    We don't validate the specific file set — presence of the repo dir is
    close enough for a first-run gate."""
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        for entry in info.repos:
            if entry.repo_id == repo_id and entry.size_on_disk > 0:
                return True
        return False
    except Exception as e:
        logger.debug("scan_cache_dir failed: %s", e)
        # Pessimistic: if we can't tell, report missing so the wizard appears
        # and the user sees progress instead of a silent hang.
        return False


@router.get("/setup/status")
def setup_status():
    """Snapshot the setup state so the client can pick its boot screen.

    Returns everything the wizard needs to decide: missing model list, disk
    headroom, HF cache path (for the user's information + "clear cache" ops).
    """
    missing = [
        {"repo_id": rid, "label": label}
        for (rid, label) in REQUIRED_MODELS
        if not _is_cached(rid)
    ]
    cache = _hf_cache_dir()
    free_gb = _disk_free_gb(cache)
    return {
        "models_ready": len(missing) == 0,
        "missing": missing,
        "hf_cache_dir": cache,
        "disk_free_gb": round(free_gb, 2),
        "min_free_gb": MIN_FREE_GB,
        "enough_disk": free_gb >= MIN_FREE_GB,
    }


@router.get("/setup/download-stream")
async def setup_download_stream():
    """SSE: forward every HuggingFace download tqdm update as a JSON event.

    The client connects on mount, then kicks a separate `POST /setup/download`
    (or invokes a normal ASR/TTS call that triggers the download). This
    endpoint stays open until the client closes it.
    """
    # Buffered queue so fast-emitting tqdm updates don't drop events on slow
    # clients. Bounded so a stuck consumer can't grow memory indefinitely.
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    loop = asyncio.get_event_loop()

    def listener(event):
        # tqdm lives on a background thread (hf's downloader). We need to
        # marshal events onto the FastAPI event loop before enqueueing.
        try:
            loop.call_soon_threadsafe(_safe_put, queue, event)
        except RuntimeError:
            # Loop closed between events — client has gone away, safe to drop.
            pass

    listener_id = hf_progress.register_listener(listener)

    async def gen():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    # Heartbeat every 30 s so intermediaries don't time out.
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            hf_progress.unregister_listener(listener_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _safe_put(queue: asyncio.Queue, event) -> None:
    """Non-blocking enqueue — drop oldest on overflow rather than block the
    tqdm thread."""
    try:
        queue.put_nowait(event)
    except asyncio.QueueFull:
        try:
            queue.get_nowait()
            queue.put_nowait(event)
        except Exception:
            pass


@router.get("/models")
def list_models():
    """Catalogue every known model + its on-disk install state.

    The frontend Models tab reads this to draw install/delete buttons. We
    don't walk disk for every model — instead `scan_cache_dir()` returns
    *everything* HF has cached, and we look up each known repo in that map.
    One os-walk regardless of model count.
    """
    cached_by_repo: dict[str, dict] = {}
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        for entry in info.repos:
            cached_by_repo[entry.repo_id] = {
                "size_on_disk": entry.size_on_disk,
                "last_accessed": entry.last_accessed,
                "nb_files": entry.nb_files,
            }
    except Exception as e:
        logger.warning("scan_cache_dir failed: %s", e)

    out = []
    for m in KNOWN_MODELS:
        cached = cached_by_repo.get(m["repo_id"])
        out.append({
            **m,
            "installed": cached is not None and cached["size_on_disk"] > 0,
            "size_on_disk_bytes": cached["size_on_disk"] if cached else 0,
            "nb_files": cached["nb_files"] if cached else 0,
        })
    return {
        "models": out,
        "total_installed_bytes": sum(m["size_on_disk_bytes"] for m in out),
        "hf_cache_dir": _hf_cache_dir(),
    }


class InstallModelRequest(BaseModel):
    repo_id: str


@router.post("/models/install")
async def install_model(req: InstallModelRequest):
    """Download one HF repo snapshot; progress goes through the shared
    `/setup/download-stream` SSE feed. Returns immediately so the UI can
    start listening to the stream.

    Matching by repo_id only — no version pinning today. HF's default-branch
    "main" / "refs/heads/main" is what snapshot_download picks."""
    if req.repo_id not in [m["repo_id"] for m in KNOWN_MODELS]:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown model: {req.repo_id!r}. Known: "
                + ", ".join(m["repo_id"] for m in KNOWN_MODELS)
            ),
        )
    loop = asyncio.get_event_loop()

    def _do():
        try:
            from huggingface_hub import snapshot_download
            logger.info("model install starting: %s", req.repo_id)
            snapshot_download(repo_id=req.repo_id)
            logger.info("model install done: %s", req.repo_id)
        except Exception as e:
            logger.warning("model install failed for %s: %s", req.repo_id, e)

    # Non-blocking — client polls /models or listens on the SSE.
    loop.create_task(asyncio.to_thread(_do))
    return {"status": "install_started", "repo_id": req.repo_id}


@router.delete("/models/{repo_id:path}")
def delete_model(repo_id: str):
    """Remove every cached revision of a repo from the HF cache. Frees disk
    + lets the user re-install a fresh copy via POST /models/install."""
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        commits = [
            rev.commit_hash
            for entry in info.repos if entry.repo_id == repo_id
            for rev in entry.revisions
        ]
        if not commits:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Model {repo_id!r} isn't installed. Nothing to delete — "
                    "run POST /models/install first if you want a fresh download."
                ),
            )
        strategy = info.delete_revisions(*commits)
        strategy.execute()
        return {
            "deleted": True,
            "repo_id": repo_id,
            "freed_bytes": strategy.expected_freed_size,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Could not delete {repo_id}: {e}. "
                "Close any process using the model (e.g. the app's main dub job) and retry."
            ),
        )


# ── Pre-flight system check ───────────────────────────────────────────────
#
# Single endpoint that probes every runtime requirement we care about
# (OS, RAM, disk, ffmpeg, GPU driver, network) so the wizard can show a
# pass/warn/fail list instead of silently falling back to CPU when a user's
# GPU driver is stale or ROCm isn't configured.
#
# Each check returns {id, label, status, detail, fix?}. status is one of
# "pass" / "warn" / "fail". The wizard blocks step advancement on any fail
# but lets warns through.

# Minimum NVIDIA driver for the cu128 torch wheels we ship. Users below this
# get CUDA loaded but kernel launches fail with "no kernel image" errors —
# catch it here with a clear message instead.
_MIN_NVIDIA_DRIVER = 555

# RAM thresholds (GB). Below _RAM_FAIL_GB the app will OOM on first dub.
_RAM_FAIL_GB = 8
_RAM_WARN_GB = 12


def _run_cmd(args: list[str], timeout: float = 2.0) -> tuple[int, str]:
    """Run a subprocess synchronously with a short timeout. Returns (rc, stdout).
    Never raises — missing binary or timeout returns (-1, '')."""
    import subprocess
    try:
        out = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False,
        )
        return out.returncode, out.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return -1, ""


def _detect_gpu() -> dict:
    """Best-effort detection of GPU vendor + driver + compute backend.

    Returns: {vendor, driver, device_name, backend, available, notes}
      vendor: 'nvidia' | 'amd' | 'apple' | 'intel' | 'none'
      backend: 'cuda' | 'rocm' | 'mps' | 'cpu'
      available: bool — whether torch can actually use it
    """
    info = {
        "vendor": "none", "driver": None, "device_name": None,
        "backend": "cpu", "available": False, "notes": [],
    }

    # Apple Silicon → MPS (Metal). No external driver to probe.
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

    # NVIDIA — nvidia-smi is the authoritative source on both Linux + Windows.
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
        # Driver sanity — compare major version against bundled cu128 minimum.
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

    # AMD — rocm-smi ships with ROCm on Linux.
    rc, out = _run_cmd(["rocm-smi", "--showproductname"])
    if rc == 0 and out.strip():
        info["vendor"] = "amd"
        info["device_name"] = out.strip().splitlines()[0][:120]
        # Check if torch was built with ROCm support. The CUDA-flavoured
        # wheels we ship don't include ROCm — users need `uv sync` against
        # the pytorch-rocm index manually.
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

    # No discrete GPU detected. If torch still reports cuda.is_available (WSL
    # passthrough, rare), honour it; otherwise fall back to CPU.
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
    """Tiny TCP connect test — avoids hitting the CDN + no SSL handshake."""
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


@router.get("/setup/preflight")
def preflight():
    """One-shot system health check. The wizard renders these as a pass/warn/
    fail list before letting the user proceed to model install.

    Checks: OS + arch, Python runtime, RAM, disk, ffmpeg, ffprobe, GPU vendor
    + driver, torch compute backend, network reach to huggingface, HF cache
    writable. Each entry is safe to ignore individually — the wizard treats
    'warn' as pass-through and only blocks on 'fail'.
    """
    import shutil as _shutil

    checks: list[dict] = []

    # ── OS + arch (info-only)
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

    # ── Disk free (HF cache partition)
    cache = _hf_cache_dir()
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

    # ── FFmpeg (required)
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

    # ── FFprobe (warn — some endpoints need it)
    ffprobe_path = None
    if ffmpeg_path:
        candidate = ffmpeg_path.replace("ffmpeg", "ffprobe")
        if os.path.exists(candidate):
            ffprobe_path = candidate
        else:
            # System PATH fallback
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

    # ── GPU + compute backend
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

    # ── Network reach to huggingface.co (required for first-run downloads)
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


@router.get("/setup/recommendations")
def recommendations():
    """Return a curated model preset for the caller's device + architecture.

    The Settings / first-run Models tab uses this to render a prominent
    "Install recommended" card so users don't have to pick from 14 models.
    Logic mirrors the engine availability matrix:
      - mac-ARM gets the rich mlx-audio stack (Kokoro) + MLX-Whisper speedup
      - mac-Intel + Linux + Windows get the cross-platform subset
      - CUDA hosts optionally get the pytorch-whisper fallback baked in
    """
    is_mac_arm = sys.platform == "darwin" and _platform.machine() == "arm64"
    is_mac_intel = sys.platform == "darwin" and _platform.machine() == "x86_64"
    is_linux = sys.platform.startswith("linux")
    is_windows = sys.platform == "win32"

    has_cuda = False
    try:
        import torch
        has_cuda = bool(torch.cuda.is_available())
    except Exception:
        pass

    # Device label — used as the card title.
    if is_mac_arm:
        device_label = f"Apple Silicon ({_platform.machine()})"
    elif is_mac_intel:
        device_label = "macOS Intel (x86_64)"
    elif is_windows:
        device_label = "Windows x64" + (" + CUDA" if has_cuda else "")
    elif is_linux:
        device_label = "Linux x64" + (" + CUDA" if has_cuda else "")
    else:
        device_label = f"{sys.platform} / {_platform.machine()}"

    # Pick the preset for this device.
    if is_mac_arm:
        recommended_ids = [
            "k2-fsa/OmniVoice",                   # required — 600+ lang zero-shot
            "Systran/faster-whisper-large-v3",    # required — WhisperX ASR
            "mlx-community/whisper-large-v3-mlx", # optional mac speedup
            "mlx-community/Kokoro-82M-bf16",      # mlx-audio fast TTS
            "KittenML/kitten-tts-mini-0.8",       # English turbo tier
        ]
        rationale = (
            "Apple Silicon gets the full stack: OmniVoice for multilingual clone + "
            "WhisperX (faster-whisper weights) for cross-platform ASR + MLX-Whisper "
            "for the Apple-optimised speedup + Kokoro (mlx-audio) for fast local "
            "English + KittenTTS as a CPU-realtime backup."
        )
    else:
        recommended_ids = [
            "k2-fsa/OmniVoice",                   # required
            "Systran/faster-whisper-large-v3",    # required
            "KittenML/kitten-tts-mini-0.8",       # English turbo — cross-platform
        ]
        if has_cuda:
            # A CUDA box can actually run pytorch-whisper well; ship it as a
            # fallback so the user can pin it in Settings → Engines later.
            recommended_ids.append("openai/whisper-large-v3")
            rationale = (
                "Cross-platform stack + pytorch-whisper as a CUDA-accelerated "
                "ASR fallback. MLX / mlx-audio are Apple-Silicon-only and don't "
                "apply here."
            )
        else:
            rationale = (
                "Cross-platform stack: OmniVoice (multilingual clone) + WhisperX "
                "(faster-whisper ASR) + KittenTTS (English turbo, CPU-realtime). "
                "Clean install, every model runs on CPU."
            )

    # Cross-reference against KNOWN_MODELS so we can attach size + label to
    # each recommended entry, and flag which ones are already installed.
    known_by_id = {m["repo_id"]: m for m in KNOWN_MODELS}
    cached_ids: set[str] = set()
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        cached_ids = {
            entry.repo_id for entry in info.repos if entry.size_on_disk > 0
        }
    except Exception:
        pass

    entries = []
    for rid in recommended_ids:
        meta = known_by_id.get(rid, {})
        entries.append({
            "repo_id": rid,
            "label": meta.get("label", rid),
            "role": meta.get("role", ""),
            "size_gb": meta.get("size_gb", 0),
            "required": bool(meta.get("required", False)),
            "note": meta.get("note"),
            "installed": rid in cached_ids,
        })

    # Headline number for the "Install recommended (~X GB)" CTA — only
    # count models not yet on disk so users with a warm cache see a low
    # remaining number instead of the full bundle size.
    to_download_gb = sum(e["size_gb"] for e in entries if not e["installed"])
    all_installed = all(e["installed"] for e in entries)

    return {
        "device": {
            "os": sys.platform,
            "arch": _platform.machine(),
            "is_mac_arm": is_mac_arm,
            "is_mac_intel": is_mac_intel,
            "is_linux": is_linux,
            "is_windows": is_windows,
            "has_cuda": has_cuda,
            "label": device_label,
        },
        "rationale": rationale,
        "models": entries,
        "download_gb_remaining": round(to_download_gb, 2),
        "total_gb": round(sum(e["size_gb"] for e in entries), 2),
        "all_installed": all_installed,
    }


@router.post("/setup/warmup")
async def setup_warmup():
    """Trigger a model load in the background so the first dub doesn't pay
    the cold-start tax. Progress flows through the SSE stream."""
    loop = asyncio.get_event_loop()

    async def _do_warmup():
        try:
            from services.model_manager import get_model
            await get_model()
        except Exception as e:
            logger.warning("setup/warmup: model load failed: %s", e)

    # Don't await — let it run in the background; client watches SSE.
    loop.create_task(_do_warmup())
    return {"status": "warmup_started"}
