import os
import sys
import uuid
import psutil
import asyncio
import logging
from fastapi import APIRouter, File, UploadFile, HTTPException, Query
from api.schemas import SysinfoResponse, SystemInfoResponse, ModelStatusResponse, LogsResponse, FlushMemoryResponse
from fastapi.responses import FileResponse, StreamingResponse
import torch
import shutil

from core.config import OUTPUTS_DIR, DATA_DIR, CRASH_LOG_PATH, LOG_PATH, IDLE_TIMEOUT_SECONDS
from services.model_manager import get_model_status, get_best_device
from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

router = APIRouter()
logger = logging.getLogger("omnivoice.api")

# Cache device checks at module load — they don't change at runtime
_is_mac = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
_is_cuda = torch.cuda.is_available()
# Prime psutil's internal CPU counter so the first non-blocking call returns useful data
psutil.cpu_percent(interval=None)

@router.get("/model/status", response_model=ModelStatusResponse)
def model_status():
    """Report model loading state for frontend warm-up indicators."""
    return get_model_status()


@router.get("/model/loaded")
def loaded_models():
    """Return details about all currently loaded models for the flush dropdown.

    Returns a list of models with name, type, device, and estimated VRAM usage.
    """
    import services.model_manager as mm

    models = []

    # 1. TTS model (OmniVoice)
    if mm.model is not None:
        device = "unknown"
        vram_mb = 0
        try:
            device = str(next(mm.model.parameters()).device) if hasattr(mm.model, 'parameters') else get_best_device()
        except Exception:
            device = get_best_device()
        try:
            torch = mm._lazy_torch()
            if torch.cuda.is_available():
                vram_mb = torch.cuda.memory_allocated() / (1024 ** 2)
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                driver = getattr(torch.mps, "driver_allocated_memory", None)
                if driver:
                    vram_mb = driver() / (1024 ** 2)
        except Exception:
            pass
        models.append({
            "id": "tts",
            "name": "OmniVoice TTS",
            "checkpoint": os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice"),
            "device": device,
            "vram_mb": round(vram_mb, 1),
            "unloadable": True,
        })

    # 2. ASR model (WhisperX)
    if mm.model is not None and hasattr(mm.model, '_asr_pipe') and mm.model._asr_pipe is not None:
        models.append({
            "id": "asr",
            "name": "WhisperX ASR",
            "checkpoint": os.environ.get("ASR_MODEL", "Systran/faster-whisper-large-v3"),
            "device": "cpu",
            "vram_mb": 0,
            "unloadable": False,  # tied to TTS model lifecycle
        })

    # 3. Diarization pipeline
    if mm._diar_pipeline is not None:
        models.append({
            "id": "diarization",
            "name": "Pyannote Diarization",
            "checkpoint": "pyannote/speaker-diarization-3.1",
            "device": get_best_device(),
            "vram_mb": 0,
            "unloadable": True,
        })

    return {"models": models, "count": len(models)}


@router.post("/model/unload/{model_id}")
async def unload_model(model_id: str):
    """Unload a specific model by ID."""
    import services.model_manager as mm

    if model_id == "tts":
        async with mm._model_lock:
            if mm.model is not None:
                mm.model = None
                mm.free_vram()
                return {"unloaded": "tts", "success": True}
        return {"unloaded": "tts", "success": False, "reason": "not loaded"}

    elif model_id == "diarization":
        if mm._diar_pipeline is not None:
            mm._diar_pipeline = None
            mm.free_vram()
            return {"unloaded": "diarization", "success": True}
        return {"unloaded": "diarization", "success": False, "reason": "not loaded"}

    else:
        raise HTTPException(status_code=400, detail=f"Unknown model id: {model_id}")


@router.get("/system/info", response_model=SystemInfoResponse)
def system_info():
    """Settings page system info — model, tokens, data dir, timeout.

    This endpoint MUST never throw — it's called on every Settings page load
    and a 500 here blocks the entire UI from rendering system details.
    """
    try:
        return {
            "data_dir": DATA_DIR,
            "outputs_dir": OUTPUTS_DIR,
            "crash_log_path": CRASH_LOG_PATH,
            "idle_timeout_seconds": IDLE_TIMEOUT_SECONDS,
            "model_checkpoint": os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice"),
            "asr_model": os.environ.get("ASR_MODEL", "Systran/faster-whisper-large-v3"),
            "translate_provider": os.environ.get("TRANSLATE_PROVIDER", "google"),
            "has_hf_token": bool(os.environ.get("HF_TOKEN")),
            "device": get_best_device(),
            "python": sys.version.split()[0],
            "platform": sys.platform,
        }
    except Exception as e:
        logger.exception("system_info failed — returning safe defaults")
        return {
            "data_dir": DATA_DIR,
            "outputs_dir": OUTPUTS_DIR,
            "crash_log_path": str(CRASH_LOG_PATH),
            "idle_timeout_seconds": IDLE_TIMEOUT_SECONDS,
            "model_checkpoint": "unknown",
            "asr_model": "unknown",
            "translate_provider": "unknown",
            "has_hf_token": False,
            "device": "cpu",
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "error": str(e),
        }


