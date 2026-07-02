"""
Streaming ASR via WebSocket — live partial transcription results.

Client streams audio chunks (PCM/WebM) and receives partial + final
transcription JSON messages in real-time. Used by CaptureButton for
live dictation feedback.

Protocol:
    → Client sends binary audio frames (16-bit PCM or WebM/Opus blobs)
    ← Server sends JSON messages:

    Opt-in AEC mode (``?aec=1[&sr=16000]``, parity Action 8b): for dictating
    while the app plays audio. Frames must be raw int16 mono PCM, each tagged
    with a 1-byte prefix — 0x00 = microphone, 0x01 = playback reference. The
    server runs an NLMS echo canceller, cleaning the mic against the reference
    before transcription. Without the param the protocol is unchanged.
        {"type": "partial", "text": "Hello wor..."}      — interim result
        {"type": "final",   "text": "Hello world.",       — committed result
         "segments": [...], "language": "en",
         "duration_s": 4.2, "transcription_time_s": 0.8,
         "engine": "mlx-whisper"}
        {"type": "status",  "stage": "downloading"|"loading"|"ready"}
                                                          — model cold-start
        {"type": "error",   "message": "...", "kind": "...",
         "detail": "..."}                                  — error ("detail"
                                                          kept for legacy)

    Every ``final`` text is normalised by services.text_polish (leading
    capital for Latin scripts, terminal punctuation, single-spaced) so the
    pasted result reads like typed text. Partials are raw.
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.dependencies import _LOOPBACK_HOSTS, ws_remote_authorized
from services.text_polish import polish_text

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

# ── Dictate-over-playback AEC (parity Action 8b, opt-in) ──────────────────
# Activated by the ``?aec=1`` query param. When OFF (the default), the
# protocol and behaviour are byte-for-byte unchanged. When ON, the client
# streams raw int16 mono PCM frames tagged with a 1-byte type prefix so the
# server can tell mic audio from the playback reference it must cancel:
_AEC_NEAR = 0x00  # microphone frame (clean it, then buffer for ASR)
_AEC_FAR = 0x01   # playback reference frame (feed the echo model only)


def _demux_aec_frame(data: bytes) -> tuple[str, bytes]:
    """Split a prefixed AEC binary frame into ``(kind, pcm)``.

    ``kind`` is ``"near"`` (mic) or ``"far"`` (playback reference). An empty
    or prefix-only frame yields an empty payload. Unknown prefixes are treated
    as ``"near"`` so a malformed tag degrades to plain dictation rather than
    dropping audio.
    """
    if not data:
        return "near", b""
    kind = "far" if data[0] == _AEC_FAR else "near"
    return kind, data[1:]


def _pcm16_to_wav(pcm: bytes, sample_rate: int) -> str | None:
    """Write raw int16 mono PCM to a temp WAV via stdlib ``wave`` (no ffmpeg).

    Used on the AEC path, where frames are already decoded PCM — the cleaned
    samples have no container, so the ffmpeg-sniffing ``_chunks_to_wav`` would
    misdetect them. Returns the temp path, or ``None`` for a too-short buffer.
    """
    if not pcm or len(pcm) < 100:
        return None
    import wave
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    tmp.close()
    try:
        with wave.open(tmp.name, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # int16
            wf.setframerate(sample_rate)
            wf.writeframes(pcm)
        return tmp.name
    except Exception as e:
        logger.debug("PCM->WAV failed: %s", e)
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        return None


def _select_sherpa_spec(websocket: WebSocket):
    """Resolve the sherpa dictation model for this WS session, or None.

    A ``?model=<id>`` query param wins (the frontend can pin a model per
    session); otherwise the persisted ``dictation.model_id`` pref is used (only
    when dictation is enabled). Returns the :class:`SherpaModelSpec` or None
    (None → the legacy Whisper/WebM path runs unchanged).
    """
    try:
        from services import sherpa_dictation as sd
    except Exception:
        return None
    requested = websocket.query_params.get("model")
    if requested:
        return sd.get_spec(requested)  # explicit selection (may be None if bad)
    # Fall back to the persisted dictation pref.
    try:
        from services.asr_backend import dictation_model_id
        mid = dictation_model_id()
    except Exception:
        mid = None
    return sd.get_spec(mid) if mid else None


@router.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket):
    """Stream audio in, get partial + final transcription out."""
    # Loopback origin guard — refuse anything not from 127.0.0.1, ::1, or
    # localhost. HTTP routers use Depends(require_loopback) at router level;
    # WebSocket dependency injection differs across FastAPI versions, so we
    # inline the check before accept(). Without it, any local process could
    # stream the user's microphone over this endpoint.
    # Wave 2.3 (remote backend): a non-loopback client that presents the
    # OMNIVOICE_API_KEY bearer is the thin-client dictation case — the mic
    # lives on the user's machine, the GPU here — and is allowed through.
    host = websocket.client.host if websocket.client else None
    if host not in _LOOPBACK_HOSTS and not ws_remote_authorized(websocket):
        await websocket.close(code=1008, reason="loopback origin required")
        return

    await websocket.accept()

    # Live-dictation engine selection. When a sherpa-onnx model is selected
    # (via ?model= or the dictation.model_id pref) AND sherpa is installed,
    # run the dedicated low-latency handler. Otherwise fall through to the
    # legacy Whisper/WebM path, byte-for-byte unchanged.
    spec = _select_sherpa_spec(websocket)
    if spec is not None:
        from services.asr_backend import SherpaDictationBackend
        ok, _reason = SherpaDictationBackend.is_available()
        if ok:
            if spec.streaming:
                await _run_sherpa_streaming(websocket, spec)
            else:
                await _run_sherpa_offline(websocket, spec)
            return
        # sherpa not installed → fall through to the legacy path so the user
        # still gets dictation (just not live partials).
        logger.info("sherpa dictation selected but unavailable — legacy path")

    # Opt-in dictate-over-playback AEC (parity Action 8b). Default OFF →
    # identical legacy behaviour. When on, frames are 1-byte-tagged raw PCM
    # and the cleaned mic stream is muxed via stdlib wave (not ffmpeg).
    aec = None
    pcm_sr: int | None = None
    if websocket.query_params.get("aec") in ("1", "true", "on"):
        try:
            pcm_sr = int(websocket.query_params.get("sr", "16000"))
            from services.aec import NlmsEchoCanceller
            aec = NlmsEchoCanceller(sample_rate=pcm_sr)
            logger.info("AEC enabled for dictation session (sr=%d)", pcm_sr)
        except Exception as e:
            # Bad sr or import failure → fall back to plain dictation.
            logger.warning("AEC requested but disabled: %s", e)
            aec = None
            pcm_sr = None

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
                    if aec is not None:
                        # Tagged PCM: route the playback reference into the echo
                        # model and clean the mic before it reaches the buffer.
                        kind, payload = _demux_aec_frame(data)
                        if kind == "far":
                            aec.push_far_end(payload)
                            continue
                        if not payload:
                            continue
                        data = aec.process_near_end(payload)
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
                text = await _transcribe_buffer(audio_chunks[:], pcm_sr=pcm_sr)
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
            result = await _transcribe_buffer_full(audio_chunks, pcm_sr=pcm_sr)
            # Dictation v2: deterministic polish so the pasted final reads
            # like typed text (leading capital, terminal punctuation).
            result["text"] = polish_text(result.get("text", ""))
            # Wave 2.1: optional local-LLM refinement of the final text.
            # HARD-BOUNDED (maybe_refine_async, ~4s OMNIVOICE_REFINE_TIMEOUT_S):
            # a slow/dead LLM can never delay this `final` beyond the budget —
            # it falls back to the unrefined (but polished) text. Best-effort:
            # never let refinement turn a good final into an error. The raw
            # text always ships too — clients paste refined_text ?? text.
            if result.get("text"):
                try:
                    from services.refinement import maybe_refine_async
                    refined = await maybe_refine_async(result["text"])
                    if refined and refined != result["text"]:
                        result["refined_text"] = refined
                except Exception as e:  # noqa: BLE001
                    logger.debug("Dictation refinement skipped: %s", e)
            if not await _safe_send({"type": "final", **result}):
                logger.debug("Skipped final send — client already disconnected")
        except Exception as e:
            logger.error("Final transcription failed: %s", e)
            await _safe_send({"type": "error", "message": str(e),
                              "kind": "transcribe", "detail": str(e)})
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


# ── sherpa-onnx live dictation handlers ─────────────────────────────────────
#
# Both handlers read raw int16 mono PCM frames (reusing the AEC framing: an
# opt-in 1-byte type prefix when ?aec=1, else bare PCM) at ?sr= (default 16000).
# This is the low-latency transport — no WebM/ffmpeg in the hot path.

# How often the offline-kind handler re-decodes the live window for a partial
# (streaming-kind decodes every frame, no cadence needed).
SHERPA_OFFLINE_PARTIAL_S = float(os.environ.get("OMNIVOICE_SHERPA_OFFLINE_PARTIAL", "0.8"))

# Utterance gate for the offline-kind handler: once the trailing this-many
# seconds of the live buffer fall below the RMS floor, the utterance is
# COMMITTED — decoded, flushed as a `final`, and dropped from the buffer. Each
# decode is thereby bounded by one utterance instead of the whole session
# (the old full-buffer re-decode was O(n²)), and a sentence commits ~0.6s
# after the user stops speaking instead of only at EOF.
SHERPA_OFFLINE_SILENCE_S = float(os.environ.get("OMNIVOICE_SHERPA_OFFLINE_SILENCE", "0.6"))
SHERPA_OFFLINE_RMS_FLOOR = float(os.environ.get("OMNIVOICE_SHERPA_OFFLINE_RMS", "0.01"))


def _pcm16_to_f32(pcm: bytes):
    """int16 little-endian mono PCM bytes → float32 numpy in [-1, 1]."""
    import numpy as np
    if not pcm:
        return np.zeros(0, dtype=np.float32)
    # Guard against an odd trailing byte from a split frame.
    if len(pcm) % 2:
        pcm = pcm[:-1]
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


async def _sherpa_session(websocket: WebSocket):
    """Shared WS receive setup for the sherpa handlers.

    Returns ``(get_frame, state)`` where ``get_frame`` is an async callable
    that yields the next near-end (mic) PCM bytes, ``b""`` for a keepalive/ref
    frame, or ``None`` on EOF/disconnect. ``state`` carries sample rate, AEC,
    and the disconnect flag for the caller's finaliser.
    """
    pcm_sr = 16000
    try:
        pcm_sr = int(websocket.query_params.get("sr", "16000"))
    except (TypeError, ValueError):
        pcm_sr = 16000
    aec = None
    if websocket.query_params.get("aec") in ("1", "true", "on"):
        try:
            from services.aec import NlmsEchoCanceller
            aec = NlmsEchoCanceller(sample_rate=pcm_sr)
        except Exception as e:
            logger.warning("AEC requested but disabled (sherpa): %s", e)
            aec = None
    return pcm_sr, aec


async def _recv_pcm_frame(websocket: WebSocket, aec):
    """Receive one frame; return (kind, pcm_bytes).

    kind ∈ {"near","eof","skip"}. Demuxes AEC-tagged frames when ``aec`` is on
    and feeds the playback reference into the canceller. A text "EOF" or an
    empty/closed socket yields kind "eof".
    """
    msg = await websocket.receive()
    mtype = msg.get("type")
    if mtype == "websocket.disconnect":
        return "eof", b""
    if mtype != "websocket.receive":
        return "skip", b""
    data = msg.get("bytes")
    if data is not None:
        if len(data) == 0:
            return "eof", b""
        if aec is not None:
            kind, payload = _demux_aec_frame(data)
            if kind == "far":
                aec.push_far_end(payload)
                return "skip", b""
            if not payload:
                return "skip", b""
            return "near", aec.process_near_end(payload)
        return "near", data
    if msg.get("text") == "EOF":
        return "eof", b""
    return "skip", b""


async def _sherpa_load_with_status(websocket: WebSocket, backend, spec) -> bool:
    """Build the recognizer off the event loop, narrating cold-start progress.

    Sends ``{"type":"status","stage":"downloading"|"loading"}`` before the
    load ("downloading" when the pinned assets aren't in the HF cache yet;
    stage-only — HF's per-file progress isn't worth a callback plumb-through)
    and ``{"type":"status","stage":"ready"}`` after, so the widget can show
    *why* the first dictation takes a moment. Returns False when the load
    failed (the error frame is sent and the socket closed here).
    """
    try:
        from services import sherpa_dictation as _sd
        stage = "loading" if _sd.is_installed(spec) else "downloading"
    except Exception:
        stage = "loading"
    try:
        await websocket.send_json({"type": "status", "stage": stage})
    except Exception:
        pass
    try:
        await asyncio.to_thread(backend.ensure_loaded)
    except Exception as e:
        logger.error("sherpa dictation load failed (%s): %s", spec.id, e)
        try:
            await websocket.send_json({"type": "error", "message": str(e),
                                       "kind": "load", "detail": str(e)})
            await websocket.close()
        except Exception:
            pass
        return False
    try:
        await websocket.send_json({"type": "status", "stage": "ready"})
    except Exception:
        pass
    return True


async def _run_sherpa_streaming(websocket: WebSocket, spec):
    """True streaming: feed the OnlineRecognizer frame-by-frame, emit `partial`
    every time the decoded text grows, and `final` on sherpa's endpoint (silence)
    detection and on EOF. <300ms perceived latency on CPU for the tiny models.
    """
    import numpy as np
    from services.asr_backend import get_sherpa_dictation_backend

    pcm_sr, aec = await _sherpa_session(websocket)
    logger.info("sherpa streaming dictation: model=%s sr=%d aec=%s",
                spec.id, pcm_sr, bool(aec))

    # Reuse the shared, per-model warm backend (#888): the recognizer is built
    # once and shared across sessions instead of rebuilt (1.3–2.5s) per connect,
    # so the first dictation is instant when the preload warmed it. Each session
    # still gets its own decode stream below.
    backend = get_sherpa_dictation_backend(spec.id)
    # Build the recognizer off the event loop if it isn't warm yet
    # (download-on-first-use + ONNX session init can take a moment); status
    # frames keep the widget honest.
    if not await _sherpa_load_with_status(websocket, backend, spec):
        return
    rec = backend._rec
    stream = rec.create_stream()

    last_partial = ""
    committed: list[str] = []     # finalized utterances this session
    client_disconnected = False

    async def _send(payload) -> bool:
        nonlocal client_disconnected
        if client_disconnected:
            return False
        try:
            await websocket.send_json(payload)
            return True
        except Exception:
            client_disconnected = True
            return False

    def _decode_after_feed(pcm: bytes):
        """Blocking: feed one PCM frame, decode, return (text, is_endpoint).
        Runs in a thread so the ONNX work never blocks the event loop."""
        samples = _pcm16_to_f32(pcm)
        if len(samples):
            stream.accept_waveform(pcm_sr, samples)
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        endpoint = rec.is_endpoint(stream)
        text = (rec.get_result(stream) or "").strip()
        return text, endpoint

    def _flush_final():
        """Blocking: pad + drain the stream for the trailing utterance."""
        tail = np.zeros(int(0.5 * pcm_sr), dtype=np.float32)
        stream.accept_waveform(pcm_sr, tail)
        stream.input_finished()
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        return (rec.get_result(stream) or "").strip()

    try:
        while True:
            kind, pcm = await _recv_pcm_frame(websocket, aec)
            if kind == "eof":
                break
            if kind == "skip":
                continue
            text, endpoint = await asyncio.to_thread(_decode_after_feed, pcm)
            if endpoint:
                # Commit this utterance (polished — it gets pasted); reset
                # for the next one.
                text = polish_text(text)
                if text:
                    committed.append(text)
                    await _send({"type": "final", "text": text,
                                 "segments": [{"start": 0.0, "end": None, "text": text}],
                                 "language": "auto", "engine": backend.id})
                rec.reset(stream)
                last_partial = ""
            elif text and text != last_partial:
                last_partial = text
                await _send({"type": "partial", "text": text})
    except WebSocketDisconnect:
        client_disconnected = True
    except Exception as e:
        logger.warning("sherpa streaming loop ended: %s", e)
        client_disconnected = True

    # Drain the trailing (un-endpointed) utterance on EOF.
    try:
        tail_text = await asyncio.to_thread(_flush_final)
    except Exception as e:
        logger.debug("sherpa streaming flush failed: %s", e)
        tail_text = ""
    tail_text = polish_text(tail_text)
    if tail_text and tail_text != (committed[-1] if committed else None):
        committed.append(tail_text)

    # Pieces are already polished; the join is too (polish is idempotent).
    full = " ".join(t for t in committed if t).strip()
    segments = [{"start": 0.0, "end": None, "text": t} for t in committed if t]
    if not client_disconnected:
        if full:
            # Hard-bounded refinement (~4s): never delays this summary `final`
            # beyond OMNIVOICE_REFINE_TIMEOUT_S even with a dead LLM endpoint.
            try:
                from services.refinement import maybe_refine_async
                refined = await maybe_refine_async(full)
            except Exception:
                refined = None
            payload = {"type": "final", "text": full, "segments": segments,
                       "language": "auto", "engine": backend.id}
            if refined and refined != full:
                payload["refined_text"] = refined
            await _send(payload)
        else:
            await _send({"type": "final", "text": "", "segments": [],
                         "language": "auto", "engine": backend.id})
        try:
            await websocket.close()
        except Exception:
            pass


async def _run_sherpa_offline(websocket: WebSocket, spec):
    """Offline-kind sherpa model with live partials, utterance-windowed.

    Raw PCM accumulates in a *live* buffer holding only the current
    (uncommitted) utterance. Every ~800ms the live window is re-decoded for a
    ``partial``; when the trailing ~0.6s of it fall below the RMS floor the
    utterance is committed — decoded once more, flushed as a ``final``, and
    its samples dropped — so per-partial cost is bounded by one utterance
    (not the whole session) and sentences commit as the user pauses instead
    of only at EOF."""
    from services.asr_backend import get_sherpa_dictation_backend

    pcm_sr, aec = await _sherpa_session(websocket)
    logger.info("sherpa offline dictation: model=%s sr=%d aec=%s",
                spec.id, pcm_sr, bool(aec))

    # Shared, per-model warm backend (#888) — built once, reused per session.
    backend = get_sherpa_dictation_backend(spec.id)
    if not await _sherpa_load_with_status(websocket, backend, spec):
        return

    buf = bytearray()             # live (uncommitted) PCM only
    committed: list[str] = []     # polished utterances already flushed
    last_partial = ""
    running = True
    client_disconnected = False
    last_audio = time.monotonic()
    # Trailing-silence gate window, in bytes of int16 mono PCM.
    sil_bytes = max(2, int(SHERPA_OFFLINE_SILENCE_S * pcm_sr) * 2)

    async def _send(payload) -> bool:
        nonlocal client_disconnected
        if client_disconnected:
            return False
        try:
            await websocket.send_json(payload)
            return True
        except Exception:
            client_disconnected = True
            return False

    def _rms(pcm: bytes) -> float:
        samples = _pcm16_to_f32(pcm)
        if not len(samples):
            return 0.0
        return float((samples * samples).mean() ** 0.5)

    def _decode_window(pcm: bytes) -> str:
        samples = _pcm16_to_f32(pcm)
        if not len(samples):
            return ""
        return backend._decode_offline(samples, pcm_sr)

    async def receive():
        nonlocal running, client_disconnected, last_audio
        try:
            while running:
                kind, pcm = await _recv_pcm_frame(websocket, aec)
                if kind == "eof":
                    running = False
                    break
                if kind == "skip":
                    continue
                buf.extend(pcm)
                last_audio = time.monotonic()
        except WebSocketDisconnect:
            client_disconnected = True
            running = False
        except Exception as e:
            logger.debug("sherpa offline receive ended: %s", e)
            running = False

    async def _commit(snapshot: bytes):
        """Finalize one utterance: decode it off-thread, flush a polished
        `final`, drop its samples from the live buffer. `receive()` may
        append while we decode — only the snapshot's prefix is dropped."""
        nonlocal last_partial
        try:
            text = await asyncio.to_thread(_decode_window, snapshot)
        except Exception as e:
            logger.debug("sherpa offline commit decode failed: %s", e)
            return
        del buf[:len(snapshot)]
        last_partial = ""
        text = polish_text(text)
        if text:
            committed.append(text)
            await _send({"type": "final", "text": text,
                         "segments": [{"start": 0.0, "end": None, "text": text}],
                         "language": "auto", "engine": backend.id})

    async def partials():
        nonlocal last_partial, running
        while running:
            await asyncio.sleep(SHERPA_OFFLINE_PARTIAL_S)
            if not running or len(buf) < 2000:
                continue
            snapshot = bytes(buf)
            if len(snapshot) > sil_bytes and \
                    _rms(snapshot[-sil_bytes:]) < SHERPA_OFFLINE_RMS_FLOOR:
                if _rms(snapshot[:-sil_bytes]) >= SHERPA_OFFLINE_RMS_FLOOR:
                    await _commit(snapshot)
                else:
                    # Pure silence — drop it (keep the gate window for
                    # continuity) so a long pause can't grow the buffer.
                    del buf[:len(snapshot) - sil_bytes]
                continue
            try:
                text = await asyncio.to_thread(_decode_window, snapshot)
            except Exception as e:
                logger.debug("sherpa offline partial failed: %s", e)
                continue
            if text and text != last_partial:
                last_partial = text
                await _send({"type": "partial", "text": text})

    recv_task = asyncio.create_task(receive())
    part_task = asyncio.create_task(partials())
    await asyncio.wait([recv_task, part_task], return_when=asyncio.FIRST_COMPLETED)
    running = False
    for t in (recv_task, part_task):
        if not t.done():
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

    # Drain the trailing (un-committed) utterance on EOF.
    try:
        tail = await asyncio.to_thread(_decode_window, bytes(buf))
    except Exception as e:
        logger.error("sherpa offline final failed: %s", e)
        tail = ""
    tail = polish_text(tail)
    if tail:
        committed.append(tail)
    # Pieces are already polished; the join is too (polish is idempotent).
    full = " ".join(committed).strip()
    segments = [{"start": 0.0, "end": None, "text": t} for t in committed]
    if not client_disconnected:
        payload = {"type": "final", "text": full, "segments": segments,
                   "language": "auto", "engine": backend.id}
        if full:
            # Hard-bounded refinement (~4s) — never delays the `final`.
            try:
                from services.refinement import maybe_refine_async
                refined = await maybe_refine_async(full)
                if refined and refined != full:
                    payload["refined_text"] = refined
            except Exception:
                pass
        await _send(payload)
        try:
            await websocket.close()
        except Exception:
            pass


