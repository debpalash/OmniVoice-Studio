import os
import time
import asyncio
import logging
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

# ── Lazy imports ─────────────────────────────────────────────────────
# torch and OmniVoice are heavy (~2-3s import on Apple Silicon).
# Deferring them until first use cuts cold start from ~4s to ~1.5s,
# so health/status endpoints respond immediately on boot.

_torch = None
_OmniVoice = None


def _lazy_torch():
    global _torch
    if _torch is None:
        import torch as _t
        _torch = _t
    return _torch


def _lazy_omnivoice():
    global _OmniVoice
    if _OmniVoice is None:
        from omnivoice.models.omnivoice import OmniVoice as _OV
        _OmniVoice = _OV
    return _OmniVoice


from core.config import IDLE_TIMEOUT_SECONDS, CPU_POOL_WORKERS

logger = logging.getLogger("omnivoice.model")

_gpu_pool = ThreadPoolExecutor(max_workers=1)
_cpu_pool = ThreadPoolExecutor(max_workers=CPU_POOL_WORKERS)

model = None  # type: ignore
_model_lock = asyncio.Lock()
_last_used = time.time()
_IDLE_TIMEOUT_SECONDS = IDLE_TIMEOUT_SECONDS

# ── Loading sub-stage tracker ────────────────────────────────────────
# Updated by _load_model_sync() so get_model_status() can report
# granular progress to the frontend pill.
_loading_detail: dict = {
    "sub_stage": None,   # importing | loading_weights | loading_asr | compiling | ready | error
    "detail": "",        # human-readable description
    "error": None,       # error message string if failed
}

def get_best_device():
    torch = _lazy_torch()
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"

def _set_loading(sub_stage: str, detail: str = "", error: str | None = None):
    """Update the loading detail dict atomically."""
    _loading_detail["sub_stage"] = sub_stage
    _loading_detail["detail"] = detail
    _loading_detail["error"] = error


def _load_model_sync():
    global model
    try:
        _set_loading("importing", "Importing PyTorch & OmniVoice runtime…")
        logger.info("Importing PyTorch & OmniVoice runtime…")
        torch = _lazy_torch()
        OmniVoice = _lazy_omnivoice()
        device = get_best_device()

        checkpoint = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
        _set_loading("loading_weights", f"Loading TTS weights on {device}…")
        logger.info("Loading OmniVoice model on device: %s", device)
        _model = OmniVoice.from_pretrained(
            checkpoint, device_map=device, dtype=torch.float16, load_asr=True,
        )

        try:
            if device == "cuda":
                _set_loading("compiling", "Compiling model (torch.compile)…")
                _model.llm = torch.compile(_model.llm, mode="reduce-overhead")
                logger.info("torch.compile applied.")
        except Exception as e:
            logger.info("torch.compile skipped: %s", e)

        _set_loading("ready", "Model ready")
        logger.info("OmniVoice model loaded successfully.")
        return _model
    except Exception as exc:
        err_msg = str(exc)
        _set_loading("error", "Model loading failed", error=err_msg)
        logger.error("Model loading failed: %s", err_msg)
        raise

async def get_model():
    global model, _last_used
    _last_used = time.time()
    if model is not None:
        return model
    
    async with _model_lock:
        if model is None:
            loop = asyncio.get_running_loop()
            model = await loop.run_in_executor(_gpu_pool, _load_model_sync)
    return model


async def preload_model():
    """Background model warm-up — call from lifespan startup.

    Loads the TTS model on the GPU pool thread so the first /generate
    call is near-instant instead of waiting 4-6s for weight loading.
    Non-blocking: if models aren't installed yet, silently exits.
    """
    global model, _last_used
    if model is not None:
        return  # already loaded
    try:
        # Check if the required model checkpoint exists before attempting
        # a heavy load that would fail and pollute startup logs.
        checkpoint = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
        try:
            from huggingface_hub import model_info
            model_info(checkpoint, timeout=5)
        except Exception:
            # Model not downloaded yet — skip preload
            logger.info("Preload skipped: %s not available locally.", checkpoint)
            return

        logger.info("Preloading TTS model in background…")
        _last_used = time.time()
        async with _model_lock:
            if model is None:
                loop = asyncio.get_running_loop()
                model = await loop.run_in_executor(_gpu_pool, _load_model_sync)
        logger.info("Preload complete — model ready.")
    except Exception as e:
        logger.warning("Model preload failed (non-fatal): %s", e)

def get_model_status():
    is_loaded = model is not None
    # asyncio.Lock exposes .locked() on all supported Python versions; wrap in try for safety.
    try:
        is_loading = (not is_loaded) and _model_lock.locked()
    except Exception:
        is_loading = False

    status = "loading" if is_loading else ("ready" if is_loaded else "idle")
    result = {
        "loaded": is_loaded,
        "loading": is_loading,
        "status": status,
    }
    # Attach sub-stage detail when loading or after an error
    sub = _loading_detail.get("sub_stage")
    if sub:
        result["sub_stage"] = sub
        result["detail"] = _loading_detail.get("detail", "")
        err = _loading_detail.get("error")
        if err:
            result["error"] = err
    return result

async def idle_worker():
    global model
    torch = _lazy_torch()
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
    torch = _lazy_torch()
    import gc
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    elif torch.cuda.is_available():
        torch.cuda.empty_cache()


def offload_tts_for_asr():
    """Move TTS model to CPU to free VRAM for ASR (WhisperX large-v3).

    On a 7-8 GB laptop GPU the TTS model (~2.4 GB) and WhisperX large-v3
    (~3 GB) plus the VAD model can't coexist. Offloading the TTS model to
    CPU before transcription prevents CUDA OOM, then restore_tts_after_asr()
    moves it back.
    """
    global model
    torch = _lazy_torch()
    if model is None:
        return
    if not torch.cuda.is_available():
        return  # Only needed on CUDA (limited VRAM)
    try:
        # Check if there's enough free VRAM to skip offloading (WhisperX + context needs >6GB safely)
        free_mem = torch.cuda.mem_get_info()[0]
        if free_mem > 8 * 1024 ** 3:  # > 8 GB free → plenty of room, skip offload
            return
    except Exception:
        pass
    try:
        logger.info("Offloading TTS model to CPU to free VRAM for ASR...")
        model.to("cpu")
        free_vram()
        logger.info("TTS model offloaded. VRAM freed for ASR.")
    except Exception as e:
        logger.warning("TTS offload failed: %s", e)


def restore_tts_after_asr():
    """Move TTS model back to CUDA after ASR completes."""
    global model
    torch = _lazy_torch()
    if model is None:
        return
    if not torch.cuda.is_available():
        return
    try:
        device = get_best_device()
        if device == "cuda":
            logger.info("Restoring TTS model to CUDA...")
            model.to("cuda")
            free_vram()
    except Exception as e:
        logger.warning("TTS restore to CUDA failed: %s", e)

_diar_pipeline = None

def get_diarization_pipeline():
    global _diar_pipeline
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        return None
    if _diar_pipeline is not None:
        return _diar_pipeline
    try:
        torch = _lazy_torch()
        from pyannote.audio import Pipeline
        logger.info("Loading Pyannote Diarization Pipeline...")
        _diar_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)
        if torch.cuda.is_available():
            _diar_pipeline.to(torch.device("cuda"))
        logger.info("Pyannote Diarization Pipeline loaded successfully.")
        return _diar_pipeline
    except Exception as e:
        logger.error(f"Failed to load Pyannote pipeline: {e}")
        return None
