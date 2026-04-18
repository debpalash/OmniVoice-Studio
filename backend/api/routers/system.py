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

from core.config import OUTPUTS_DIR
from services.model_manager import get_model_status, get_best_device
from services.ffmpeg_utils import find_ffmpeg

router = APIRouter()
logger = logging.getLogger("omnivoice.api")

@router.get("/model/status")
def model_status():
    """Report model loading state for frontend warm-up indicators."""
    return get_model_status()

@router.get("/sysinfo")
def get_sys_info():
    vram = 0.0
    gpu_active = False
    
    is_mac = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
    is_cuda = torch.cuda.is_available()

    try:
        if is_mac:
            alloc = getattr(torch.mps, "current_allocated_memory", None)
            driver = getattr(torch.mps, "driver_allocated_memory", None)
            if driver:
                vram = driver() / (1024**3)
            elif alloc:
                vram = alloc() / (1024**3)
        elif is_cuda:
            vram = torch.cuda.memory_allocated() / (1024**3)
    except Exception:
        pass
        
    if vram > 0.01:
        gpu_active = True

    return {
        "cpu": psutil.cpu_percent(interval=0.1),
        "ram": psutil.virtual_memory().used / (1024**3),
        "total_ram": psutil.virtual_memory().total / (1024**3),
        "vram": round(vram, 2),
        "gpu_active": gpu_active
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
    proc = await asyncio.create_subprocess_exec(
        ffmpeg, "-y", "-i", raw_path, "-ar", "24000", "-ac", "1", converted_path,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120.0)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        converted_path = raw_path
    else:
        if proc.returncode != 0:
            converted_path = raw_path

    clean_path = converted_path
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "demucs.separate", "--two-stems", "vocals", "-n", "htdemucs",
            "-d", get_best_device(), converted_path, "-o", tmp_dir,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=900.0)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            raise Exception("demucs timed out")
        if proc.returncode == 0:
            demucs_out = os.path.join(tmp_dir, "htdemucs", "converted")
            vocals_file = os.path.join(demucs_out, "vocals.wav")
            if os.path.exists(vocals_file):
                clean_path = vocals_file
    except Exception as e:
        logger.warning(f"Demucs failed for mic audio, using raw: {e}")

    clean_filename = f"mic_{clean_id}.wav"
    final_path = os.path.join(OUTPUTS_DIR, clean_filename)

    proc = await asyncio.create_subprocess_exec(
        ffmpeg, "-y", "-i", clean_path, "-ar", "24000", "-ac", "1", final_path,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        await asyncio.wait_for(proc.communicate(), timeout=120.0)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    if not os.path.exists(final_path):
        shutil.copy2(clean_path, final_path)

    return FileResponse(final_path, media_type="audio/wav", filename=clean_filename,
                        headers={"X-Clean-Filename": clean_filename})
