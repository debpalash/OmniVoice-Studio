"""
Streaming TTS via WebSocket — v1.0.x ultra-low-latency audio delivery.

Client sends a text request, server streams back audio chunks in real-time
as they're generated. This unlocks:
  • Real-time voice assistants (speak-back mode)
  • Dictation widget with live audio preview
  • Interactive dubbing preview without waiting for full generation

Protocol:
    → Client sends JSON: {"text": "...", "voice": "profile_id", ...}
    ← Server sends binary audio chunks (PCM16 @ 24kHz mono) as generated
    ← Server sends JSON: {"type": "done", "duration_s": 4.2, "gen_time_s": 1.1}
    ← Server sends JSON: {"type": "error", "detail": "..."}

The chunked delivery targets <100ms time-to-first-audio (TTFA) on warm models.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger("omnivoice.tts_stream")

# Chunk size for streaming PCM audio (in samples). At 24kHz, 4800 samples = 200ms.
# Smaller chunks = lower latency but more WebSocket overhead.
CHUNK_SAMPLES = int(os.environ.get("OMNIVOICE_STREAM_CHUNK", "4800"))


class StreamTTSRequest(BaseModel):
    """Client request for streaming TTS."""
    text: str
    voice: Optional[str] = None       # profile_id or preset name
    language: Optional[str] = None
    speed: float = 1.0
    instruct: Optional[str] = None
    description: Optional[str] = None
    # Emotion control (IndexTTS2)
    emo_vector: Optional[list[float]] = None
    emo_text: Optional[str] = None
    emo_audio: Optional[str] = None
    emo_alpha: float = 1.0
    # Engine override
    engine: Optional[str] = None


@router.websocket("/ws/tts")
async def ws_tts(websocket: WebSocket):
    """Stream TTS audio chunks over WebSocket.

    The client sends a single JSON request, then receives binary PCM16 chunks
    followed by a JSON completion message. The connection stays open for
    subsequent requests (conversational mode).
    """
    await websocket.accept()
    logger.info("TTS streaming WebSocket connected")

    try:
        while True:
            # Wait for a text request from the client
            try:
                data = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.debug("WS receive ended: %s", e)
                break

            if not data or not data.get("text"):
                await websocket.send_json({
                    "type": "error",
                    "detail": "Missing 'text' field in request",
                })
                continue

            t0 = time.perf_counter()
            text = data["text"]

            try:
                # Resolve engine
                from services.tts_backend import (
                    get_active_tts_backend,
                    get_backend_class,
                )
                engine_id = data.get("engine")
                if engine_id:
                    cls = get_backend_class(engine_id)
                    backend = cls()
                else:
                    from services.model_manager import get_model
                    model = await get_model()
                    backend = get_active_tts_backend(model=model)

                # Build generation kwargs
                kw: dict = {"speed": data.get("speed", 1.0)}
                if data.get("language"):
                    kw["language"] = data["language"]
                if data.get("instruct"):
                    kw["instruct"] = data["instruct"]
                if data.get("description"):
                    kw["description"] = data["description"]
                if data.get("emo_vector"):
                    kw["emo_vector"] = data["emo_vector"]
                if data.get("emo_text"):
                    kw["emo_text"] = data["emo_text"]
                if data.get("emo_audio"):
                    kw["emo_audio"] = data["emo_audio"]
                if data.get("emo_alpha") != 1.0:
                    kw["emo_alpha"] = data["emo_alpha"]

                # Resolve voice profile
                voice = data.get("voice")
                if voice:
                    try:
                        from core.db import get_db
                        from core.config import VOICES_DIR
                        conn = get_db()
                        try:
                            row = conn.execute(
                                "SELECT * FROM voice_profiles WHERE id=?",
                                (voice,),
                            ).fetchone()
                        finally:
                            conn.close()
                        if row:
                            if row["is_locked"] and row["locked_audio_path"]:
                                kw["ref_audio"] = os.path.join(
                                    VOICES_DIR, row["locked_audio_path"]
                                )
                            elif row["ref_audio_path"]:
                                kw["ref_audio"] = os.path.join(
                                    VOICES_DIR, row["ref_audio_path"]
                                )
                            if row["ref_text"]:
                                kw["ref_text"] = row["ref_text"]
                            if row["instruct"] and not data.get("instruct"):
                                kw["instruct"] = row["instruct"]
                        else:
                            kw["voice"] = voice
                    except Exception:
                        kw["voice"] = voice

                # Run generation in the GPU pool
                from services.model_manager import _gpu_pool
                loop = asyncio.get_event_loop()

                def _generate():
                    import torch
                    from services.audio_dsp import apply_mastering, normalize_audio
                    wav = backend.generate(text, **kw)
                    sr_actual = backend.sample_rate
                    wav = apply_mastering(wav, sample_rate=sr_actual)
                    wav = normalize_audio(wav, target_dBFS=-2.0)
                    return wav, sr_actual

                wav_tensor, sr = await loop.run_in_executor(_gpu_pool, _generate)

                # Send metadata after generation so sample_rate is real
                await websocket.send_json({
                    "type": "start",
                    "sample_rate": sr,
                    "channels": 1,
                    "format": "pcm16",
                    "engine": backend.id,
                })

                # Stream PCM16 chunks over the WebSocket
                import torch
                # Convert to 16-bit PCM
                pcm = (wav_tensor * 32767).clamp(-32768, 32767).to(torch.int16)
                if pcm.ndim == 2:
                    pcm = pcm[0]  # mono
                pcm_bytes = pcm.numpy().tobytes()

                total_samples = len(pcm)
                sent_samples = 0
                chunk_bytes = CHUNK_SAMPLES * 2  # 2 bytes per int16 sample

                while sent_samples < total_samples:
                    end = min(sent_samples + CHUNK_SAMPLES, total_samples)
                    start_byte = sent_samples * 2
                    end_byte = end * 2
                    chunk = pcm_bytes[start_byte:end_byte]
                    await websocket.send_bytes(chunk)
                    sent_samples = end
                    # Yield to event loop between chunks for responsiveness
                    await asyncio.sleep(0)

                gen_time = round(time.perf_counter() - t0, 3)
                duration = round(total_samples / sr, 3)

                await websocket.send_json({
                    "type": "done",
                    "duration_s": duration,
                    "gen_time_s": gen_time,
                    "samples": total_samples,
                    "sample_rate": sr,
                    "engine": backend.id,
                })
                logger.info(
                    "TTS stream: %.1fs audio in %.1fs (TTFA=%.0fms)",
                    duration, gen_time, gen_time * 1000,
                )

            except Exception as e:
                logger.exception("TTS streaming failed: %s", e)
                try:
                    await websocket.send_json({
                        "type": "error",
                        "detail": str(e),
                    })
                except Exception:
                    break

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug("TTS WebSocket ended: %s", e)
    finally:
        logger.info("TTS streaming WebSocket disconnected")
