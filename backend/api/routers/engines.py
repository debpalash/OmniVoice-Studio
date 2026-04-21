"""
Engines router — Phase 3 wiring.

Exposes the three adapter registries (TTS, ASR, LLM) so the Settings UI can
render an engine picker + availability reasons.

    GET  /engines                     → { tts, asr, llm }
    GET  /engines/{family}            → list of backends
    POST /engines/select              → persist a backend choice in prefs.json

Environment variables (`OMNIVOICE_TTS_BACKEND`, `OMNIVOICE_ASR_BACKEND`,
`OMNIVOICE_LLM_BACKEND`) still win over the UI choice so power-users can pin
a backend without Settings silently undoing it.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core import prefs
from services import tts_backend, asr_backend, llm_backend

router = APIRouter()

_FAMILIES = {
    "tts": (tts_backend, "tts_backend"),
    "asr": (asr_backend, "asr_backend"),
    "llm": (llm_backend, "llm_backend"),
}


@router.get("/engines")
def list_all_engines():
    return {
        "tts": {
            "active": tts_backend.active_backend_id(),
            "backends": tts_backend.list_backends(),
        },
        "asr": {
            "active": asr_backend.active_backend_id(),
            "backends": asr_backend.list_backends(),
        },
        "llm": {
            "active": llm_backend.active_backend_id(),
            "backends": llm_backend.list_backends(),
        },
    }


@router.get("/engines/tts")
def list_tts_backends():
    return {"active": tts_backend.active_backend_id(), "backends": tts_backend.list_backends()}


@router.get("/engines/asr")
def list_asr_backends():
    return {"active": asr_backend.active_backend_id(), "backends": asr_backend.list_backends()}


@router.get("/engines/llm")
def list_llm_backends():
    return {"active": llm_backend.active_backend_id(), "backends": llm_backend.list_backends()}


class SelectEngineRequest(BaseModel):
    family: str   # "tts" | "asr" | "llm"
    backend_id: str


@router.post("/engines/select")
def select_engine(req: SelectEngineRequest):
    """Persist a family's engine pick to prefs.json. Refuses unknown backends
    + refuses backends whose deps aren't installed (so the UI can't silently
    brick a pipeline by picking an unavailable engine)."""
    family = _FAMILIES.get(req.family)
    if not family:
        raise HTTPException(400, f"Unknown family: {req.family}. Expected one of tts/asr/llm.")
    module, pref_key = family
    available = {b["id"]: b for b in module.list_backends()}
    if req.backend_id not in available:
        raise HTTPException(400, f"Unknown {req.family} backend: {req.backend_id!r}")
    if not available[req.backend_id]["available"]:
        reason = available[req.backend_id].get("reason") or "unavailable"
        raise HTTPException(400, f"Backend {req.backend_id} not ready: {reason}")
    prefs.set_(pref_key, req.backend_id)
    return {
        "family": req.family,
        "active": module.active_backend_id(),
        "env_override": bool(__import__("os").environ.get(f"OMNIVOICE_{req.family.upper()}_BACKEND")),
    }
