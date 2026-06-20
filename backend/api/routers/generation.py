import os
import io
import uuid
import time
import random
import asyncio
import tempfile
import contextlib
import logging
import traceback
from typing import Optional
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import StreamingResponse

from core.db import db_conn
from core.config import OUTPUTS_DIR, VOICES_DIR
from services.model_manager import get_model, _gpu_pool
from services.audio_io import _safe_torchaudio_save
from core import event_bus

router = APIRouter()
logger = logging.getLogger("omnivoice.generate")


def _render_with_pauses(gen_span, segments, sample_rate):
    """Synthesize ``[(text, pause_ms), ...]`` spans and stitch silence between
    them (issue #276).

    ``gen_span(text) -> torch.Tensor`` synthesizes one text span (raw model
    output). A silence buffer of ``pause_ms`` is inserted after a span when
    requested, matching the audio tensor's channel dims / dtype / device.
    Returns the concatenated waveform. Kept model-free (``gen_span`` is injected)
    so the stitching is unit-testable without loading the TTS model.
    """
    import torch

    items = []  # ('a', tensor) for audio, ('s', n_samples) for silence
    for span_text, pause_ms in segments:
        if span_text and span_text.strip():
            items.append(("a", gen_span(span_text)))
        if pause_ms > 0:
            n = int(round(sample_rate * pause_ms / 1000.0))
            if n > 0:
                items.append(("s", n))

    ref = next((t for kind, t in items if kind == "a"), None)
    if ref is None:
        # No speakable text (e.g. the input was only pause markers) — emit the
        # requested silence so the caller still gets a valid clip.
        total = sum(n for kind, n in items if kind == "s") or 1
        return torch.zeros(total, dtype=torch.float32)

    parts = []
    for kind, val in items:
        if kind == "a":
            parts.append(val)
        else:
            shape = list(ref.shape)
            shape[-1] = val
            parts.append(torch.zeros(*shape, dtype=ref.dtype, device=ref.device))
    return torch.cat(parts, dim=-1)


def _apply_effect_chain(audio_out, sample_rate, effect_preset, *, skip_mastering=False):
    """Shared post-DSP for /generate: preset validation → mastering →
    effect chain → loudness normalization.

    ``skip_mastering`` honors a backend's ``applies_own_mastering`` flag
    (issue #312): studio engines (e.g. VoxCPM2's native 48 kHz output)
    opt out of the broadcast Compressor + Reverb chain that's tuned for
    OmniVoice's 24 kHz clone output. Loudness normalization still runs —
    it's a benign peak scale. Mirrors ``_run_tts`` in openai_compat.py.
    """
    from services.audio_dsp import (
        EFFECT_PRESETS, apply_mastering, normalize_audio,
        apply_effects_chain, get_effect_chain,
    )

    preset = effect_preset or "broadcast"
    if preset not in EFFECT_PRESETS:
        raise ValueError(
            f"Unknown effect preset: {preset!r}. "
            f"Valid: {list(EFFECT_PRESETS.keys())}"
        )

    if preset == "raw":
        # Raw: skip all DSP — return raw model output
        return audio_out

    if not skip_mastering:
        audio_out = apply_mastering(audio_out, sample_rate=sample_rate)
    chain = get_effect_chain(preset)
    if chain:
        audio_out = apply_effects_chain(
            audio_out, sample_rate=sample_rate, chain=chain,
        )
    return normalize_audio(audio_out, target_dBFS=-2.0)


def _oom_friendly_reraise(e):
    """Best-effort cache flush + the user-facing OOM hint shared by both
    inference paths."""
    import gc
    import torch
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    elif torch.cuda.is_available():
        torch.cuda.empty_cache()
    # #278: don't mislabel a torch.compile/Triton/Inductor crash as an
    # out-of-memory condition. (model_manager's generate wrapper already
    # retries these eagerly; this only triggers if that retry also died.)
    from services.model_manager import _is_compile_runtime_failure
    if _is_compile_runtime_failure(e):
        raise RuntimeError(
            f"TTS engine hit a torch.compile/Triton error (not out of memory). "
            f"Disable torch.compile in Settings → Performance, use the Flush "
            f"button to reload the model, then regenerate. Underlying error: {e}"
        ) from e
    # #437: a Permission-denied / exec failure (e.g. a bundled engine binary
    # that lost its +x bit) is NOT an OOM — don't send the user to the Flush
    # button; tell them what's actually wrong.
    es = str(e)
    if isinstance(e, PermissionError) or "Permission denied" in es or "Errno 13" in es:
        raise RuntimeError(
            f"A required engine binary couldn't be executed (permission denied). "
            f"This usually means a bundled binary lost its execute bit — reinstall, "
            f"or run `chmod +x` on the engine binary named in the error. "
            f"Underlying error: {e}"
        ) from e
    raise RuntimeError(
        f"TTS engine stopped mid-generation. This usually means it ran out of memory. "
        f"Try the Flush button to reload the model, then regenerate. Underlying error: {e}"
    )


