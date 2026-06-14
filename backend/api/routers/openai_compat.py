"""
OpenAI-compatible TTS & STT API — Phase 3.2 (ROADMAP.md P0).

Drop-in replacement for OpenAI's audio endpoints so that any tool speaking the
OpenAI protocol (Claude, Cursor, LangChain, litellm, etc.) can use OmniVoice
as a local backend with zero code changes.

Endpoints
─────────
    POST /v1/audio/speech          → TTS  (text → wav/mp3/opus/flac)
    POST /v1/audio/transcriptions  → STT  (audio file → text/json)
    GET  /v1/audio/voices          → list available voices (OmniVoice extension)

The router delegates to the active TTS/ASR backends via the same adapter
protocol used by the rest of OmniVoice, so engine selection, GPU offloading,
and model loading all work identically.

Reference: https://platform.openai.com/docs/api-reference/audio
"""
from __future__ import annotations

import io
import logging
import os
import asyncio
import tempfile
from typing import Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services.model_manager import _gpu_pool

logger = logging.getLogger("omnivoice.openai_compat")

router = APIRouter(prefix="/v1/audio", tags=["OpenAI-Compatible Audio API"])


# ── Schemas ─────────────────────────────────────────────────────────────────


class SpeechRequest(BaseModel):
    """POST /v1/audio/speech — mirrors OpenAI's CreateSpeechRequest."""

    model: str = Field(
        default="omnivoice",
        description=(
            "TTS model to use. Maps to OmniVoice engine IDs: "
            "'omnivoice', 'voxcpm2', 'cosyvoice', 'mlx-audio', 'kittentts', 'moss-tts-nano'. "
            "Also accepts 'tts-1' and 'tts-1-hd' as aliases for the active engine."
        ),
    )
    input: str = Field(
        ...,
        max_length=4096,
        description="The text to synthesize. Max 4096 characters.",
    )
    voice: str = Field(
        default="default",
        description=(
            "Voice to use. For OmniVoice: pass a voice profile ID, 'default', "
            "or a KittenTTS preset name. OpenAI voice names (alloy, echo, fable, "
            "onyx, nova, shimmer) are accepted but mapped to defaults."
        ),
    )
    response_format: Literal["mp3", "opus", "aac", "flac", "wav", "pcm"] = Field(
        default="mp3",
        description="Audio output format.",
    )
    speed: float = Field(
        default=1.0,
        ge=0.25,
        le=4.0,
        description="Speed of the generated audio (0.25 to 4.0).",
    )
    # OmniVoice extensions (not part of OpenAI spec, but accepted if sent)
    language: Optional[str] = Field(default=None, description="Language code (ISO 639-1)")
    description: Optional[str] = Field(
        default=None,
        description="Voice description for voice design (VoxCPM2 only). "
        "E.g. 'young female, warm tone, slight British accent'.",
    )
    instruct: Optional[str] = Field(default=None, description="Style instruction for the TTS engine.")
    duration: Optional[float] = Field(
        default=None,
        gt=0,
        description="OmniVoice extension: target output duration in seconds.",
    )
    seed: Optional[int] = Field(
        default=None,
        description="OmniVoice extension: deterministic sampling seed.",
    )
    denoise: bool = Field(
        default=True,
        description="OmniVoice extension: prepend denoise control when supported.",
    )
    preprocess_prompt: bool = Field(
        default=True,
        description="OmniVoice extension: trim/preprocess reference prompt when supported.",
    )
    chunk_duration: Optional[float] = Field(
        default=None,
        ge=0,
        description="OmniVoice GGUF extension: long-form internal chunk duration.",
    )
    chunk_threshold: Optional[float] = Field(
        default=None,
        ge=0,
        description="OmniVoice GGUF extension: long-form internal chunk threshold.",
    )


class TranscriptionResponse(BaseModel):
    """Mirrors OpenAI's CreateTranscriptionResponse."""

    text: str


class VerboseTranscriptionResponse(BaseModel):
    """Mirrors OpenAI's verbose_json transcription response."""

    task: str = "transcribe"
    language: str = ""
    duration: float = 0.0
    text: str = ""
    segments: list[dict] = Field(default_factory=list)


# ── OpenAI voice name mapping ──────────────────────────────────────────────

# OpenAI's 6 named voices aren't real voices in OmniVoice. Map them to
# sensible defaults so callers that hardcode "alloy" don't get a 400.
_OPENAI_VOICE_ALIASES = {
    "alloy", "echo", "fable", "onyx", "nova", "shimmer",
}


