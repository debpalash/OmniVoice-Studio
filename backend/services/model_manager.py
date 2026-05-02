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

# ── ROCm GFX version overrides ───────────────────────────────────────
# AMD GPUs on ROCm report through torch.cuda but may need
# HSA_OVERRIDE_GFX_VERSION for unsupported GFX IDs.
_ROCM_GFX_OVERRIDES = {
    # RDNA 3 (RX 7000 series) — override to gfx1100
    "gfx1101": "11.0.0", "gfx1102": "11.0.0", "gfx1103": "11.0.0",
    # RDNA 2 (RX 6000 series) — override to gfx1030
    "gfx1031": "10.3.0", "gfx1032": "10.3.0", "gfx1034": "10.3.0",
    # Vega (RX Vega / Radeon VII) — override to gfx900
    "gfx902": "9.0.0", "gfx906": "9.0.6",
}


def _configure_rocm_if_needed(torch):
    """Auto-set HSA_OVERRIDE_GFX_VERSION for AMD GPUs on ROCm.

    ROCm-enabled PyTorch reports `torch.cuda.is_available() == True` but
    some consumer AMD GPUs have GFX IDs not in the official support matrix.
    Setting HSA_OVERRIDE_GFX_VERSION lets them run with the closest
    supported architecture.
    """
    if os.environ.get("HSA_OVERRIDE_GFX_VERSION"):
        return  # User already set it manually
    try:
        device_name = torch.cuda.get_device_name(0).lower()
        # Only AMD GPUs need this — skip NVIDIA
        if not any(kw in device_name for kw in ("amd", "radeon", "instinct")):
            return
        # Try to read the GFX version from the device properties
        props = torch.cuda.get_device_properties(0)
        gcn_arch = getattr(props, "gcnArchName", "") or ""
        gfx_id = gcn_arch.split(":")[0].strip().lower()
        if gfx_id in _ROCM_GFX_OVERRIDES:
            override = _ROCM_GFX_OVERRIDES[gfx_id]
            os.environ["HSA_OVERRIDE_GFX_VERSION"] = override
            logger.info("ROCm: auto-set HSA_OVERRIDE_GFX_VERSION=%s for %s (%s)",
                        override, device_name, gfx_id)
    except Exception as e:
        logger.debug("ROCm GFX auto-config skipped: %s", e)


def check_device_compatibility():
    """Check if PyTorch supports the current GPU's compute capability.

    Returns (compatible, warning_message). Compatible is True if OK or
    no discrete GPU is present.
    """
    torch = _lazy_torch()
    if not torch.cuda.is_available():
        return True, None
    try:
        major, minor = torch.cuda.get_device_capability(0)
        device_name = torch.cuda.get_device_name(0)
        sm_tag = f"sm_{major}{minor}"
        arch_list = getattr(torch.cuda, "_get_arch_list", lambda: [])()
        if arch_list:
            compute_tag = f"compute_{major}{minor}"
            if sm_tag not in arch_list and compute_tag not in arch_list:
                return False, (
                    f"{device_name} (compute capability {major}.{minor} / {sm_tag}) "
                    f"is not supported by this PyTorch build. "
                    f"Supported architectures: {', '.join(arch_list)}. "
                    f"Try: pip install torch --index-url https://download.pytorch.org/whl/nightly/cu128"
                )
    except Exception:
        pass
    return True, None


def get_best_device():
    """Detect the best available compute device.

    Priority: CUDA/ROCm > Intel XPU > DirectML > MPS > CPU
    """
    torch = _lazy_torch()

    # ── NVIDIA CUDA or AMD ROCm ──────────────────────────────────────
    # ROCm-enabled PyTorch reports through torch.cuda, so this covers both.
    if torch.cuda.is_available():
        _configure_rocm_if_needed(torch)
        compatible, warning = check_device_compatibility()
        if not compatible:
            logger.warning(warning)
        return "cuda"

    # ── Intel Arc / discrete GPU via IPEX ────────────────────────────
    try:
        import intel_extension_for_pytorch  # noqa: F401
        if hasattr(torch, "xpu") and torch.xpu.is_available():
            logger.info("Using Intel XPU device: %s", torch.xpu.get_device_name(0))
            return "xpu"
    except ImportError:
        pass

    # ── DirectML — universal Windows GPU (AMD, Intel, NVIDIA fallback)
    try:
        import torch_directml
        if torch_directml.device_count() > 0:
            logger.info("Using DirectML device (GPU %d)", 0)
            return str(torch_directml.device(0))
    except ImportError:
        pass

    # ── Apple Silicon MPS ────────────────────────────────────────────
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
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
                free_vram()

def free_vram():
    """Release cached GPU memory on any accelerator (CUDA, MPS, XPU)."""
    torch = _lazy_torch()
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        torch.mps.empty_cache()
    elif hasattr(torch, "xpu") and torch.xpu.is_available():
        torch.xpu.empty_cache()


def _has_dedicated_vram():
    """Check if the current device has limited dedicated VRAM that needs offloading."""
    torch = _lazy_torch()
    if torch.cuda.is_available():
        return True
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return True
    return False


def offload_tts_for_asr():
    """Move TTS model to CPU to free VRAM for ASR (WhisperX large-v3).

    On a 7-8 GB laptop GPU the TTS model (~2.4 GB) and WhisperX large-v3
    (~3 GB) plus the VAD model can't coexist. Offloading the TTS model to
    CPU before transcription prevents CUDA OOM, then restore_tts_after_asr()
    moves it back.

    Works on CUDA (NVIDIA + ROCm) and Intel XPU.
    """
    global model
    torch = _lazy_torch()
    if model is None:
        return
    if not _has_dedicated_vram():
        return  # MPS / CPU / DirectML don't benefit from manual offloading
    try:
        # Check if there's enough free VRAM to skip offloading
        if torch.cuda.is_available():
            free_mem = torch.cuda.mem_get_info()[0]
            if free_mem > 8 * 1024 ** 3:  # > 8 GB free → skip offload
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
    """Move TTS model back to the GPU after ASR completes."""
    global model
    torch = _lazy_torch()
    if model is None:
        return
    if not _has_dedicated_vram():
        return
    try:
        device = get_best_device()
        if device in ("cuda", "xpu"):
            logger.info("Restoring TTS model to %s...", device)
            model.to(device)
            free_vram()
    except Exception as e:
        logger.warning("TTS restore to %s failed: %s", get_best_device(), e)

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
        device = get_best_device()
        # Pyannote supports CUDA and CPU; route XPU/DirectML to CPU
        if device in ("cuda",):
            _diar_pipeline.to(torch.device(device))
        logger.info("Pyannote Diarization Pipeline loaded on %s.", device)
        return _diar_pipeline
    except Exception as e:
        logger.error(f"Failed to load Pyannote pipeline: {e}")
        return None
