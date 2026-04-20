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

from core.config import OUTPUTS_DIR, DATA_DIR, CRASH_LOG_PATH, IDLE_TIMEOUT_SECONDS
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
        "asr_model": os.environ.get("ASR_MODEL", "mlx-community/whisper-large-v3-mlx"),
        "translate_provider": os.environ.get("TRANSLATE_PROVIDER", "google"),
        "has_hf_token": bool(os.environ.get("HF_TOKEN")),
        "device": get_best_device(),
        "python": sys.version.split()[0],
        "platform": sys.platform,
    }


@router.get("/system/logs")
def system_logs(tail: int = 200):
    """Tail the crash log file (last N lines). Safe: bounded read."""
    try:
        tail = max(10, min(2000, int(tail)))
    except Exception:
        tail = 200
    if not os.path.exists(CRASH_LOG_PATH):
        return {"lines": [], "path": CRASH_LOG_PATH, "exists": False}
    try:
        # Read file then keep last N lines — crash logs are small in practice.
        with open(CRASH_LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
        sliced = all_lines[-tail:]
        return {"lines": sliced, "path": CRASH_LOG_PATH, "exists": True, "total_lines": len(all_lines)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/system/logs/tauri")
def system_logs_tauri(tail: int = 200):
    """Tail the Tauri (webview host) log if present. Paths per platform."""
    try:
        tail = max(10, min(2000, int(tail)))
    except Exception:
        tail = 200
    # Probable Tauri log locations — bundle identifier usually mirrors product name.
    candidates = []
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        candidates += [
            os.path.join(home, "Library/Logs/com.omnivoice.studio/OmniVoice.log"),
            os.path.join(home, "Library/Logs/OmniVoice/OmniVoice.log"),
            os.path.join(home, "Library/Logs/com.tauri.dev/OmniVoice.log"),
        ]
    elif sys.platform.startswith("linux"):
        candidates += [
            os.path.join(home, ".local/share/com.omnivoice.studio/logs/OmniVoice.log"),
            os.path.join(home, ".config/com.omnivoice.studio/logs/OmniVoice.log"),
        ]
    elif sys.platform.startswith("win"):
        candidates += [
            os.path.join(os.environ.get("APPDATA", home), "com.omnivoice.studio", "logs", "OmniVoice.log"),
        ]
    for p in candidates:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    all_lines = f.readlines()
                return {"lines": all_lines[-tail:], "path": p, "exists": True, "total_lines": len(all_lines)}
            except Exception as e:
                return {"lines": [], "path": p, "exists": True, "error": str(e)}
    return {"lines": [], "path": None, "exists": False, "candidates": candidates}


@router.post("/system/logs/clear")
def clear_system_logs():
    if os.path.exists(CRASH_LOG_PATH):
        try:
            with open(CRASH_LOG_PATH, "w") as f:
                f.truncate(0)
            return {"cleared": True}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    return {"cleared": False}

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