async def _transcribe_buffer(chunks: list[bytes], *, pcm_sr: int | None = None) -> str:
    """Quick partial transcription of the current audio buffer."""

    tmp = _pcm16_to_wav(b"".join(chunks), pcm_sr) if pcm_sr else _chunks_to_wav(chunks)
    if tmp is None:
        return ""

    try:
        from services.model_manager import _gpu_pool
        from services.asr_backend import get_capture_asr_backend, run_transcribe_guarded

        def _run():
            backend = get_capture_asr_backend()
            result = backend.transcribe(tmp, word_timestamps=False)
            return result.get("text", "")

        # Bound dictation transcribes (#730): a wedged whisperx/CTranslate2 call
        # must not hold its GPU-pool worker forever and starve TTS / other ASR
        # into a "can't reach backend"; on timeout the pool is reset to recover.
        text = await run_transcribe_guarded(_gpu_pool, _run, what="Dictation")
        return text.strip()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


async def _transcribe_buffer_full(chunks: list[bytes], *, pcm_sr: int | None = None) -> dict:
    """Full transcription with timing info for the final result."""
    tmp = _pcm16_to_wav(b"".join(chunks), pcm_sr) if pcm_sr else _chunks_to_wav(chunks)
    if tmp is None:
        return {"text": "", "segments": [], "language": "unknown",
                "duration_s": 0, "transcription_time_s": 0, "engine": "none"}

    try:
        from services.model_manager import _gpu_pool
        from services.asr_backend import get_capture_asr_backend, run_transcribe_guarded

        def _run():
            backend = get_capture_asr_backend()
            t0 = time.perf_counter()
            result = backend.transcribe(tmp, word_timestamps=False)
            elapsed = round(time.perf_counter() - t0, 2)

            segments = result.get("segments", [])
            full_text = result.get("text", "")
            if not full_text and segments:
                full_text = " ".join(s.get("text", "") for s in segments).strip()

            # Wave 1.1: strip Whisper hallucination loops from the final
            # text (the string that gets auto-pasted). Segments keep the
            # raw recognition so their timings stay truthful.
            from services.refinement import collapse_repetitive_artifacts
            full_text = collapse_repetitive_artifacts(full_text)

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

        # Bounded + pool-resetting on timeout (#730), same rationale as the
        # partial path above.
        return await run_transcribe_guarded(_gpu_pool, _run, what="Dictation")
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

