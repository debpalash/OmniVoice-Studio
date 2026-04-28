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
    mode: Optional[str] = Form(None),
):
    """Transcribe an audio file to text.

    Args:
        audio: The audio file to transcribe.
        language: Optional language hint (not currently used; auto-detected).
        model: Whisper model size (legacy; ignored in dual-mode architecture).
        mode: 'fast' (default) uses MLX Turbo for speed; 'accurate' uses
              WhisperX with forced alignment for word-level timing.

    Returns:
        {
            "text": "full transcription",
            "segments": [ {"start": 0.0, "end": 1.5, "text": "..."}, ... ],
            "language": "en",
            "duration_s": 4.2,
            "transcription_time_s": 0.8,
            "engine": "mlx-whisper"
        }
    """
    import asyncio

    # Save upload to a temp file (all backends need a file path)
    ext = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        content = await audio.read()
        tmp.write(content)
        tmp.close()

        use_accurate = (mode or "").strip().lower() == "accurate"

        def _run():
            if use_accurate:
                # Accurate mode: full WhisperX with forced alignment —
                # for when the user explicitly wants word-level timing.
                from services.asr_backend import get_active_asr_backend
                backend = get_active_asr_backend()
                result = backend.transcribe(tmp.name, word_timestamps=True)
            else:
                # Fast mode (default): use the fastest available engine
                # (MLX Turbo on Apple Silicon). Skip word_timestamps for
                # ~30% latency reduction — dictation doesn't need them.
                from services.asr_backend import get_capture_asr_backend
                backend = get_capture_asr_backend()
                result = backend.transcribe(tmp.name, word_timestamps=False)
            return result, backend.id

        from services.model_manager import _gpu_pool
        loop = asyncio.get_event_loop()
        t0 = time.perf_counter()
        result, engine_id = await loop.run_in_executor(_gpu_pool, _run)
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

        logger.info(
            "Capture transcription done: engine=%s, elapsed=%.2fs, duration=%.1fs, mode=%s",
            engine_id, elapsed, duration, "accurate" if use_accurate else "fast",
        )

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
            "engine": engine_id,
        }
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