def _run_inference(
    model, text, language, ref_audio_path, ref_text, instruct, duration,
    num_step, guidance_scale, speed, t_shift, denoise,
    postprocess_output, layer_penalty_factor, position_temperature,
    class_temperature, used_seed, effect_preset="broadcast",
    max_chunk_chars=None, crossfade_ms=None,
):
    import torch
    try:
        if used_seed is not None:
            torch.manual_seed(used_seed)

        kwargs = {}
        if t_shift is not None: kwargs["t_shift"] = t_shift
        if layer_penalty_factor is not None: kwargs["layer_penalty_factor"] = layer_penalty_factor
        if position_temperature is not None: kwargs["position_temperature"] = position_temperature
        if class_temperature is not None: kwargs["class_temperature"] = class_temperature

        sr = model.sampling_rate if hasattr(model, 'sampling_rate') else 24000

        # Inline [pause Nms] markers (issue #276): split the text and stitch
        # silence between independently-synthesized spans. Fully opt-in — text
        # without a marker takes the unchanged single-shot path below.
        from omnivoice.utils.text import parse_pause_markers
        segments = parse_pause_markers(text)
        has_pause = len(segments) > 1 or (segments and segments[0][1] > 0)

        if has_pause:
            def _gen_span(span_text):
                # Per-span duration is left to the model; an explicit overall
                # `duration` can't be meaningfully split across spans.
                return model.generate(
                    text=span_text, language=language, ref_audio=ref_audio_path,
                    ref_text=ref_text, instruct=instruct, duration=None,
                    num_step=num_step, guidance_scale=guidance_scale, speed=speed,
                    denoise=denoise, postprocess_output=postprocess_output,
                    **kwargs
                )[0]
            audio_out = _render_with_pauses(_gen_span, segments, sr)
        else:
            # Wave 1.2: long text is split at sentence boundaries and the
            # per-chunk audio crossfaded — removes the length ceiling. Short
            # text takes the single-shot path below unchanged. [pause] inputs
            # keep the dedicated stitcher above (spans are already short).
            from services.chunked_tts import (
                DEFAULT_CROSSFADE_MS, DEFAULT_MAX_CHUNK_CHARS,
                concatenate_audio_chunks, split_text_into_chunks,
            )
            _max_chars = DEFAULT_MAX_CHUNK_CHARS if max_chunk_chars is None else max_chunk_chars
            _xfade_ms = DEFAULT_CROSSFADE_MS if crossfade_ms is None else crossfade_ms
            text_chunks = split_text_into_chunks(text, _max_chars)
            if len(text_chunks) > 1:
                parts = []
                for i, chunk_text in enumerate(text_chunks):
                    # Vary the seed per chunk (deterministically) to avoid
                    # correlated RNG artifacts across chunk boundaries.
                    if used_seed is not None:
                        torch.manual_seed(used_seed + i)
                    parts.append(model.generate(
                        text=chunk_text, language=language, ref_audio=ref_audio_path,
                        ref_text=ref_text, instruct=instruct, duration=None,
                        num_step=num_step, guidance_scale=guidance_scale, speed=speed,
                        denoise=denoise, postprocess_output=postprocess_output,
                        **kwargs
                    )[0])
                audio_out = concatenate_audio_chunks(parts, sr, _xfade_ms)
            else:
                audios = model.generate(
                    text=text, language=language, ref_audio=ref_audio_path,
                    ref_text=ref_text, instruct=instruct, duration=duration,
                    num_step=num_step, guidance_scale=guidance_scale, speed=speed,
                    denoise=denoise, postprocess_output=postprocess_output,
                    **kwargs
                )
                audio_out = audios[0]

        # Apply DSP effect preset. The OmniVoice model never masters its own
        # output, so mastering always runs here (unchanged behavior).
        return _apply_effect_chain(audio_out, sr, effect_preset)

    except ValueError as e:
        # Don't wrap validation errors in OOM message
        raise e
    except Exception as e:
        _oom_friendly_reraise(e)


