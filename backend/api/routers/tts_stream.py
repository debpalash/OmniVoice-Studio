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
    ← Server sends JSON: {"type": "done", "duration_s": 4.2,
      "gen_time_s": 1.1, "ttfa_ms": 180.0, "rtf": 0.262}
    ← Server sends JSON: {"type": "error", "detail": "..."}

The chunked delivery targets <100ms time-to-first-audio (TTFA) on warm models.
"""
from __future__ import annotations

import asyncio
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

# Module seam for deterministic latency-contract tests.  Keep every timing
# sample on the same monotonic clock.
_perf_counter = time.perf_counter


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

    # Said once per socket, not once per utterance: a conversational client
    # sends many requests down one connection and a repeated notice would be
    # noise. See `_announce_local_only`.
    announced_local_only = False

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

            t0 = _perf_counter()
            text = data["text"]

            # Remote GPU: this socket stays on this machine, and says so.
            #
            # /generate's port trades progressive playback for the remote
            # render — the classic path was always a single wait, so spending
            # it on a faster GPU is a straight win. This route is the opposite
            # shape: it exists to put audio in the user's ear before the
            # sentence has finished synthesizing, and sending each utterance to
            # a worker would pay queue admission, a round trip and cold-load
            # risk per utterance, for the one surface where latency IS the
            # feature.
            #
            # Silence would be worse than the limitation: the header badge
            # would read "gpu2" while this machine does 100% of the work, the
            # same class of lie the op-aware picker exists to stop. Said once
            # per socket — a conversational client sends many requests down one
            # connection — and BEFORE engine resolution, so an engine that
            # cannot load still tells the user where it would have run.
            if not announced_local_only:
                announced_local_only = True
                try:
                    from worker import routing as worker_routing

                    target = worker_routing.decide(op="tts")
                except Exception:  # noqa: BLE001 — advisory; never break audio
                    target = None
                if target is not None and target.remote:
                    from core.scrub import scrub_text as _scrub

                    await websocket.send_json({
                        "type": "routing",
                        "status": "local_stream",
                        "reason": _scrub(
                            f"{target.label} is your GPU target, but live "
                            f"streaming runs on this machine"
                        ),
                    })

            try:
                # Resolve engine
                from services.tts_backend import (
                    get_active_tts_backend,
                    get_backend_class,
                )
                engine_id = data.get("engine")
                # #1224: leave a breadcrumb when memory is already tight before
                # a heavy load. /generate has done this since the 16 GB-Mac
                # reports, but the streaming path — which the desktop UI tries
                # FIRST — never did, so the load most likely to tip the machine
                # into an OS OOM kill was the one load with no trail. The
                # captured stderr tail is what a SIGKILL report has to go on.
                # Advisory only: the OS can reclaim cache, and refusing here
                # would brick loads that would actually have coped.
                try:
                    from services.memory_budget import log_if_low

                    log_if_low(f"TTS stream load ({engine_id or 'active engine'})")
                except Exception:
                    pass
                if engine_id:
                    cls = get_backend_class(engine_id)
                    backend = cls()
                else:
                    from services.model_manager import get_model
                    model = await get_model()
                    backend = get_active_tts_backend(model=model)

                # ── Routing gate (#21 — no silent CPU fallback). WebSockets have
                # no response headers, so this uses frames: an error frame +
                # close on `unavailable`, a one-time `routing` frame on
                # cpu_fallback / accelerated-with-caveat (before any audio).
                from core.device_caps import detect_host_caps
                from services.engine_routing import resolve_routing, routing_notice
                from core.scrub import scrub_text
                _routing = resolve_routing(
                    getattr(backend, "gpu_compat", ("cpu",)), detect_host_caps(),
                    getattr(backend, "min_vram_gb", 0.0))
                if _routing["routing_status"] == "unavailable":
                    await websocket.send_json({
                        "type": "error",
                        "detail": scrub_text(_routing["routing_reason"])
                        or "engine cannot run on this host",
                    })
                    continue  # don't stream; wait for the next request
                _notice = routing_notice(_routing)
                if _notice:
                    await websocket.send_json({
                        "type": "routing",
                        "status": _notice[0],
                        "reason": scrub_text(_notice[1]) if _notice[1] else None,
                    })

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
                # Default 1.0 when absent: a missing key must not trip the
                # `!= 1.0` branch into a KeyError (any minimal request that
                # omitted emo_alpha got an error frame instead of audio).
                if data.get("emo_alpha", 1.0) != 1.0:
                    kw["emo_alpha"] = data["emo_alpha"]

                # Resolve voice profile
                voice = data.get("voice")
                if voice:
                    try:
                        from core.db import db_conn
                        from core.config import VOICES_DIR
                        with db_conn() as conn:
                            row = conn.execute(
                                "SELECT * FROM voice_profiles WHERE id=?",
                                (voice,),
                            ).fetchone()
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

                # Engine-agnostic text normalization (junk strip,
                # numbers→words, abbreviations) — the same pre-pass as
                # /generate, applied exactly ONCE per request, on the whole
                # text BEFORE the sentence chunker fans it out (so per-sentence
                # generates never re-normalize, and expanded abbreviations
                # can't confuse the sentence splitter). The request's
                # `language` is all this route knows (None → universal safety
                # filters only). Pref-gated (default ON), idempotent, never
                # raises.
                from services.text_normalization import normalize_for_tts
                text = normalize_for_tts(text, data.get("language"))

                # Wave 1.4: split the request into sentences so the first
                # sentence's audio streams while later sentences are still
                # synthesizing — this is the time-to-first-audio win. The
                # chunker handles abbreviations/acronyms/decimals and CJK /
                # non-Latin terminators; single-sentence requests behave
                # exactly like the old single-shot path.
                from services.sentence_chunker import SentenceChunker
                _chunker = SentenceChunker(language=(data.get("language") or "en"))
                sentences = _chunker.push(text)
                sentences.extend(_chunker.flush())
                if not sentences:
                    sentences = [text]

                # Run generation in the GPU pool
                import functools
                from services.model_manager import run_on_gpu_pool_guarded

                def _generate(sentence_text):
                    from services.audio_dsp import apply_mastering, normalize_audio
                    from services.watermark import mark_synthetic
                    wav = backend.generate(sentence_text, **kw)
                    sr_actual = backend.sample_rate
                    # Like _run_tts in openai_compat: studio engines (VoxCPM2)
                    # opt out of the broadcast mastering chain. This is the
                    # other route that runs the active backend, so it needs the
                    # same guard. Loudness normalisation still runs.
                    if not getattr(backend, "applies_own_mastering", False):
                        wav = apply_mastering(wav, sample_rate=sr_actual)
                    wav = normalize_audio(wav, target_dBFS=-2.0)
                    # Invisible provenance mark per sentence, at the tensor
                    # stage before PCM16 conversion (#1169) — streaming is a
                    # delivery channel, not a watermark exemption. AudioSeal's
                    # 16-bit message repeats through the audio, so per-sentence
                    # embedding keeps whole-stream detection working; embedding
                    # strength does degrade on sub-second sentences (AudioSeal
                    # embeds poorly on very short segments — see
                    # watermark._iter_chunks), which is inherent to marking
                    # ultra-short clips, not a coverage gap.
                    wav = mark_synthetic(wav, sr_actual, context="tts_stream.sentence")
                    return wav, sr_actual

                import torch
                total_samples = 0
                sr = backend.sample_rate
                started = False
                first_audio_at: float | None = None
                # Synthesis time only. The wall clock below also carries socket
                # delivery and the per-chunk event-loop yields, so deriving RTF
                # from it reports "how slow was the client" as if it were engine
                # throughput — on a slow consumer that inflates RTF without the
                # engine having changed at all.
                synth_time = 0.0

                for sentence in sentences:
                    # Bounded + pool-reset on hang so a wedged generate can't
                    # starve the GPU pool and brick the backend (#730 class). On
                    # timeout GpuJobTimeoutError propagates to the handler below,
                    # which sends an actionable error frame.
                    # Length-scaled budget per sentence (#1190) — the flat 300s
                    # default is gone from every dispatch.
                    from services.model_manager import generate_timeout_s
                    synth_started_at = _perf_counter()
                    wav_tensor, sr = await run_on_gpu_pool_guarded(
                        functools.partial(_generate, sentence),
                        what="TTS generate",
                        timeout=generate_timeout_s(sentence, engine=backend),
                    )
                    synth_time += _perf_counter() - synth_started_at

                    if not started:
                        # Send metadata after the first generation so
                        # sample_rate is real (lazy-loading engines report
                        # their true rate only once weights are up).
                        await websocket.send_json({
                            "type": "start",
                            "sample_rate": sr,
                            "channels": 1,
                            "format": "pcm16",
                            "engine": backend.id,
                        })
                        started = True

                    # Convert to 16-bit PCM and stream
                    pcm = (wav_tensor * 32767).clamp(-32768, 32767).to(torch.int16)
                    if pcm.ndim == 2:
                        pcm = pcm[0]  # mono
                    pcm_bytes = pcm.numpy().tobytes()

                    n_samples = len(pcm)
                    sent_samples = 0
                    while sent_samples < n_samples:
                        end = min(sent_samples + CHUNK_SAMPLES, n_samples)
                        chunk = pcm_bytes[sent_samples * 2: end * 2]
                        await websocket.send_bytes(chunk)
                        if first_audio_at is None:
                            # TTFA ends when the first audio bytes have been
                            # handed to the socket.  The previous log used the
                            # whole-render duration and called it TTFA.
                            first_audio_at = _perf_counter()
                        sent_samples = end
                        # Yield to event loop between chunks for responsiveness
                        await asyncio.sleep(0)
                    total_samples += n_samples

                finished_at = _perf_counter()
                wall_time_raw = max(0.0, finished_at - t0)
                synth_time_raw = max(0.0, synth_time)
                gen_time = round(wall_time_raw, 3)
                duration = round(total_samples / sr, 3)
                ttfa_ms = (
                    round(max(0.0, first_audio_at - t0) * 1000.0, 1)
                    if first_audio_at is not None
                    else None
                )
                # RTF is a render metric: synthesis seconds per audio second.
                rtf = (
                    round(synth_time_raw / (total_samples / sr), 3)
                    if total_samples > 0
                    else None
                )

                await websocket.send_json({
                    "type": "done",
                    "duration_s": duration,
                    "gen_time_s": gen_time,
                    "ttfa_ms": ttfa_ms,
                    "rtf": rtf,
                    "samples": total_samples,
                    "sample_rate": sr,
                    "engine": backend.id,
                })
                logger.info(
                    "TTS stream: %.1fs audio in %.1fs (TTFA=%s, RTF=%s)",
                    duration,
                    gen_time,
                    f"{ttfa_ms:.0f}ms" if ttfa_ms is not None else "n/a",
                    f"{rtf:.3f}" if rtf is not None else "n/a",
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