def _tail_file(path: str, tail: int):
    """Read the last `tail` lines from `path`. Returns (lines, total)."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        all_lines = f.readlines()
    return all_lines[-tail:], len(all_lines)


def _tauri_log_candidates():
    """Likely paths for Tauri-side logs, most useful first.

    `tauri-plugin-log` writes to `~/Library/Logs/<bundle_id>/<file_name>.log`
    by default on macOS. Our bundle id is `com.debpalash.omnivoice-studio`
    (see frontend/src-tauri/tauri.conf.json). lib.rs also redirects the
    spawned backend's stdout/stderr to `~/Library/Logs/OmniVoice/backend.log`
    which is where `print()` calls and uvicorn startup banners land.
    """
    home = os.path.expanduser("~")
    bid = "com.debpalash.omnivoice-studio"
    if sys.platform == "darwin":
        return [
            os.path.join(home, "Library/Logs", bid, "tauri.log"),
            os.path.join(home, "Library/Logs", bid, "OmniVoice Studio.log"),
            os.path.join(home, "Library/Logs/OmniVoice/backend.log"),
            os.path.join(home, "Library/Logs/OmniVoice/backend_err.log"),
        ]
    if sys.platform.startswith("linux"):
        return [
            os.path.join(home, ".local/share", bid, "logs", "tauri.log"),
            os.path.join(home, ".config", bid, "logs", "tauri.log"),
        ]
    if sys.platform.startswith("win"):
        appdata = os.environ.get("APPDATA", home)
        return [
            os.path.join(appdata, bid, "logs", "tauri.log"),
        ]
    return []


@router.get("/system/logs")
async def system_logs(tail: int = 200):
    """Tail the rolling runtime log — everything Python logged since last rotation.

    Back-stop: if the rolling log doesn't exist yet (fresh install, disk error),
    fall back to the crash log so the UI always has something to show.
    """
    try:
        tail = max(10, min(2000, int(tail)))
    except Exception:
        tail = 200

    path = LOG_PATH if os.path.exists(LOG_PATH) else CRASH_LOG_PATH
    if not os.path.exists(path):
        return {"lines": [], "path": LOG_PATH, "exists": False}
    try:
        lines, total = await asyncio.to_thread(_tail_file, path, tail)
        return {"lines": lines, "path": path, "exists": True, "total_lines": total}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read log at {path}: {e}. Check file permissions or delete it manually.",
        )


@router.get("/system/logs/tauri")
async def system_logs_tauri(tail: int = 200):
    """Tail the Tauri plugin log (or backend stdout redirect, whichever exists)."""
    try:
        tail = max(10, min(2000, int(tail)))
    except Exception:
        tail = 200
    candidates = _tauri_log_candidates()
    for p in candidates:
        if os.path.exists(p):
            try:
                lines, total = await asyncio.to_thread(_tail_file, p, tail)
                return {"lines": lines, "path": p, "exists": True, "total_lines": total}
            except Exception as e:
                return {"lines": [], "path": p, "exists": True, "error": str(e)}
    return {"lines": [], "path": None, "exists": False, "candidates": candidates}


@router.get("/system/logs/stream")
async def stream_logs(
    source: str = Query("backend", description="'backend' or 'tauri'"),
    interval: float = Query(1.0, ge=0.3, le=10.0, description="Poll interval in seconds"),
):
    """Server-Sent Events stream of new log lines.

    The client opens an EventSource connection and receives new lines as they
    are appended to the log file.  This replaces the polling pattern used by
    the LogsFooter component.

    Usage (frontend)::

        const es = new EventSource('/system/logs/stream?source=backend');
        es.onmessage = (e) => { const lines = JSON.parse(e.data); ... };
    """
    if source == "tauri":
        candidates = _tauri_log_candidates()
        path = next((p for p in candidates if os.path.exists(p)), None)
    else:
        path = LOG_PATH if os.path.exists(LOG_PATH) else CRASH_LOG_PATH

    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Log file not found for source={source}")

    async def _generate():
        """Yield SSE events whenever new lines appear in the log file."""
        last_pos = 0
        try:
            last_pos = os.path.getsize(path)
        except Exception:
            pass
        while True:
            await asyncio.sleep(interval)
            try:
                size = os.path.getsize(path)
                if size < last_pos:
                    # File was truncated (log rotation or clear) — reset
                    last_pos = 0
                if size == last_pos:
                    continue
                new_lines = await asyncio.to_thread(_read_from_pos, path, last_pos)
                last_pos = size
                if new_lines:
                    import json
                    yield f"data: {json.dumps(new_lines)}\n\n"
            except Exception:
                break

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _read_from_pos(path: str, pos: int) -> list[str]:
    """Read all lines from `pos` to EOF (runs in threadpool)."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(pos)
        return f.readlines()


