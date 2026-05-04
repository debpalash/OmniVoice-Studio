"""
Streaming ASR via WebSocket — live partial transcription results.

Client streams audio chunks (PCM/WebM) and receives partial + final
transcription JSON messages in real-time. Used by CaptureButton for
live dictation feedback.

Protocol:
    → Client sends binary audio frames (16-bit PCM or WebM/Opus blobs)
    ← Server sends JSON messages:
        {"type": "partial", "text": "Hello wor..."}      — interim result
        {"type": "final",   "text": "Hello world.",       — committed result
         "segments": [...], "language": "en",
         "duration_s": 4.2, "transcription_time_s": 0.8,
         "engine": "mlx-whisper"}
        {"type": "error",   "detail": "..."}              — error
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import tempfile
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()
logger = logging.getLogger("omnivoice.capture_ws")

# How often (seconds) to run transcription on the accumulated buffer.
# Shorter = more responsive but more GPU load.
PARTIAL_INTERVAL_S = float(os.environ.get("OMNIVOICE_STREAM_INTERVAL", "2.0"))

# Maximum silence before we auto-finalize (seconds of no new audio).
SILENCE_TIMEOUT_S = float(os.environ.get("OMNIVOICE_STREAM_SILENCE", "3.0"))

# Minimum buffer size before first partial (bytes of raw audio).
MIN_BUFFER_BYTES = 64000  # ~2s of 16-bit mono 16kHz — needs enough WebM frames for ffmpeg

# Minimum buffer for final transcription — much lower since we always want
# to transcribe whatever the user recorded, even short utterances.
MIN_FINAL_BUFFER_BYTES = 4000  # ~125ms of 16-bit mono 16kHz


@router.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket):
    """Stream audio in, get partial + final transcription out."""
    await websocket.accept()

    audio_chunks: list[bytes] = []
    total_bytes = 0
    last_audio_time = time.monotonic()
    running = True
    partial_text = ""
    # Track whether the client initiated the disconnect. When True the
    # WebSocket is already in a closed/closing state and any attempt to
    # call `send_json()` will raise "Unexpected ASGI message".
    client_disconnected = False

    async def receive_audio():
        """Receive audio frames from the client.

        Two end-of-stream signals: (a) text frame ``"EOF"`` (preferred —
        keeps the socket open so the ``final`` message can still be sent
        before the client closes), or (b) socket disconnect (legacy path).
        The EOF protocol exists so the client can use the WS ``final``
        message as the authoritative result and skip the duplicate HTTP
        POST that used to run on every dictation.
        """
        nonlocal total_bytes, last_audio_time, running, client_disconnected
        try:
            while running:
                msg = await websocket.receive()
                msg_type = msg.get("type")
                if msg_type == "websocket.disconnect":
                    client_disconnected = True
                    running = False
                    break
                if msg_type != "websocket.receive":
                    continue
                data = msg.get("bytes")
                if data is not None:
                    if len(data) == 0:
                        # Empty binary frame also acts as EOF — connection stays open.
                        running = False
                        break
                    audio_chunks.append(data)
                    total_bytes += len(data)
                    last_audio_time = time.monotonic()
                    continue
                if msg.get("text") == "EOF":
                    # Client signals end-of-audio but stays connected for `final`.
                    running = False
                    break
        except WebSocketDisconnect:
            client_disconnected = True
            running = False
        except Exception as e:
            logger.debug("WS receive ended: %s", e)
            client_disconnected = True
            running = False

    async def _safe_send(payload: dict) -> bool:
        """Send JSON to the client, returning False if the connection is gone."""
        if client_disconnected:
            return False
        try:
            await websocket.send_json(payload)
            return True
        except Exception:
            return False

    async def process_partials():
        """Periodically transcribe the accumulated buffer for partial results."""
        nonlocal partial_text, running

        while running:
            await asyncio.sleep(PARTIAL_INTERVAL_S)

            if not running:
                break

            # Check silence timeout
            if time.monotonic() - last_audio_time > SILENCE_TIMEOUT_S and total_bytes > MIN_BUFFER_BYTES:
                running = False
                break

            if total_bytes < MIN_BUFFER_BYTES:
                continue

            # Transcribe current buffer
            try:
                text = await _transcribe_buffer(audio_chunks[:])
                if text and text != partial_text:
                    partial_text = text
                    await _safe_send({
                        "type": "partial",
                        "text": text,
                    })
            except Exception as e:
                logger.warning("Partial transcription failed: %s", e)

    # Run receiver and processor concurrently
    receiver_task = asyncio.create_task(receive_audio())
    processor_task = asyncio.create_task(process_partials())

    # Wait for either to finish (receiver ends on disconnect, processor on silence)
    done, pending = await asyncio.wait(
        [receiver_task, processor_task],
        return_when=asyncio.FIRST_COMPLETED,
    )
    running = False
    for task in pending:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    # Final transcription on complete buffer — skip if client already gone.
    if total_bytes > MIN_FINAL_BUFFER_BYTES:
        try:
            result = await _transcribe_buffer_full(audio_chunks)
            if not await _safe_send({"type": "final", **result}):
                logger.debug("Skipped final send — client already disconnected")
        except Exception as e:
            logger.error("Final transcription failed: %s", e)
            await _safe_send({"type": "error", "detail": str(e)})
    else:
        await _safe_send({
            "type": "final",
            "text": "",
            "segments": [],
            "language": "unknown",
            "duration_s": 0,
            "transcription_time_s": 0,
            "engine": "none",
        })

    if not client_disconnected:
        try:
            await websocket.close()
        except Exception:
            pass


async def _transcribe_buffer(chunks: list[bytes]) -> str:
    """Quick partial transcription of the current audio buffer."""
    import soundfile as sf
    import numpy as np

    tmp = _chunks_to_wav(chunks)
    if tmp is None:
        return ""

    try:
        from services.model_manager import _gpu_pool
        from services.asr_backend import get_capture_asr_backend

        def _run():
            backend = get_capture_asr_backend()
            result = backend.transcribe(tmp, word_timestamps=False)
            return result.get("text", "")

        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(_gpu_pool, _run)
        return text.strip()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


async def _transcribe_buffer_full(chunks: list[bytes]) -> dict:
    """Full transcription with timing info for the final result."""
    tmp = _chunks_to_wav(chunks)
    if tmp is None:
        return {"text": "", "segments": [], "language": "unknown",
                "duration_s": 0, "transcription_time_s": 0, "engine": "none"}

    try:
        from services.model_manager import _gpu_pool
        from services.asr_backend import get_capture_asr_backend

        def _run():
            backend = get_capture_asr_backend()
            t0 = time.perf_counter()
            result = backend.transcribe(tmp, word_timestamps=False)
            elapsed = round(time.perf_counter() - t0, 2)

            segments = result.get("segments", [])
            full_text = result.get("text", "")
            if not full_text and segments:
                full_text = " ".join(s.get("text", "") for s in segments).strip()

            duration = max((s.get("end", 0) for s in segments), default=0.0)

            return {
                "text": full_text,
                "segments": [
                    {"start": round(s.get("start", 0), 2),
                     "end": round(s.get("end", 0), 2),
                     "text": s.get("text", "").strip()}
                    for s in segments
                ],
                "language": result.get("language", "unknown"),
                "duration_s": round(duration, 2),
                "transcription_time_s": elapsed,
                "engine": backend.id,
            }

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_gpu_pool, _run)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _chunks_to_wav(chunks: list[bytes]) -> str | None:
    """Concatenate audio chunks and write to a temp WAV file.

    Handles both raw PCM (from AudioWorklet) and WebM/Opus blobs
    (from MediaRecorder) by converting through ffmpeg.

    Falls back to saving raw WebM if ffmpeg conversion fails — the ASR
    backends (MLX Whisper, WhisperX) can decode WebM/Opus natively.
    """
    if not chunks:
        return None

    blob = b"".join(chunks)
    if len(blob) < 100:
        return None

    # Write blob to temp file
    tmp_in = tempfile.NamedTemporaryFile(delete=False, suffix=".webm")
    tmp_in.write(blob)
    tmp_in.close()

    tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    tmp_out.close()

    try:
        from services.ffmpeg_utils import find_ffmpeg
        import subprocess
        subprocess.run(
            [find_ffmpeg(), "-y", "-i", tmp_in.name,
             "-ar", "16000", "-ac", "1", "-f", "wav", tmp_out.name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=True,
        )
        # ffmpeg succeeded — clean up input, return WAV
        try:
            os.unlink(tmp_in.name)
        except OSError:
            pass
        return tmp_out.name
    except Exception as e:
        logger.debug("ffmpeg conversion failed: %s", e)
        try:
            os.unlink(tmp_out.name)
        except OSError:
            pass
        # Fallback: return the raw WebM — ASR backends (MLX Whisper,
        # WhisperX) can decode WebM/Opus containers natively.
        logger.debug("Falling back to raw WebM input for ASR")
        return tmp_in.name

