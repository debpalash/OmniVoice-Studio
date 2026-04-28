"""
Standalone transcription endpoint for the Capture / Dictation feature.

Unlike /dub/transcribe/{job_id}, this endpoint is job-free — callers POST
raw audio bytes and get back transcribed text immediately.  Used by:

    • The frontend "Capture" (global hotkey dictation) mode
    • The MCP server's future `transcribe_audio` tool
    • CLI consumers that just want speech-to-text

The ASR engine is whatever `get_active_asr_backend()` returns — WhisperX
by default, or MLX Whisper on Apple Silicon when configured.
"""
from __future__ import annotations

import io
import logging
import os
import tempfile
import time

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from typing import Optional

router = APIRouter()
logger = logging.getLogger("omnivoice.capture")


@router.post("/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    language: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
):
    """Transcribe an audio file to text.

    Args:
        audio: The audio file to transcribe.
        language: Optional language hint (not currently used; auto-detected).
        model: Whisper model size ('tiny', 'base', 'small', 'medium', 'large-v3').
               Defaults to the server's configured ASR model.

    Returns:
        {
            "text": "full transcription",
            "segments": [ {"start": 0.0, "end": 1.5, "text": "..."}, ... ],
            "language": "en",
            "duration_s": 4.2,
            "transcription_time_s": 0.8
        }
    """
    from services.model_manager import get_model, _gpu_pool
    import asyncio

    _model = await get_model()
    if _model._asr_pipe is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "ASR model isn't loaded. Wait for the model to finish warming "
                "up, or check Settings → Models."
            ),
        )

    # Save upload to a temp file (WhisperX needs a file path)
    ext = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        content = await audio.read()
        tmp.write(content)
        tmp.close()

        chosen_model = model  # captured in closure

        def _run():
            from services.asr_backend import get_active_asr_backend

            backend = get_active_asr_backend(asr_pipe=_model._asr_pipe)
            # If user chose a specific model and the backend supports it,
            # override the default. Otherwise fall through to the default.
            if chosen_model and hasattr(backend, 'model_size'):
                backend.model_size = chosen_model
            result = backend.transcribe(tmp.name)
            return result

        loop = asyncio.get_event_loop()
        t0 = time.perf_counter()
        result = await loop.run_in_executor(_gpu_pool, _run)
        elapsed = round(time.perf_counter() - t0, 2)

        # Normalize result shape
        segments = result.get("segments", [])
        full_text = result.get("text", "")
        if not full_text and segments:
            full_text = " ".join(s.get("text", "") for s in segments).strip()

        # Calculate audio duration from segments if available
        duration = 0.0
        if segments:
            duration = max(s.get("end", 0) for s in segments)

        detected_lang = result.get("language", language or "unknown")

        return {
            "text": full_text,
            "segments": [
                {
                    "start": round(s.get("start", 0), 2),
                    "end": round(s.get("end", 0), 2),
                    "text": s.get("text", "").strip(),
                }
                for s in segments
            ],
            "language": detected_lang,
            "duration_s": round(duration, 2),
            "transcription_time_s": elapsed,
        }
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