# ── TTS: POST /v1/audio/speech ──────────────────────────────────────────────


def _resolve_engine(model_id: str):
    """Map an OpenAI model name to an OmniVoice backend."""
    from services.tts_backend import get_backend_class, get_active_tts_backend

    # Accept OpenAI model names as pass-through to the active engine.
    if model_id in ("tts-1", "tts-1-hd"):
        return get_active_tts_backend()

    # Direct engine ID match
    try:
        cls = get_backend_class(model_id)
        ok, msg = cls.is_available()
        if not ok:
            raise HTTPException(
                status_code=400,
                detail=f"Engine '{model_id}' is not available: {msg}",
            )
        from services.tts_backend import OmniVoiceBackend
        if cls is OmniVoiceBackend:
            return get_active_tts_backend()
        return cls()
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown model '{model_id}'. Use one of: "
                "omnivoice, voxcpm2, cosyvoice, mlx-audio, kittentts, "
                "moss-tts-nano, indextts2, gpt-sovits, sherpa-onnx, tts-1, tts-1-hd."
            ),
        )


def _encode_audio(wav_tensor, sample_rate: int, fmt: str) -> tuple[bytes, str, str]:
    """Encode a torch tensor to the requested audio format. Returns (bytes, mime_type, file_ext)."""
    from services.audio_io import _safe_torchaudio_save

    if fmt == "wav":
        buf = io.BytesIO()
        _safe_torchaudio_save(buf, wav_tensor, sample_rate, format="wav")
        return buf.getvalue(), "audio/wav", "wav"

    if fmt == "flac":
        buf = io.BytesIO()
        _safe_torchaudio_save(buf, wav_tensor, sample_rate, format="flac")
        return buf.getvalue(), "audio/flac", "flac"

    if fmt == "mp3":
        # torchaudio can write mp3 if ffmpeg backend is available.
        # Fall back to wav if it can't.
        buf = io.BytesIO()
        try:
            _safe_torchaudio_save(buf, wav_tensor, sample_rate, format="mp3")
            return buf.getvalue(), "audio/mpeg", "mp3"
        except Exception:
            # ffmpeg not available — fall back to wav. Reset the buffer
            # in case the failed mp3 attempt wrote partial bytes.
            buf.seek(0)
            buf.truncate(0)
            _safe_torchaudio_save(buf, wav_tensor, sample_rate, format="wav")
            return buf.getvalue(), "audio/wav", "wav"

    if fmt == "opus":
        buf = io.BytesIO()
        try:
            _safe_torchaudio_save(buf, wav_tensor, sample_rate, format="ogg")
            return buf.getvalue(), "audio/ogg", "opus"
        except Exception:
            buf2 = io.BytesIO()
            _safe_torchaudio_save(buf2, wav_tensor, sample_rate, format="wav")
            return buf2.getvalue(), "audio/wav", "wav"

    if fmt == "pcm":
        # Raw 16-bit little-endian PCM, no header. Still apply the same
        # clamp + dtype + contig invariants the helper enforces; we just
        # can't go through it because this branch produces raw samples,
        # not a container.
        import torch
        t = wav_tensor
        if t.device.type != "cpu":
            t = t.cpu()
        if t.dtype != torch.float32:
            t = t.to(torch.float32)
        t = t.clamp(-1.0, 1.0).contiguous()
        pcm = (t * 32767).clamp(-32768, 32767).to(torch.int16)
        return pcm.numpy().tobytes(), "audio/pcm", "pcm"

    # AAC — not widely supported by torchaudio, fall back to wav
    buf = io.BytesIO()
    _safe_torchaudio_save(buf, wav_tensor, sample_rate, format="wav")
    return buf.getvalue(), "audio/wav", "wav"


def _run_tts(backend, text: str, kw: dict):
    """Run TTS inference in the GPU thread pool."""
    from services.audio_dsp import apply_mastering, normalize_audio
    wav = backend.generate(text, **kw)
    sr = backend.sample_rate
    # Engines that already emit mastered, studio-grade audio (e.g. VoxCPM2's
    # native 48 kHz) opt out of apply_mastering via `applies_own_mastering`.
    # That chain's Compressor + 8% Reverb is tuned for OmniVoice's 24 kHz clone
    # output; applied to a studio engine it adds an audible level pump and a
    # reverb tail that degrade the very output we want clean. Loudness
    # normalisation still runs — it's a benign peak scale, not dynamics.
    if not getattr(backend, "applies_own_mastering", False):
        wav = apply_mastering(wav, sample_rate=sr)
    wav = normalize_audio(wav, target_dBFS=-2.0)
    return wav, sr


