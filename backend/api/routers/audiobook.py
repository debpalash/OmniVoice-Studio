"""Audiobook creator endpoints (parity Wave 5).

First cut: a pure *plan preview*. ``POST /audiobook/plan`` parses a
chapter-delimited script (Markdown ``# H1`` chapters, inline ``[voice:NAME]``
and ``[pause …]``) into the chapter/span plan the UI renders before kicking off
synthesis — no TTS, no ffmpeg, no side effects.

The streaming synth job (chapters → chapterized m4b via the active TTS backend
+ ``services.audiobook.build_m4b_cmd``) is the planned follow-up.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from services.audiobook import parse_audiobook_script

router = APIRouter()


class AudiobookPlanRequest(BaseModel):
    text: str
    default_voice: str | None = None


@router.post("/audiobook/plan")
def audiobook_plan(req: AudiobookPlanRequest) -> dict:
    """Parse a script into a chapter/span plan (pure preview, no synthesis)."""
    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)
    return plan.to_dict()
