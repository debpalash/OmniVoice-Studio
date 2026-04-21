import os
import time
import asyncio
import logging
import torch
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

from omnivoice.models.omnivoice import OmniVoice
from core.config import IDLE_TIMEOUT_SECONDS, CPU_POOL_WORKERS

logger = logging.getLogger("omnivoice.model")

_gpu_pool = ThreadPoolExecutor(max_workers=1)
_cpu_pool = ThreadPoolExecutor(max_workers=CPU_POOL_WORKERS)

model: Optional[OmniVoice] = None
_model_lock = asyncio.Lock()
_last_used = time.time()
_IDLE_TIMEOUT_SECONDS = IDLE_TIMEOUT_SECONDS

def get_best_device():
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"

def _load_model_sync():
    global model
    device = get_best_device()
    logger.info("Loading OmniVoice model lazily on device: %s", device)
    checkpoint = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
    _model = OmniVoice.from_pretrained(
        checkpoint, device_map=device, dtype=torch.float16, load_asr=True,
    )
    try:
        if device == "cuda":
            _model.llm = torch.compile(_model.llm, mode="reduce-overhead")
            logger.info("torch.compile applied.")
    except Exception as e:
        logger.info("torch.compile skipped: %s", e)
    logger.info("OmniVoice model loaded successfully.")
    return _model

async def get_model() -> OmniVoice:
    global model, _last_used
    _last_used = time.time()
    if model is not None:
        return model
    
    async with _model_lock:
        if model is None:
            loop = asyncio.get_running_loop()
            model = await loop.run_in_executor(_gpu_pool, _load_model_sync)
    return model

def get_model_status():
    is_loaded = model is not None
    # asyncio.Lock exposes .locked() on all supported Python versions; wrap in try for safety.
    try:
        is_loading = (not is_loaded) and _model_lock.locked()
    except Exception:
        is_loading = False
    return {
        "loaded": is_loaded,
        "loading": is_loading,
        "status": "loading" if is_loading else ("ready" if is_loaded else "idle"),
    }

async def idle_worker():
    global model
    while True:
        await asyncio.sleep(30)
        async with _model_lock:
            if model is not None and time.time() - _last_used > _IDLE_TIMEOUT_SECONDS:
                logger.info("Idle timeout reached. Unloading OmniVoice model to free VRAM.")
                model = None
                import gc
                gc.collect()
                if torch.backends.mps.is_available():
                    torch.mps.empty_cache()
                elif torch.cuda.is_available():
                    torch.cuda.empty_cache()

def free_vram():
    import gc
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    elif torch.cuda.is_available():
        torch.cuda.empty_cache()

_diar_pipeline = None

def get_diarization_pipeline():
    global _diar_pipeline
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        return None
    if _diar_pipeline is not None:
        return _diar_pipeline
    try:
        import torch
        from pyannote.audio import Pipeline
        import logging
        logger = logging.getLogger("omnivoice.api")
        logger.info("Loading Pyannote Diarization Pipeline...")
        _diar_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)
        if torch.cuda.is_available():
            _diar_pipeline.to(torch.device("cuda"))
        logger.info("Pyannote Diarization Pipeline loaded successfully.")
        return _diar_pipeline
    except Exception as e:
        import logging
        logger = logging.getLogger("omnivoice.api")
        logger.error(f"Failed to load Pyannote pipeline: {e}")
        return None