@router.post("/system/logs/clear")
async def clear_system_logs():
    """Truncate the rolling runtime log and the crash log (what the Backend tab reads)."""
    cleared_any = False
    for p in (LOG_PATH, CRASH_LOG_PATH):
        if os.path.exists(p):
            try:
                await asyncio.to_thread(_truncate_file, p)
                cleared_any = True
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not clear log at {p}: {e}. The file may be open in another process or read-only — close tailing tools and retry.",
                )
    return {"cleared": cleared_any}


def _truncate_file(path: str):
    """Truncate a file to zero length (runs in threadpool)."""
    with open(path, "w") as f:
        f.truncate(0)


@router.post("/system/logs/tauri/clear")
async def clear_tauri_logs():
    """Truncate whichever Tauri-side log files we know about. OS-level rotation may recreate them."""
    cleared = []
    for p in _tauri_log_candidates():
        if os.path.exists(p):
            try:
                await asyncio.to_thread(_truncate_file, p)
                cleared.append(p)
            except Exception:
                pass
    return {"cleared": cleared}

@router.get("/sysinfo", response_model=SysinfoResponse)
def get_sys_info():
    vram = 0.0
    gpu_active = False

    try:
        if _is_mac:
            alloc = getattr(torch.mps, "current_allocated_memory", None)
            driver = getattr(torch.mps, "driver_allocated_memory", None)
            if driver:
                vram = driver() / (1024**3)
            elif alloc:
                vram = alloc() / (1024**3)
        elif _is_cuda:
            vram = torch.cuda.memory_allocated() / (1024**3)
    except Exception:
        pass
        
    if vram > 0.01:
        gpu_active = True

    vm = psutil.virtual_memory()
    return {
        "cpu": psutil.cpu_percent(interval=None),
        "ram": vm.used / (1024**3),
        "total_ram": vm.total / (1024**3),
        "vram": round(vram, 2),
        "gpu_active": gpu_active
    }

@router.post("/system/flush-memory")
async def flush_memory(unload_model: bool = False):
    """Aggressively release RAM/VRAM by clearing caches and running GC.

    When unload_model=true, the TTS model is fully unloaded and will be
    re-loaded lazily on the next generation request.
    """
    import gc
    from services.model_manager import free_vram, model as _current_model

    freed_model = False
    if unload_model:
        import services.model_manager as mm
        async with mm._model_lock:
            if mm.model is not None:
                mm.model = None
                freed_model = True

    # Multi-pass GC to break reference cycles
    gc.collect(generation=2)
    gc.collect(generation=1)
    gc.collect(generation=0)

    free_vram()

    # Snapshot after flush
    vram_after = 0.0
    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            driver = getattr(torch.mps, "driver_allocated_memory", None)
            if driver:
                vram_after = driver() / (1024**3)
        elif torch.cuda.is_available():
            vram_after = torch.cuda.memory_allocated() / (1024**3)
    except Exception:
        pass

    ram_after = psutil.virtual_memory().used / (1024**3)

    return {
        "flushed": True,
        "unloaded_model": freed_model,
        "ram_after": round(ram_after, 2),
        "vram_after": round(vram_after, 2),
    }


# ── Actionable notifications ──────────────────────────────────────────────


