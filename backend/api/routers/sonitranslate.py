"""SoniTranslate engine endpoints.

Provides status, install, start/stop, and dub operations for the
SoniTranslate sidecar integration.
"""

import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from services import sonitranslate as soni

router = APIRouter(prefix="/engines/sonitranslate", tags=["SoniTranslate"])
logger = logging.getLogger("omnivoice.api")


# ── Status ──────────────────────────────────────────────────────────────


@router.get("/status")
def sonitranslate_status():
    """Check SoniTranslate availability."""
    return soni.status()


# ── Install ─────────────────────────────────────────────────────────────


@router.post("/install")
async def sonitranslate_install():
    """Clone and set up SoniTranslate (heavy — ~15GB with models)."""
    try:
        result = await soni.install()
        return result
    except Exception as e:
        logger.exception("SoniTranslate install failed")
        raise HTTPException(status_code=500, detail=str(e))


# ── Start / Stop ────────────────────────────────────────────────────────


@router.post("/start")
async def sonitranslate_start():
    """Start the SoniTranslate Gradio server."""
    try:
        result = await soni.start()
        return result
    except Exception as e:
        logger.exception("SoniTranslate start failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/stop")
async def sonitranslate_stop():
    """Stop the SoniTranslate Gradio server."""
    result = await soni.stop()
    return result


# ── Dub ─────────────────────────────────────────────────────────────────


class DubRequest(BaseModel):
    video_path: str
    target_language: str = "Spanish (es)"
    source_language: str = "Automatic detection"
    tts_voice: str = "es-ES-AlvaroNeural-Male"
    max_speakers: int = 1
    output_dir: Optional[str] = None


@router.post("/dub")
async def sonitranslate_dub(body: DubRequest):
    """Run full dubbing pipeline via SoniTranslate.

    Transcribes, translates, generates TTS, and mixes audio.
    Returns the path to the dubbed output video.

    KNOWN PROVENANCE GAP (#1169, documented — not silently ignored): the
    dubbed audio is synthesized and muxed entirely inside the external
    SoniTranslate sidecar (its own venv + gradio pipeline, Edge-TTS voices),
    which hands back a finished video file. VoiceStudio's tensor-stage
    mark_synthetic chokepoint never sees that audio; marking it would require
    a demux → embed → re-mux post-pass on the sidecar's output, which is a
    lossy re-encode of a pipeline we don't control. This opt-in engine
    (explicit install + start) is therefore NOT covered by the invisible
    AudioSeal provenance mark that every built-in synthesis path carries.
    """
    try:
        result = await soni.dub_video(
            video_path=body.video_path,
            target_language=body.target_language,
            source_language=body.source_language,
            tts_voice=body.tts_voice,
            max_speakers=body.max_speakers,
            output_dir=body.output_dir,
        )
        return result
    except Exception as e:
        logger.exception("SoniTranslate dub failed")
        raise HTTPException(status_code=500, detail=str(e))
