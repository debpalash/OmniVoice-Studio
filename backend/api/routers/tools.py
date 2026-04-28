"""
Tools router — Phase 4.6 (ROADMAP.md).

Standalone utilities exposed as first-class endpoints, independent of the
dub pipeline. The Tools page UI consumes these. Headless CLI consumers
(omnivoice-dub) will share the same service layer.

Shipped today:

    POST /tools/probe       → ffprobe-style metadata for a file path.
    POST /tools/incremental → plan what segments need regenerating.
    POST /tools/direction   → parse a natural-language direction into tokens.
    POST /tools/rate-fit    → LLM-assisted slot-fit for translated text.

More utilities (vocal separation, alignment, merge) are wired through
existing dub helpers and land in follow-up passes.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import director, speech_rate, incremental
from services.ffmpeg_utils import find_ffmpeg

logger = logging.getLogger("omnivoice.tools")
router = APIRouter()


# ── Probe (ffprobe wrapper) ────────────────────────────────────────────────


class ProbeReq(BaseModel):
    path: str


@router.post("/tools/probe")
async def probe(req: ProbeReq):
    target = os.path.realpath(os.path.expanduser(req.path))
    if not os.path.exists(target):
        raise HTTPException(
            status_code=404,
            detail="File not found. Provide an absolute path to an existing file.",
        )
    ffprobe = find_ffmpeg().replace("ffmpeg", "ffprobe")
    if not os.path.exists(ffprobe):
        raise HTTPException(
            status_code=500,
            detail="ffprobe binary not available alongside ffmpeg.",
        )
    proc = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", target,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"ffprobe failed: {stderr.decode(errors='replace')[:400]}",
        )
    try:
        return json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError:
        return {"raw": stdout.decode("utf-8", errors="replace")}


# ── Incremental plan (what needs regenerating) ─────────────────────────────


class IncrementalReq(BaseModel):
    segments: list[dict]
    stored_hashes: Optional[dict[str, str]] = None


@router.post("/tools/incremental")
def plan_incremental(req: IncrementalReq):
    return incremental.plan_incremental(
        req.segments,
        stored_hashes=req.stored_hashes or {},
    )


# ── Directorial AI parse ───────────────────────────────────────────────────


class DirectionReq(BaseModel):
    text: str = Field(..., description="Natural-language direction, e.g. 'urgent and surprised'")


@router.post("/tools/direction")
def parse_direction(req: DirectionReq):
    d = director.parse(req.text)
    return {
        "tokens":          d.tokens,
        "instruct_prompt": d.instruct_prompt(),
        "translate_hint":  d.translate_hint(),
        "rate_bias":       d.rate_bias(),
        "method":          d.method,
        "error":           d.error,
        "taxonomy":        director.TAXONOMY,
    }


# ── Speech-rate fit ────────────────────────────────────────────────────────


class RateFitReq(BaseModel):
    text: str
    slot_seconds: float
    target_lang: str
    source_text: Optional[str] = None


@router.post("/tools/rate-fit")
def rate_fit(req: RateFitReq):
    return speech_rate.adjust_for_slot(
        req.text,
        slot_seconds=req.slot_seconds,
        target_lang=req.target_lang,
        source_text=req.source_text,
    )


# ── Audio effects presets ──────────────────────────────────────────────────


@router.get("/tools/effects")
def list_effects():
    """Return available audio effect presets (Broadcast, Cinematic, etc.)."""
    from services.audio_dsp import list_effect_presets
    return list_effect_presets()

