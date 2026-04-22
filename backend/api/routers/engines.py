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
from services import tts_backend, asr_backend, llm_backend, translation_engines

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


@router.get("/engines/translation")
def list_translation_engines():
    """Translation engines with per-engine pip-package availability.

    Separate from the tts/asr/llm "family" endpoints because these are
    pip-installable on demand rather than select-from-what's-available.
    The UI uses this to show a one-click Install chip when the user picks
    an engine whose Python dependency isn't importable yet.
    """
    return {
        "engines": translation_engines.list_engines(),
        "sandboxed": translation_engines.is_frozen(),
    }


@router.post("/engines/translation/{engine_id}/install")
async def install_translation_engine(engine_id: str):
    entry = translation_engines.get_engine(engine_id)
    if not entry:
        raise HTTPException(status_code=404, detail=f"Unknown translation engine: {engine_id!r}")
    if translation_engines.is_frozen():
        raise HTTPException(
            status_code=400,
            detail=(
                "Engine install is disabled in the packaged build — the "
                "bundled Python environment is read-only and signed. Run the "
                "source/dev install (`uv sync`) if you need to add an engine."
            ),
        )
    pkg = entry.get("pip_package")
    if not pkg:
        return {"status": "already_installed", "engine": engine_id, "reason": "no pip package required"}
    if translation_engines.is_installed(engine_id):
        return {"status": "already_installed", "engine": engine_id}
    rc, out = await translation_engines.run_pip(["install", pkg])
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"pip install {pkg} failed ({rc}): {out[-1000:]}")
    # Probe again so the response reflects post-install reality; site-packages
    # is visible immediately but importlib may have cached a failure.
    import importlib
    importlib.invalidate_caches()
    ok = translation_engines.is_installed(engine_id)
    return {
        "status": "installed" if ok else "installed_but_probe_failed",
        "engine": engine_id,
        "package": pkg,
        "log_tail": out[-800:],
        "restart_required": not ok,
    }


@router.delete("/engines/translation/{engine_id}")
async def uninstall_translation_engine(engine_id: str):
    entry = translation_engines.get_engine(engine_id)
    if not entry:
        raise HTTPException(status_code=404, detail=f"Unknown translation engine: {engine_id!r}")
    if entry.get("builtin"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{entry['display_name']} is built-in and cannot be uninstalled. "
                "It shares its Python dependency with core features."
            ),
        )
    if translation_engines.is_frozen():
        raise HTTPException(status_code=400, detail="Engine uninstall is disabled in packaged builds.")
    pkg = entry.get("pip_package")
    if not pkg:
        return {"status": "no_op", "engine": engine_id}
    rc, out = await translation_engines.run_pip(["uninstall", "-y", pkg])
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"pip uninstall {pkg} failed ({rc}): {out[-1000:]}")
    return {"status": "uninstalled", "engine": engine_id, "package": pkg, "log_tail": out[-800:]}


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
