"""Single lifecycle surface for loaded models (MM2-04).

Before this, ``GET /model/loaded`` and ``POST /model/unload`` each hand-rolled
enumeration/dispatch across three worlds — the in-process TTS+ASR model
(``model_manager``), the diarization pipeline, and subprocess sidecars
(``subprocess_backend``). This module owns that logic so the routers are thin
delegations and there's one place to reason about model lifecycle.

Response shapes are preserved exactly — the frontend (hooks.ts model status +
the flush dropdown) depends on ``{models, count}`` and
``{unloaded, success, ...}``.
"""
from __future__ import annotations

import os
from typing import Optional

import services.model_manager as mm
from services.model_manager import get_best_device


def _tts_vram_mb() -> float:
    """Best-effort allocated VRAM for the in-process model. Accurate on CUDA,
    sparse on MPS, 0 elsewhere — degrade gracefully, never raise."""
    try:
        torch = mm._lazy_torch()
        if torch.cuda.is_available():
            return torch.cuda.memory_allocated() / (1024 ** 2)
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            driver = getattr(torch.mps, "driver_allocated_memory", None)
            if driver:
                return driver() / (1024 ** 2)
    except Exception:
        pass
    return 0.0


def _asr_device() -> str:
    """Where the ASR pipe actually lives, rather than a hardcoded 'cpu'."""
    pipe = getattr(mm.model, "_asr_pipe", None)
    for attr in ("device",):
        dev = getattr(pipe, attr, None)
        if dev is not None:
            return str(dev)
    return "cpu"


def _active_tts_id() -> Optional[str]:
    """Configured TTS engine id, or None if it can't be resolved. Attribution
    is advisory — a prefs/import hiccup must never break /model/loaded."""
    try:
        from services.tts_backend import active_backend_id
        return active_backend_id()
    except Exception:
        return None


def _tts_attribution(engine_id: str, active: Optional[str]) -> dict:
    """Per-entry engine attribution for TTS-family models. A model can stay
    resident in VRAM after the user switches engines (freed only by unload/
    idle-evict), so the panel needs to know which entry synthesis actually
    routes to. ``is_active_engine`` is None when the active id is unknown."""
    return {
        "engine_id": engine_id,
        "is_active_engine": (engine_id == active) if active is not None else None,
    }


def list_loaded() -> dict:
    """Enumerate every currently-loaded model. Shape: ``{"models": [...],
    "count": n}`` with per-model id/name/checkpoint/device/vram_mb/unloadable
    (+ optional ``note``)."""
    models: list[dict] = []
    active_tts = _active_tts_id()

    # 1. In-process TTS model (OmniVoice)
    if mm.model is not None:
        try:
            device = str(next(mm.model.parameters()).device) if hasattr(mm.model, "parameters") else get_best_device()
        except Exception:
            device = get_best_device()
        models.append({
            "id": "tts",
            "name": "OmniVoice TTS",
            "checkpoint": mm.resolve_omnivoice_checkpoint(),  # #693: effective checkpoint, not a leaked raw value
            "device": device,
            "vram_mb": round(_tts_vram_mb(), 1),
            "unloadable": True,
            **_tts_attribution("omnivoice", active_tts),
        })

    # 2. ASR (WhisperX) — co-loaded with and released alongside the TTS model.
    #    Honest reporting (MM2-03): the device is read from the pipe, and the
    #    dead "unload" button is explained by a note rather than left silent.
    if mm.model is not None and getattr(mm.model, "_asr_pipe", None) is not None:
        models.append({
            "id": "asr",
            "name": "WhisperX ASR",
            "checkpoint": os.environ.get("ASR_MODEL", "Systran/faster-whisper-large-v3"),
            "device": _asr_device(),
            "vram_mb": 0,
            "unloadable": False,
            "note": "released with the TTS model",
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

    # 4. Subprocess engine sidecars — each holds a process (and on GPU, VRAM)
    #    until idle-reaped. VRAM is reported by the child itself when available
    #    (MM2-08); 0 means CPU-only or not-yet-measured. Enumeration must never
    #    break the panel.
    try:
        from services.subprocess_backend import list_live_sidecars
        for s in list_live_sidecars():
            models.append({
                "id": f"sidecar:{s['id']}",
                "name": f"{s['id']} (sidecar)",
                "checkpoint": s["id"],
                "device": get_best_device(),
                "vram_mb": round(float(s.get("vram_mb") or 0), 1),
                "unloadable": True,
                **_tts_attribution(s["id"], active_tts),
            })
    except Exception:
        pass

    return {"models": models, "count": len(models)}


async def unload(model_id: str) -> dict:
    """Unload one model by id. Preserves the original per-id response shapes.

    ``tts`` | ``diarization`` | ``sidecar:<id>`` | ``sidecars``. Raises
    ValueError for an unknown id (router maps to HTTP 400)."""
    if model_id == "sidecars" or model_id.startswith("sidecar:"):
        from services.subprocess_backend import unload_all_sidecars, unload_sidecar
        n = unload_all_sidecars() if model_id == "sidecars" else unload_sidecar(model_id.split(":", 1)[1])
        return {"unloaded": model_id, "success": n > 0, "count": n,
                **({} if n > 0 else {"reason": "not running or busy"})}

    if model_id == "tts":
        async with mm._model_lock:
            if mm.model is not None:
                mm.model = None
                mm.free_vram()
                return {"unloaded": "tts", "success": True}
        return {"unloaded": "tts", "success": False, "reason": "not loaded"}

    if model_id == "diarization":
        if mm._diar_pipeline is not None:
            mm._diar_pipeline = None
            mm.free_vram()
            return {"unloaded": "diarization", "success": True}
        return {"unloaded": "diarization", "success": False, "reason": "not loaded"}

    raise ValueError(f"Unknown model id: {model_id}")


async def unload_all() -> dict:
    """Release every releasable model — in-process TTS + diarization + all
    sidecars. Convenience for app shutdown / a global flush."""
    results = {}
    for mid in ("tts", "diarization", "sidecars"):
        try:
            results[mid] = await unload(mid)
        except Exception as exc:  # noqa: BLE001
            results[mid] = {"unloaded": mid, "success": False, "reason": str(exc)}
    return {"unloaded_all": True, "results": results}


def free_vram() -> None:
    """One import surface for callers that just want to drop GPU caches."""
    mm.free_vram()