def _run_backend_inference(
    backend, text, language, ref_audio_path, ref_text, instruct, duration,
    num_step, guidance_scale, speed, denoise, postprocess_output,
    used_seed, effect_preset="broadcast",
    max_chunk_chars=None, crossfade_ms=None,
):
    """Engine-aware twin of :func:`_run_inference` (issue #312).

    Runs the request through a pluggable ``TTSBackend`` adapter instead of the
    OmniVoice model directly. The adapter protocol is narrower than the
    OmniVoice-native surface — engine-specific extras (``t_shift``,
    ``layer_penalty_factor``, …) only exist on the native path, which is why
    OmniVoice itself still goes through ``_run_inference``.
    """
    import torch
    try:
        if used_seed is not None:
            torch.manual_seed(used_seed)

        if language and language.lower() == "auto":
            language = None

        gen_kwargs = dict(
            language=language, ref_audio=ref_audio_path, ref_text=ref_text,
            instruct=instruct, num_step=num_step, guidance_scale=guidance_scale,
            speed=speed, denoise=denoise, postprocess_output=postprocess_output,
        )
        sr = backend.sample_rate

        # Inline [pause Nms] markers (issue #276) work for every engine — the
        # silence stitching is model-free.
        from omnivoice.utils.text import parse_pause_markers
        segments = parse_pause_markers(text)
        has_pause = len(segments) > 1 or (segments and segments[0][1] > 0)

        if has_pause:
            def _gen_span(span_text):
                # Per-span duration is left to the engine; an explicit overall
                # `duration` can't be meaningfully split across spans.
                return backend.generate(span_text, duration=None, **gen_kwargs)
            audio_out = _render_with_pauses(_gen_span, segments, sr)
        else:
            # Wave 1.2: sentence-boundary chunking for long text (see
            # _run_inference for the rationale; behavior is identical here).
            from services.chunked_tts import (
                DEFAULT_CROSSFADE_MS, DEFAULT_MAX_CHUNK_CHARS,
                concatenate_audio_chunks, split_text_into_chunks,
            )
            _max_chars = DEFAULT_MAX_CHUNK_CHARS if max_chunk_chars is None else max_chunk_chars
            _xfade_ms = DEFAULT_CROSSFADE_MS if crossfade_ms is None else crossfade_ms
            text_chunks = split_text_into_chunks(text, _max_chars)
            if len(text_chunks) > 1:
                parts = []
                for i, chunk_text in enumerate(text_chunks):
                    if used_seed is not None:
                        torch.manual_seed(used_seed + i)
                    parts.append(backend.generate(chunk_text, duration=None, **gen_kwargs))
                audio_out = concatenate_audio_chunks(parts, sr, _xfade_ms)
            else:
                audio_out = backend.generate(text, duration=duration, **gen_kwargs)

        return _apply_effect_chain(
            audio_out, sr, effect_preset,
            skip_mastering=getattr(backend, "applies_own_mastering", False),
        )

    except ValueError as e:
        # Don't wrap validation errors in OOM message
        raise e
    except Exception as e:
        _oom_friendly_reraise(e)


