import os
import sys
import uuid
import psutil
import asyncio
import logging
from fastapi import APIRouter, File, UploadFile, HTTPException
from fastapi.responses import FileResponse
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

@router.get("/model/status")
def model_status():
    """Report model loading state for frontend warm-up indicators."""
    return get_model_status()


@router.get("/system/info")
def system_info():
    """Settings page system info — model, tokens, data dir, timeout."""
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
def system_logs(tail: int = 200):
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
        lines, total = _tail_file(path, tail)
        return {"lines": lines, "path": path, "exists": True, "total_lines": total}
    except Exception as e:
        # The log file exists but we can't read it — usually a permission
        # issue or the file got truncated mid-read. Point the user at the
        # path so they can inspect or delete manually.
        raise HTTPException(
            status_code=500,
            detail=f"Could not read log at {path}: {e}. Check file permissions or delete it manually.",
        )


@router.get("/system/logs/tauri")
def system_logs_tauri(tail: int = 200):
    """Tail the Tauri plugin log (or backend stdout redirect, whichever exists)."""
    try:
        tail = max(10, min(2000, int(tail)))
    except Exception:
        tail = 200
    candidates = _tauri_log_candidates()
    for p in candidates:
        if os.path.exists(p):
            try:
                lines, total = _tail_file(p, tail)
                return {"lines": lines, "path": p, "exists": True, "total_lines": total}
            except Exception as e:
                return {"lines": [], "path": p, "exists": True, "error": str(e)}
    return {"lines": [], "path": None, "exists": False, "candidates": candidates}


@router.post("/system/logs/clear")
def clear_system_logs():
    """Truncate the rolling runtime log and the crash log (what the Backend tab reads)."""
    cleared_any = False
    for p in (LOG_PATH, CRASH_LOG_PATH):
        if os.path.exists(p):
            try:
                with open(p, "w") as f:
                    f.truncate(0)
                cleared_any = True
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not clear log at {p}: {e}. The file may be open in another process or read-only — close tailing tools and retry.",
                )
    return {"cleared": cleared_any}


@router.post("/system/logs/tauri/clear")
def clear_tauri_logs():
    """Truncate whichever Tauri-side log files we know about. OS-level rotation may recreate them."""
    cleared = []
    for p in _tauri_log_candidates():
        if os.path.exists(p):
            try:
                with open(p, "w") as f:
                    f.truncate(0)
                cleared.append(p)
            except Exception:
                pass
    return {"cleared": cleared}

@router.get("/sysinfo")
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
