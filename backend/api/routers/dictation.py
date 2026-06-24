"""
Dictation router — sherpa-onnx live-dictation engine.

Exposes the seven sherpa-onnx dictation models and the dictation prefs the
frontend dictation UI binds to.

    GET  /dictation/models   → the 7 models + install state (frontend model list)
    GET  /dictation/prefs    → { enabled, mode, model_id }
    POST /dictation/prefs    → persist any subset of those prefs

Install state reuses the same HF-cache check the model store uses, so a model
shown "installed" here is the same snapshot the backend will load.

Prefs are stored in the shared ``prefs.json`` store under the ``dictation.*``
namespace (``dictation.enabled``, ``dictation.mode``, ``dictation.model_id``),
mirroring how the ASR/TTS engine picks persist.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from api.dependencies import require_loopback
from core import prefs
from services import sherpa_dictation as sd

router = APIRouter()
logger = logging.getLogger("omnivoice.dictation")

# Pref keys (the binding contract — the frontend writes exactly these).
PREF_ENABLED = "dictation.enabled"
PREF_MODE = "dictation.mode"
PREF_MODEL_ID = "dictation.model_id"

_DEFAULT_ENABLED = True
_DEFAULT_MODE = "toggle"
_VALID_MODES = ("toggle", "hold")


def _read_prefs() -> dict:
    mid = prefs.get(PREF_MODEL_ID, sd.DEFAULT_MODEL_ID)
    if not sd.is_sherpa_model(mid):
        mid = sd.DEFAULT_MODEL_ID
    mode = prefs.get(PREF_MODE, _DEFAULT_MODE)
    if mode not in _VALID_MODES:
        mode = _DEFAULT_MODE
    return {
        "enabled": bool(prefs.get(PREF_ENABLED, _DEFAULT_ENABLED)),
        "mode": mode,
        "model_id": mid,
    }


@router.get("/dictation/models", dependencies=[Depends(require_loopback)])
def list_dictation_models():
    """The seven sherpa-onnx dictation models + install state.

    Each entry: id, repo_id, label, tag ("offline"|"streaming"), recommended,
    size_gb, languages, kind, and install state (installed/installing). The
    ``installed`` flag is computed from the same HF cache the model store reads,
    so it matches the model-store row state.
    """
    available, reason = sd.sherpa_available()
    out = []
    for spec in sd.list_specs():
        out.append({
            "id": spec.id,
            "repo_id": spec.repo_id,
            "label": spec.label,
            "tag": spec.tag,
            "recommended": spec.recommended,
            "size_gb": spec.size_gb,
            "languages": spec.languages,
            "kind": spec.kind,
            "installed": sd.is_installed(spec),
        })
    return {
        "models": out,
        "engine_available": available,
        "engine_reason": None if available else reason,
        "default_model_id": sd.DEFAULT_MODEL_ID,
    }


@router.get("/dictation/prefs", dependencies=[Depends(require_loopback)])
def get_dictation_prefs():
    return _read_prefs()


class DictationPrefsUpdate(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[str] = None
    model_id: Optional[str] = None


@router.post("/dictation/prefs", dependencies=[Depends(require_loopback)])
def set_dictation_prefs(req: DictationPrefsUpdate):
    """Persist any subset of the dictation prefs. Validates ``mode`` and
    ``model_id`` so a bad value can't wedge the capture engine."""
    if req.mode is not None:
        if req.mode not in _VALID_MODES:
            raise HTTPException(
                status_code=400,
                detail=f"mode must be one of {_VALID_MODES}",
            )
        prefs.set_(PREF_MODE, req.mode)
    if req.model_id is not None:
        if not sd.is_sherpa_model(req.model_id):
            raise HTTPException(
                status_code=400,
                detail=f"unknown dictation model_id {req.model_id!r}",
            )
        # Normalise to the canonical dictation id (accept repo_id too).
        prefs.set_(PREF_MODEL_ID, sd.get_spec(req.model_id).id)
    if req.enabled is not None:
        prefs.set_(PREF_ENABLED, bool(req.enabled))
    # Rebuild the cached capture singleton so the change takes effect at once.
    try:
        from services import asr_backend
        asr_backend._capture_backend = None
        asr_backend._capture_backend_key = None
    except Exception:
        pass
    return _read_prefs()