@router.post("/generate")
async def generate_speech(
    text: str = Form(...),
    language: Optional[str] = Form(None),
    ref_audio: Optional[UploadFile] = File(None),
    ref_text: Optional[str] = Form(None),
    instruct: Optional[str] = Form(None),
    duration: Optional[float] = Form(None),
    num_step: int = Form(16),
    guidance_scale: float = Form(2.0),
    speed: float = Form(1.0),
    t_shift: Optional[float] = Form(None),
    denoise: bool = Form(True),
    postprocess_output: bool = Form(True),
    layer_penalty_factor: Optional[float] = Form(None),
    position_temperature: Optional[float] = Form(None),
    class_temperature: Optional[float] = Form(None),
    profile_id: Optional[str] = Form(None),
    seed: Optional[int] = Form(None),
    effect_preset: str = Form("broadcast"),
    engine: Optional[str] = Form(None),
    # Wave 1.2 — unlimited-length generation: long text is split at sentence
    # boundaries and crossfaded. 0 disables chunking (whole text to engine).
    max_chunk_chars: int = Form(800, ge=0),
    crossfade_ms: int = Form(50, ge=0, le=1000),
):
    # ── Engine resolution (issue #312) ──────────────────────────────────────
    # The request runs on the engine selected in Settings (POST /engines/select,
    # env var OMNIVOICE_TTS_BACKEND wins), or an explicit per-request `engine`
    # override — same pattern as /ws/tts's `engine` field and /v1/audio/speech's
    # `model`. Omitting both keeps the historical default (OmniVoice), so
    # existing API consumers see no change.
    from services.tts_backend import (
        OmniVoiceBackend, _mask_hf_tokens, active_backend_id, get_backend_class,
    )

    engine_id = engine or active_backend_id()
    try:
        backend_cls = get_backend_class(engine_id)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown TTS engine: {engine_id!r}. "
                "See GET /engines/tts for the list of valid engine ids."
            ),
        )

    _model = None
    _backend = None
    if backend_cls is OmniVoiceBackend:
        # OmniVoice keeps its native path: it carries the full advanced
        # parameter surface (t_shift, layer/position/class controls) that the
        # generic adapter protocol doesn't. Byte-identical to the old behavior.
        _model = await get_model()
    else:
        try:
            ok, msg = backend_cls.is_available()
        except Exception as exc:
            ok, msg = False, f"{type(exc).__name__}: {exc}"
        if not ok:
            raise HTTPException(
                status_code=400,
                detail=f"TTS engine '{engine_id}' is not available: {_mask_hf_tokens(msg)}",
            )
        # Reuse the per-process instance cache shared with the engine
        # health-check route so weights load once, not per request.
        from api.routers.engines import _get_engine_instance
        _backend = _get_engine_instance(backend_cls)

    # ── Routing gate (#21 — no silent CPU fallback). Computed ONCE per request
    # (host caps are constant; the per-request engine= override bypasses the
    # /engines/select gate, so this is the only place it's enforced for synth).
    from core.device_caps import detect_host_caps
    from services.engine_routing import resolve_routing, routing_notice
    _routing = resolve_routing(getattr(backend_cls, "gpu_compat", ("cpu",)), detect_host_caps())
    if _routing["routing_status"] == "unavailable":
        # The engine needs an accelerator this host lacks and has no CPU path.
        raise HTTPException(status_code=400, detail=_routing["routing_reason"])
    _routing_notice = routing_notice(_routing)  # (status, reason) or None

    ref_audio_path = None
    cleanup_ref = False
    used_seed = seed
    resolved_profile_id = None
    history_mode = None  # profile.kind when a profile drives; else inferred at insert

    if profile_id:
        with db_conn() as conn:
            row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if row:
            resolved_profile_id = profile_id
            # `kind` is authoritative (0005): 'design' profiles condition on
            # their deterministic rendered sample + instruct; 'clone' on the
            # user's reference. Lock always wins (it pins a specific take).
            # Rows from pre-0004 DBs mid-upgrade may lack the column → fall
            # back to the legacy is_locked/instruct inference.
            try:
                profile_kind = row["kind"] or "clone"
            except (KeyError, IndexError):
                profile_kind = "design" if (row["instruct"] and not row["is_locked"] and not row["ref_audio_path"]) else "clone"
            history_mode = profile_kind
            if row["is_locked"] and row["locked_audio_path"]:
                ref_audio_path = os.path.join(VOICES_DIR, row["locked_audio_path"])
                if not ref_text:
                    ref_text = row["ref_text"]
                if not instruct:
                    instruct = row["instruct"]
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            elif profile_kind == "design":
                # Rendered sample (if present) carries the voice identity;
                # instruct alone is the fallback for legacy archetype rows.
                ref_audio_path = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
                if ref_audio_path and not ref_text and row["ref_text"]:
                    ref_text = row["ref_text"]
                if not instruct:
                    instruct = row["instruct"]
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            elif row["instruct"] and not row["is_locked"] and not row["ref_audio_path"]:
                # Legacy design-shaped row (pre-0004 archetype materialization
                # failure path): instruct-only conditioning.
                if not instruct:
                    instruct = row["instruct"]
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            else:
                ref_audio_path = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
                if not ref_text and row["ref_text"]:
                    ref_text = row["ref_text"]
                if not instruct and row["instruct"]:
                    instruct = row["instruct"]
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            if language == "Auto":
                language = None
            # #533: a profile's stored language must drive generation when the
            # request didn't pin one. Without this the German (etc.) archetype
            # generates with language=None and the model drifts to English —
            # even though the archetype PREVIEW renders correctly (archetypes.py
            # passes the language). An EXPLICIT non-Auto request language still
            # wins; we only fill the gap. `row` is a sqlite3.Row, so guard the
            # column lookup for pre-language DBs mid-upgrade.
            if language is None:
                try:
                    prof_lang = row["language"]
                except (KeyError, IndexError):
                    prof_lang = None
                if prof_lang and prof_lang != "Auto":
                    language = prof_lang
    elif ref_audio is not None:
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:
                f.write(await ref_audio.read())
                ref_audio_path = f.name
                cleanup_ref = True
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # #308: a transcript-less reference is transcribed with the active ASR
    # backend (whisperx / faster-whisper / mlx-whisper) instead of the model's
    # built-in transformers pipeline, which cannot load whisper-large-v3-turbo
    # on transformers 5.3. On failure ref_text stays None and the model's
    # fallback behaves exactly as before.
    if ref_audio_path and not ref_text:
        from services.asr_backend import transcribe_reference
        ref_text = await asyncio.get_running_loop().run_in_executor(
            _gpu_pool, transcribe_reference, ref_audio_path
        )

    # #526: materialize a concrete seed when none was supplied (and no profile
    # pinned one) so the take is reproducible and we can hand it back via the
    # X-Seed header for the "keep this seed" control. An explicit request seed
    # or a profile's stored seed still wins — used_seed is only filled when it
    # is still None here, never overwritten.
    if used_seed is None:
        used_seed = random.randint(0, 2**31 - 1)

    start_time = time.time()
    try:
        loop = asyncio.get_running_loop()
        if _backend is not None:
            audio_tensor = await loop.run_in_executor(
                _gpu_pool, _run_backend_inference,
                _backend, text, language, ref_audio_path, ref_text, instruct,
                duration, num_step, guidance_scale, speed, denoise,
                postprocess_output, used_seed, effect_preset,
                max_chunk_chars, crossfade_ms,
            )
            # Read after generation: engines with lazy model loading report
            # their real rate only once weights are up.
            sample_rate = _backend.sample_rate
        else:
            audio_tensor = await loop.run_in_executor(
                _gpu_pool, _run_inference,
                _model, text, language, ref_audio_path, ref_text, instruct, duration,
                num_step, guidance_scale, speed, t_shift, denoise,
                postprocess_output, layer_penalty_factor, position_temperature,
                class_temperature, used_seed, effect_preset,
                max_chunk_chars, crossfade_ms,
            )
            sample_rate = _model.sampling_rate
        # Invisible AudioSeal provenance watermark on the final audio. Embedding
        # was previously only wired into the dub pipeline (dub_generate.py), so
        # plain TTS came out unmarked despite the setting being on. embed_watermark
        # self-gates on the user's watermark setting + AudioSeal availability and
        # passes the audio through unchanged on any failure, so it never breaks
        # generation.
        from services.watermark import embed_watermark
        audio_tensor = await loop.run_in_executor(
            _gpu_pool, embed_watermark, audio_tensor, sample_rate
        )
        gen_time = round(time.time() - start_time, 2)

        audio_id = str(uuid.uuid4())[:8]
        audio_filename = f"{audio_id}.wav"
        audio_path = os.path.join(OUTPUTS_DIR, audio_filename)
        _safe_torchaudio_save(audio_path, audio_tensor, sample_rate)

        audio_dur = round(audio_tensor.shape[-1] / sample_rate, 2)

        with db_conn() as conn:
            conn.execute(
                "INSERT INTO generation_history (id, text, mode, language, instruct, profile_id, audio_path, duration_seconds, generation_time, seed, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (audio_id, text[:200], history_mode or ("clone" if ref_audio_path else "design"),
                 language or "Auto", instruct or "", resolved_profile_id,
                 audio_filename, audio_dur, gen_time, used_seed, time.time())
            )
        event_bus.emit("generation_history", {"action": "created", "id": audio_id})

        buffer = io.BytesIO()
        _safe_torchaudio_save(buffer, audio_tensor, sample_rate, format="wav")
        buffer.seek(0)
        wav_bytes = buffer.read()

        async def _stream_wav():
            chunk_size = 16384
            for i in range(0, len(wav_bytes), chunk_size):
                yield wav_bytes[i:i + chunk_size]

        _resp_headers = {
            "X-Audio-Id": audio_id,
            "X-Gen-Time": str(gen_time),
            "X-Audio-Path": audio_filename,
            "X-Seed": str(used_seed) if used_seed is not None else "",
            "X-Audio-Duration": str(audio_dur),
            "Content-Length": str(len(wav_bytes)),
        }
        # Routing notice (#21): cpu_fallback or accelerated-with-caveat only;
        # the WAV body is binary so the header channel is the carrier.
        if _routing_notice:
            from services.engine_routing import header_safe_reason
            _resp_headers["X-OmniVoice-Routing"] = _routing_notice[0]
            _hr = header_safe_reason(_routing_notice[1])
            if _hr:
                _resp_headers["X-OmniVoice-Routing-Reason"] = _hr
        return StreamingResponse(
            _stream_wav(),
            media_type="audio/wav",
            headers=_resp_headers,
        )
    except HTTPException:
        raise
    except ValueError as e:
        logger.error("Validation failed: %s", e)
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        tb = traceback.format_exc()
        logger.error("Inference failed: %s\n%s", e, tb)
        raise HTTPException(
            status_code=500,
            detail=(
                f"Couldn't synthesize audio. See Settings → Logs → Backend for the full trace. "
                f"Underlying error: {e}"
            ),
        )
    finally:
        if cleanup_ref and ref_audio_path:
            with contextlib.suppress(OSError):
                os.remove(ref_audio_path)