@router.get("/system/notifications")
def system_notifications():
    """Return actionable notifications for the UI notification panel.

    Each notification has:
      - id: unique key (for dismiss tracking)
      - level: "info" | "warn" | "error"
      - title: short heading
      - message: longer description
      - action: optional {"label": str, "type": "navigate|link|api", "target": str}
    """
    notes = []

    # 1. Missing HF_TOKEN
    if not os.environ.get("HF_TOKEN"):
        notes.append({
            "id": "hf-token-missing",
            "level": "warn",
            "title": "HuggingFace token not set",
            "message": (
                "Downloads may be rate-limited and speaker diarization "
                "won't work without a HuggingFace token."
            ),
            "action": {
                "label": "Set token",
                "type": "navigate",
                "target": "settings",
            },
        })

    # 2. Missing ffmpeg
    ffmpeg_ok = False
    try:
        ffmpeg_path = find_ffmpeg()
        # find_ffmpeg may return an absolute path or a bare command name.
        # Both are valid — only flag missing if find_ffmpeg raises.
        ffmpeg_ok = bool(ffmpeg_path)
    except Exception:
        pass
    if not ffmpeg_ok:
        notes.append({
            "id": "ffmpeg-missing",
            "level": "error",
            "title": "ffmpeg not found",
            "message": (
                "Video processing, audio conversion, and dubbing require ffmpeg. "
                "Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)."
            ),
            "action": {
                "label": "Install guide",
                "type": "link",
                "target": "https://ffmpeg.org/download.html",
            },
        })

    # 3. Low disk space
    try:
        usage = shutil.disk_usage(DATA_DIR)
        free_gb = usage.free / (1024 ** 3)
        if free_gb < 5:
            notes.append({
                "id": "disk-low",
                "level": "warn",
                "title": f"Low disk space ({free_gb:.1f} GB free)",
                "message": "OmniVoice needs disk space for models, audio, and temp files.",
                "action": None,
            })
    except Exception:
        pass

    # 4. GPU not available
    device = get_best_device()
    if device == "cpu":
        notes.append({
            "id": "gpu-unavailable",
            "level": "info",
            "title": "Running on CPU",
            "message": (
                "No GPU detected. TTS generation will be slower. "
                "If you have a GPU, check CUDA/MPS drivers."
            ),
            "action": None,
        })

    return {"notifications": notes, "count": len(notes)}


# ── Environment variable setter ───────────────────────────────────────────


@router.post("/system/set-env")
async def set_env_var(body: dict):
    """Set an environment variable at runtime.

    Currently supports:
      - HF_TOKEN: HuggingFace access token
      - TRANSLATE_API_KEY: Translation API key

    The value is set on os.environ for the running process.
    For persistence across restarts, users should set it in their shell profile.
    """
    ALLOWED_KEYS = {"HF_TOKEN", "TRANSLATE_API_KEY"}
    key = body.get("key", "")
    value = body.get("value", "")

    if key not in ALLOWED_KEYS:
        raise HTTPException(
            status_code=400,
            detail=f"Key '{key}' is not allowed. Allowed: {', '.join(sorted(ALLOWED_KEYS))}",
        )

    if value:
        os.environ[key] = value
        logger.info("Set environment variable: %s (length=%d)", key, len(value))
    else:
        os.environ.pop(key, None)
        logger.info("Cleared environment variable: %s", key)

    return {"key": key, "set": bool(value)}


@router.post("/clean-audio")
async def clean_audio(audio: UploadFile = File(...)):
    """Accept a raw mic recording, run demucs vocal isolation, return clean WAV."""
    clean_id = str(uuid.uuid4())[:8]
    tmp_dir = os.path.join(OUTPUTS_DIR, f"_clean_{clean_id}")
    os.makedirs(tmp_dir, exist_ok=True)
    try:
        return await _do_clean_audio(audio, tmp_dir, clean_id)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


async def _do_clean_audio(audio, tmp_dir, clean_id):
    raw_path = os.path.join(tmp_dir, "raw.wav")
    with open(raw_path, "wb") as f:
        f.write(await audio.read())

    converted_path = os.path.join(tmp_dir, "converted.wav")
    ffmpeg = find_ffmpeg()
    try:
        rc, _, _ = await run_ffmpeg(
            [ffmpeg, "-y", "-i", raw_path, "-ar", "24000", "-ac", "1", converted_path],
            timeout=120.0,
        )
    except asyncio.TimeoutError:
        rc = -1
    if rc != 0:
        converted_path = raw_path

    clean_path = converted_path
    try:
        rc, _, _ = await run_ffmpeg(
            [sys.executable, "-m", "demucs.separate", "--two-stems", "vocals", "-n", "htdemucs",
             "-d", get_best_device(), converted_path, "-o", tmp_dir],
            timeout=900.0,
        )
        if rc == 0:
            demucs_out = os.path.join(tmp_dir, "htdemucs", "converted")
            vocals_file = os.path.join(demucs_out, "vocals.wav")
            if os.path.exists(vocals_file):
                clean_path = vocals_file
    except asyncio.TimeoutError:
        logger.warning("Demucs timed out for mic audio, using raw")
    except Exception as e:
        logger.warning(f"Demucs failed for mic audio, using raw: {e}")

    clean_filename = f"mic_{clean_id}.wav"
    final_path = os.path.join(OUTPUTS_DIR, clean_filename)

    try:
        await run_ffmpeg(
            [ffmpeg, "-y", "-i", clean_path, "-ar", "24000", "-ac", "1", final_path],
            timeout=120.0,
        )
    except asyncio.TimeoutError:
        pass
    if not os.path.exists(final_path):
        shutil.copy2(clean_path, final_path)

    return FileResponse(final_path, media_type="audio/wav", filename=clean_filename,
                        headers={"X-Clean-Filename": clean_filename})