@router.post("/speech")
async def create_speech(req: SpeechRequest):
    """Generate audio from text. Compatible with OpenAI's POST /v1/audio/speech."""
    backend = _resolve_engine(req.model)

    # Routing gate (#21 — no silent CPU fallback), identical to REST /generate.
    from core.device_caps import detect_host_caps
    from services.engine_routing import resolve_routing, routing_notice
    _routing = resolve_routing(getattr(backend, "gpu_compat", ("cpu",)), detect_host_caps())
    if _routing["routing_status"] == "unavailable":
        raise HTTPException(status_code=400, detail=_routing["routing_reason"])
    _routing_notice = routing_notice(_routing)  # (status, reason) or None

    # Build kwargs for the backend's generate() method
    kw: dict = {
        "speed": req.speed,
        "denoise": req.denoise,
        "preprocess_prompt": req.preprocess_prompt,
    }
    if req.duration is not None:
        kw["duration"] = req.duration
    if req.seed is not None:
        kw["seed"] = req.seed
    if req.chunk_duration is not None:
        kw["chunk_duration"] = req.chunk_duration
    if req.chunk_threshold is not None:
        kw["chunk_threshold"] = req.chunk_threshold
    if req.language:
        kw["language"] = req.language
    if req.instruct:
        kw["instruct"] = req.instruct
    if req.description:
        kw["description"] = req.description

    # Voice handling: if it's a known OpenAI alias, use defaults.
    # If it's a UUID-like string, treat it as a profile_id and resolve ref_audio.
    voice = req.voice
    if voice not in _OPENAI_VOICE_ALIASES and voice != "default":
        # Try to resolve as a voice profile ID
        try:
            from core.db import db_conn
            from core.config import VOICES_DIR
            with db_conn() as conn:
                row = conn.execute(
                    "SELECT * FROM voice_profiles WHERE id=?", (voice,)
                ).fetchone()
            if row:
                if row["is_locked"] and row["locked_audio_path"]:
                    kw["ref_audio"] = os.path.join(VOICES_DIR, row["locked_audio_path"])
                elif row["ref_audio_path"]:
                    kw["ref_audio"] = os.path.join(VOICES_DIR, row["ref_audio_path"])
                if row["ref_text"]:
                    kw["ref_text"] = row["ref_text"]
                if row["instruct"] and not req.instruct:
                    kw["instruct"] = row["instruct"]
                if req.seed is None and row["seed"] is not None:
                    kw["seed"] = row["seed"]
            else:
                # Not a profile ID — forward as engine preset name
                kw["voice"] = voice
        except Exception:
            # Not a profile ID — might be a KittenTTS preset or similar
            kw["voice"] = voice

    try:
        loop = asyncio.get_running_loop()
        wav, sr = await loop.run_in_executor(_gpu_pool, _run_tts, backend, req.input, kw)
    except Exception as e:
        logger.exception("OpenAI TTS failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

    audio_bytes, mime_type, ext = _encode_audio(wav, sr, req.response_format)

    _headers = {
        "Content-Length": str(len(audio_bytes)),
        "Content-Disposition": f'inline; filename="speech.{ext}"',
    }
    if _routing_notice:
        from services.engine_routing import header_safe_reason
        _headers["X-OmniVoice-Routing"] = _routing_notice[0]
        _hr = header_safe_reason(_routing_notice[1])
        if _hr:
            _headers["X-OmniVoice-Routing-Reason"] = _hr
    return StreamingResponse(
        io.BytesIO(audio_bytes),
        media_type=mime_type,
        headers=_headers,
    )


# ── STT: POST /v1/audio/transcriptions ──────────────────────────────────────


@router.post("/transcriptions")
async def create_transcription(
    file: UploadFile = File(..., description="Audio file to transcribe"),
    model: str = Form(
        default="whisper-1",
        description=(
            "ASR model. Accepts 'whisper-1' (maps to active engine), or an "
            "OmniVoice engine ID: whisperx, faster-whisper, mlx-whisper, pytorch-whisper."
        ),
    ),
    language: Optional[str] = Form(
        default=None,
        description="Language of the input audio (ISO 639-1). Optional.",
    ),
    prompt: Optional[str] = Form(
        default=None,
        description="Optional text to guide the model's style or continue a previous segment.",
    ),
    response_format: str = Form(
        default="json",
        description="Output format: json, text, verbose_json, srt, vtt.",
    ),
    temperature: Optional[float] = Form(
        default=None,
        description="Sampling temperature (0–1). Not used by all backends.",
    ),
):
    """Transcribe audio to text. Compatible with OpenAI's POST /v1/audio/transcriptions."""
    from services.asr_backend import get_active_asr_backend

    # Write uploaded file to a temp location
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read audio file: {e}")

    try:
        backend = get_active_asr_backend()

        # Run transcription in the thread pool to avoid blocking the event loop
        loop = asyncio.get_running_loop()
        word_ts = response_format == "verbose_json"
        result = await loop.run_in_executor(
            _gpu_pool,
            lambda: backend.transcribe(tmp_path, word_timestamps=word_ts),
        )

        # Extract the full text from segments
        segments = result.get("segments", [])
        chunks = result.get("chunks", [])
        full_text = " ".join(
            seg.get("text", "").strip()
            for seg in (segments if segments else chunks)
        ).strip()
        detected_lang = result.get("language", language or "en")

        # Format response based on requested format
        if response_format == "text":
            from fastapi.responses import PlainTextResponse
            return PlainTextResponse(full_text)

        if response_format == "verbose_json":
            duration = result.get("duration", 0.0)
            if not duration and segments:
                last = segments[-1]
                duration = last.get("end", 0.0)
            return VerboseTranscriptionResponse(
                task="transcribe",
                language=detected_lang,
                duration=duration,
                text=full_text,
                segments=[
                    {
                        "id": i,
                        "text": seg.get("text", ""),
                        "start": seg.get("start", 0.0),
                        "end": seg.get("end", 0.0),
                    }
                    for i, seg in enumerate(segments)
                ],
            )

        if response_format == "srt":
            from fastapi.responses import PlainTextResponse
            srt_lines = []
            for i, seg in enumerate(segments, 1):
                start = seg.get("start", 0.0)
                end = seg.get("end", 0.0)
                text = seg.get("text", "").strip()
                srt_lines.append(
                    f"{i}\n"
                    f"{_format_ts_srt(start)} --> {_format_ts_srt(end)}\n"
                    f"{text}\n"
                )
            return PlainTextResponse("\n".join(srt_lines), media_type="text/plain")

        if response_format == "vtt":
            from fastapi.responses import PlainTextResponse
            vtt_lines = ["WEBVTT\n"]
            for seg in segments:
                start = seg.get("start", 0.0)
                end = seg.get("end", 0.0)
                text = seg.get("text", "").strip()
                vtt_lines.append(
                    f"{_format_ts_vtt(start)} --> {_format_ts_vtt(end)}\n{text}\n"
                )
            return PlainTextResponse("\n".join(vtt_lines), media_type="text/vtt")

        # Default: json
        return TranscriptionResponse(text=full_text)

    except Exception as e:
        logger.exception("OpenAI transcription failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Voices: GET /v1/audio/voices (OmniVoice extension) ─────────────────────


@router.get("/voices")
def list_voices():
    """List available voices. OmniVoice extension to the OpenAI API."""
    from services.tts_backend import list_backends

    backends = list_backends()
    voices = []

    # Always include the OpenAI standard voice names as aliases
    for name in sorted(_OPENAI_VOICE_ALIASES):
        voices.append({
            "voice_id": name,
            "name": name.capitalize(),
            "type": "openai_alias",
            "description": f"OpenAI '{name}' voice — maps to the active OmniVoice engine's default voice.",
        })

    # Include voice profiles from the database
    try:
        from core.db import db_conn
        with db_conn() as conn:
            rows = conn.execute(
                "SELECT id, name, language FROM voice_profiles ORDER BY name"
            ).fetchall()
        for row in rows:
            voices.append({
                "voice_id": row["id"],
                "name": row["name"],
                "type": "profile",
                "language": row["language"],
            })
    except Exception:
        pass

    return {"voices": voices, "engines": backends}


# ── Helpers ─────────────────────────────────────────────────────────────────


def _format_ts_srt(seconds: float) -> str:
    """Format seconds as SRT timestamp: HH:MM:SS,mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _format_ts_vtt(seconds: float) -> str:
    """Format seconds as VTT timestamp: HH:MM:SS.mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"
