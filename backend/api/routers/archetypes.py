"""Voice-gallery archetype API.

Serves the catalog of *designed* voice archetypes from ``core.archetypes`` and
renders previews / materializes them into voice profiles on demand.

Design notes
============
* All heavy imports (the TTS model, torch) are deferred into the render
  functions so this module imports cleanly in test/CI environments without
  model weights. The pure endpoints (categories / list / get) and the preview
  *cache-hit* path never touch the model.
* Rendering reuses generation.py's proven ``_run_inference`` / ``get_model`` /
  ``_safe_torchaudio_save`` rather than re-deriving the ``model.generate``
  signature — one inference code path, one place to keep correct.
* Previews are cached on disk keyed by a hash of (instruct, language), so two
  archetypes that resolve to the same voice share a cache file and the cold
  render only happens once per distinct voice.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from core import archetypes
from core.config import OUTPUTS_DIR, VOICES_DIR

logger = logging.getLogger("omnivoice.archetypes")

router = APIRouter()

_PREVIEW_DIR = Path(OUTPUTS_DIR) / "archetype_previews"
# Seed fixed so repeated renders of the same archetype are reproducible
# (mirrors scripts/render_demos_omnivoice.py).
_PREVIEW_SEED = 42


def _preview_key(a: dict) -> str:
    # Deterministic cache key, not a security digest. SHA-256 (not SHA-1) so the
    # SAST scanners don't flag it as a weak hash.
    return hashlib.sha256(
        f"{a['instruct']}|{a['language']}".encode("utf-8")
    ).hexdigest()[:16]


async def _render_archetype_wav(a: dict, out_path: Path) -> None:
    """Render an archetype's sample script to ``out_path`` using the live engine.

    Reuses generation.py's inference primitives so there is exactly one TTS
    code path. Heavy deps are imported here, never at module load.
    """
    from api.routers.generation import (  # noqa: WPS433 — intentional lazy import
        get_model,
        _run_inference,
        _gpu_pool,
        _safe_torchaudio_save,
    )

    model = await get_model()
    language = a["language"]
    if language in (None, "", "Auto"):
        language = None

    loop = asyncio.get_running_loop()
    audio_tensor = await loop.run_in_executor(
        _gpu_pool,
        _run_inference,
        model,                # _model
        a["sample_script"],   # text
        language,             # language
        None,                 # ref_audio_path (design mode — no reference)
        None,                 # ref_text
        a["instruct"],        # instruct
        None,                 # duration
        16,                   # num_step
        2.0,                  # guidance_scale
        1.0,                  # speed
        None,                 # t_shift
        True,                 # denoise
        True,                 # postprocess_output
        None,                 # layer_penalty_factor
        None,                 # position_temperature
        None,                 # class_temperature
        _PREVIEW_SEED,        # seed
        "broadcast",          # effect_preset
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _safe_torchaudio_save(str(out_path), audio_tensor, model.sampling_rate)


# ── Read endpoints (no model) ─────────────────────────────────────────────────
# NOTE: declare the literal `/archetypes/categories` before `/archetypes/{id}`
# so it isn't swallowed by the path-parameter route.
@router.get("/archetypes/categories")
def list_categories():
    """The seven use-case categories the gallery is organized by."""
    return archetypes.categories()


@router.get("/archetypes")
def list_archetypes_endpoint(
    use_case: Optional[str] = None,
    gender: Optional[str] = None,
    age: Optional[str] = None,
    pitch: Optional[str] = None,
    accent: Optional[str] = None,
    whisper: Optional[bool] = None,
    lang: Optional[str] = None,
    featured: Optional[bool] = None,
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Filtered, paginated view over the archetype catalog."""
    items = archetypes.list_archetypes(
        use_case=use_case, gender=gender, age=age, pitch=pitch,
        accent=accent, whisper=whisper, lang=lang, featured=featured,
    )
    total = len(items)
    page = items[offset:offset + limit]
    return {"total": total, "limit": limit, "offset": offset, "items": page}


@router.get("/archetypes/{archetype_id}")
def get_archetype_endpoint(archetype_id: str):
    a = archetypes.get_archetype(archetype_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Archetype not found")
    return a


# ── Render endpoints (model-gated) ────────────────────────────────────────────
@router.get("/archetypes/{archetype_id}/preview")
async def preview_archetype(archetype_id: str):
    """Serve a short preview clip — pre-rendered if cached, else render once."""
    a = archetypes.get_archetype(archetype_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Archetype not found")

    cache_path = _PREVIEW_DIR / f"{_preview_key(a)}.wav"
    if not cache_path.exists():
        try:
            await _render_archetype_wav(a, cache_path)
        except Exception as e:  # model missing / OOM / inference failure
            logger.error("Archetype preview render failed", exc_info=True)
            raise HTTPException(
                status_code=503,
                detail=(
                    "Couldn't render a preview right now — the voice engine is "
                    f"unavailable. See Settings → Logs → Backend. Error: {e}"
                ),
            )
    return FileResponse(str(cache_path), media_type="audio/wav")


@router.post("/archetypes/{archetype_id}/use")
async def use_archetype(archetype_id: str, name: Optional[str] = Query(None)):
    """Materialize an archetype into a reusable voice profile.

    Renders a reference sample (so the voice has a concrete identity and a
    preview) and inserts a ``voice_profiles`` row carrying the archetype's
    instruct + language. The profile then shows up everywhere voices are
    picked (Dub / Generate / Clone).
    """
    a = archetypes.get_archetype(archetype_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Archetype not found")

    from core import event_bus
    from core.db import db_conn

    profile_id = str(uuid.uuid4())[:8]
    audio_filename = f"{profile_id}.wav"
    audio_path = Path(VOICES_DIR) / audio_filename

    try:
        await _render_archetype_wav(a, audio_path)
    except Exception as e:
        logger.error("Archetype 'use' render failed", exc_info=True)
        raise HTTPException(
            status_code=503,
            detail=(
                "Couldn't create a voice from this archetype — the voice engine "
                f"is unavailable. See Settings → Logs → Backend. Error: {e}"
            ),
        )

    profile_name = (name or a["name"]).strip() or a["name"]
    try:
        with db_conn() as conn:
            conn.execute(
                "INSERT INTO voice_profiles "
                "(id, name, ref_audio_path, ref_text, instruct, language, seed, personality, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    profile_id, profile_name, audio_filename, a["sample_script"],
                    a["instruct"], a["language"], _PREVIEW_SEED, a["id"], time.time(),
                ),
            )
    except Exception:
        with __import__("contextlib").suppress(OSError):
            os.remove(audio_path)
        raise

    event_bus.emit("profiles", {"action": "created", "id": profile_id})
    return {"profile_id": profile_id, "name": profile_name}