def _safe_output_path(name):
    if not name:
        return None
    base = os.path.basename(name)
    if base != name:
        return None
    outputs_real = os.path.realpath(OUTPUTS_DIR)
    candidate = os.path.realpath(os.path.join(OUTPUTS_DIR, base))
    if not candidate.startswith(outputs_real + os.sep):
        return None
    return candidate


@router.get("/history")
def list_history():
    """Newest 50 generations whose audio still exists on disk.

    Rows whose WAV was deleted out-of-band (cleared outputs dir, manual
    cleanup) used to come back anyway and render dead players that 404 on
    every fetch; prune them here so the UI never sees them again."""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM generation_history ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
        alive, stale_ids = [], []
        for r in rows:
            p = _safe_output_path(r["audio_path"]) if r["audio_path"] else None
            if r["audio_path"] and (not p or not os.path.exists(p)):
                stale_ids.append(r["id"])
            else:
                alive.append(dict(r))
        if stale_ids:
            conn.executemany(
                "DELETE FROM generation_history WHERE id=?",
                [(i,) for i in stale_ids],
            )
            logger.info("pruned %d stale history rows (audio file gone)", len(stale_ids))
    return alive

@router.delete("/history")
def clear_history():
    with db_conn() as conn:
        rows = conn.execute("SELECT audio_path FROM generation_history").fetchall()
        for r in rows:
            p = _safe_output_path(r["audio_path"])
            if p and os.path.exists(p):
                with contextlib.suppress(OSError):
                    os.remove(p)
        conn.execute("DELETE FROM generation_history")
    event_bus.emit("generation_history")
    return {"cleared": True}

@router.delete("/history/{history_id}")
def delete_single_history(history_id: str):
    with db_conn() as conn:
        row = conn.execute("SELECT audio_path FROM generation_history WHERE id=?", (history_id,)).fetchone()
        if row and row["audio_path"]:
            p = _safe_output_path(row["audio_path"])
            if p and os.path.exists(p):
                with contextlib.suppress(OSError):
                    os.remove(p)
        conn.execute("DELETE FROM generation_history WHERE id=?", (history_id,))
    event_bus.emit("generation_history", {"action": "deleted", "id": history_id})
    return {"deleted": True}
