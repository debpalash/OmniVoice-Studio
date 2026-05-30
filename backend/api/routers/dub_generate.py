import os
import json
import logging
import time
import asyncio
import numpy as np
import torch
import torchaudio
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from core.db import db_conn
from core.config import DUB_DIR, VOICES_DIR, dub_seg_path
from core.tasks import task_manager
from schemas.requests import DubRequest
from services.model_manager import get_model, _gpu_pool
from services.audio_dsp import apply_mastering, normalize_audio, apply_effects_chain, get_effect_chain
from services.audio_io import atomic_save_wav, _safe_torchaudio_save
from services.ffmpeg_utils import find_ffmpeg, spawn_subprocess
from services.rvc import apply_rvc, is_enabled as rvc_is_enabled
from services.incremental import segment_fingerprint
from services.watermark import embed_watermark
from api.routers.dub_core import _get_job, _save_job

logger = logging.getLogger("omnivoice.dub")

# Maximum compression ratio we'll attempt with pitch-preserving stretch
# before declaring "no way to fit cleanly" and falling back. atempo
# remains intelligible up to ~1.5× then introduces audible WSOLA
# artefacts; above ~1.8× speech becomes a fast garbled stream that no
# DSP can rescue. The contributing-factor pipeline (CPS-aware slot-fit
# in services/speech_rate.py, gap absorption below) keeps us under this
# in practice — this is only a guard rail.
MAX_STRETCH_RATIO = 1.8
# How far a too-long segment is allowed to bleed into the silent gap
# before the next segment. Buys headroom on languages with higher
# information density (Bengali, Hindi, Arabic…) without the audio
# colliding with the next speaker's onset.
GAP_OVERFLOW_MAX_S = 0.25
GAP_OVERFLOW_BUFFER_S = 0.05


def _atempo_chain(ratio: float) -> str:
    """Build an `atempo=…,atempo=…` filter chain for arbitrary ratios.

    ffmpeg's atempo filter is limited to [0.5, 2.0] per stage. Chaining
    multiple stages multiplies the effective ratio while keeping each
    individual stage inside the well-behaved range. Pitch is preserved
    (WSOLA-style time-domain stretching). ratio > 1 speeds up, < 1
    slows down.
    """
    stages: list[str] = []
    remaining = ratio
    while remaining > 2.0:
        stages.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        stages.append("atempo=0.5")
        remaining /= 0.5
    stages.append(f"atempo={remaining:.6f}")
    return ",".join(stages)


async def _pitch_preserving_stretch(
    wav: torch.Tensor, target_samples: int, sr: int,
) -> torch.Tensor:
    """Time-stretch a (1, samples) tensor to `target_samples` while
    preserving pitch, by piping the audio through `ffmpeg atempo`.

    Async so it never blocks the event loop: it's awaited from the `_stream`
    generator, and each ffmpeg call is ~50-100 ms — a synchronous
    ``subprocess.run`` here froze health-checks / SSE / every concurrent
    request for the whole multi-segment job.

    Returns a (1, target_samples) tensor on the same device as input.
    Raises RuntimeError when ffmpeg fails — callers should fall back to
    naive linear interpolation, accepting the pitch shift, to ensure the
    output isn't silent.
    """
    wl = int(wav.shape[-1])
    if target_samples <= 0 or wl == target_samples:
        return wav
    ratio = wl / target_samples
    filter_str = _atempo_chain(ratio)

    # Mono float32 via stdin → ffmpeg → stdout. One subprocess per segment,
    # run off the event loop so concurrent requests stay responsive.
    arr = wav.detach().cpu().to(torch.float32).numpy().reshape(-1).astype(np.float32, copy=False)
    proc = await spawn_subprocess(
        find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
        "-af", filter_str,
        "-f", "f32le", "-ar", str(sr), "-ac", "1", "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate(input=arr.tobytes())
    if proc.returncode != 0 or not stdout:
        raise RuntimeError(
            (stderr.decode(errors="replace") or "atempo failed")[:200]
        )
    out_arr = np.frombuffer(stdout, dtype=np.float32)
    # atempo rarely lands exactly on the integer sample count, so
    # pad/trim to the requested slot length.
    if len(out_arr) < target_samples:
        pad = np.zeros(target_samples - len(out_arr), dtype=np.float32)
        out_arr = np.concatenate([out_arr, pad])
    elif len(out_arr) > target_samples:
        out_arr = out_arr[:target_samples]
    return torch.from_numpy(out_arr.copy()).unsqueeze(0).to(wav.device)


router = APIRouter()

@router.post("/dub/generate/{job_id}")
async def dub_generate(job_id: str, req: DubRequest):
    """Adds a dub generation job to the async batch task pool."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="This dub session has expired or was never created. Re-upload the video to start a new one.",
        )

    _model = await get_model()

    async def _stream(task_id):
        total = len(req.segments)
        all_segment_wavs = []
        sync_scores = []

        # Phase 4.1 — partial regen. If `regen_only` is set, we only run TTS
        # on segments whose id is in that set; the others reuse their existing
        # `seg_i.wav` on disk and slot into the final mix unchanged.
        regen_only = set(req.regen_only or []) if req.regen_only is not None else None
        seg_ids = req.segment_ids or []
        # Manifest: stable segment id per current index. Per-segment WAVs are
        # named by stable id (dub_seg_path) so regen reuses the right audio after
        # reorder; index-keyed readers (preview/export) resolve via this manifest.
        job["seg_order"] = [seg_ids[k] if k < len(seg_ids) else f"seg_{k}" for k in range(len(req.segments))]

        # Deferred disk writes: collect (index, tensor, sr, seg_id, fingerprint,
        # num_step) tuples during the hot loop and batch-flush after all TTS
        # completes. Eliminates ~200ms/seg of synchronous I/O from the GPU path.
        _pending_seg_writes: list[tuple] = []

        # Phase 4.1 bench instrumentation: measure where incremental time goes.
        # Only prints when regen_only is active (real-user incremental path).
        _t_start = time.perf_counter()
        _t_cache = 0.0
        _t_tts = 0.0

        for i, seg in enumerate(req.segments):
            seg_id = seg_ids[i] if i < len(seg_ids) else f"seg_{i}"

            # Check abort flag before each segment
            if task_manager.is_cancelled(task_id):
                yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i})}\n\n"
                return

            yield f"data: {json.dumps({'type': 'progress', 'current': i, 'total': total, 'text': seg.text[:50]})}\n\n"

            seg_duration = seg.end - seg.start
            if seg_duration <= 0.05 or not seg.text.strip():
                sr = _model.sampling_rate
                silence = torch.zeros(1, int(seg_duration * sr))
                all_segment_wavs.append((seg.start, seg.end, silence, sr))
                sync_scores.append(1.0)
                continue

            # Partial regen: if this segment isn't in the allow-list, reuse its
            # previously-rendered WAV so the final mix still covers the timeline.
            if regen_only is not None and seg_id not in regen_only:
                seg_wav_path = dub_seg_path(job_id, seg_id)
                if not os.path.exists(seg_wav_path):
                    # Back-compat: jobs rendered before id-named files used seg_{index}.wav.
                    _legacy = dub_seg_path(job_id, i)
                    if os.path.exists(_legacy):
                        seg_wav_path = _legacy
                if os.path.exists(seg_wav_path):
                    try:
                        _t_cache_0 = time.perf_counter()
                        cached_wav, cached_sr = torchaudio.load(seg_wav_path)
                        if cached_sr != _model.sampling_rate:
                            import torchaudio.functional as AF
                            cached_wav = AF.resample(cached_wav, cached_sr, _model.sampling_rate)
                        # Pad/trim to slot.
                        target_samples = int(seg_duration * _model.sampling_rate)
                        current_samples = cached_wav.shape[-1]
                        if target_samples > current_samples:
                            cached_wav = torch.nn.functional.pad(cached_wav, (0, target_samples - current_samples))
                        elif current_samples > target_samples:
                            cached_wav = cached_wav[..., :target_samples]
                        all_segment_wavs.append((seg.start, seg.end, cached_wav, _model.sampling_rate))
                        sync_scores.append(getattr(seg, 'sync_ratio', None) or 1.0)
                        _t_cache += time.perf_counter() - _t_cache_0
                        continue
                    except Exception as e:
                        # Fall through to a silent placeholder if the cached WAV
                        # is broken — cleaner than aborting the whole mix.
                        yield f"data: {json.dumps({'type': 'warning', 'segment': i, 'message': f'cached seg lost, padding silence: {str(e)[:120]}'})}\n\n"
                sr = _model.sampling_rate
                silence = torch.zeros(1, int(seg_duration * sr))
                all_segment_wavs.append((seg.start, seg.end, silence, sr))
                sync_scores.append(1.0)
                continue

            def _gen(text, lang, instruct_str, dur_s, nstep, cfg, spd, profile_id, effect_preset):
                ref_audio = None
                ref_text = None
                used_seed = None

                # Auto-clones extracted from the source video during prepare
                # (see services/speaker_clone.py) live at job["speaker_clones"]
                # keyed by speaker_id. We use the `auto:` prefix so they can't
                # collide with persistent voice_profiles.id values.
                if profile_id and profile_id.startswith("auto:"):
                    key = profile_id[len("auto:"):]
                    clones = job.get("speaker_clones") or {}
                    # Match by the safe-name key first, fall back to speaker_id.
                    auto = None
                    for spk, info in clones.items():
                        if spk.lower().replace(" ", "_") == key or spk == key:
                            auto = info
                            break
                    if auto:
                        ref_audio = auto.get("ref_audio")
                        ref_text = auto.get("ref_text")
                    profile_id = None  # prevent the voice_profiles lookup below

                if profile_id:
                    with db_conn() as conn:
                        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
                    if row:
                        if row["is_locked"] and row["locked_audio_path"]:
                            ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                            ref_text = row["ref_text"]
                            used_seed = row["seed"]
                        elif row["instruct"] and not row["is_locked"]:
                            used_seed = row["seed"] 
                        else:
                            ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                            ref_text = row["ref_text"]
                            used_seed = row["seed"]
                            
                        if not instruct_str:
                            instruct_str = row["instruct"]

                if used_seed is not None:
                    torch.manual_seed(used_seed)

                try:
                    audios = _model.generate(
                        text=text, language=lang if lang != "Auto" else None,
                        ref_audio=ref_audio, ref_text=ref_text,
                        instruct=instruct_str if instruct_str else None,
                        duration=dur_s, num_step=nstep, guidance_scale=cfg,
                        speed=spd, denoise=True, postprocess_output=True,
                    )
                    audio_out = audios[0]
                    sr = _model.sampling_rate if hasattr(_model, 'sampling_rate') else 24000

                    # Apply per-segment DSP effect preset (default: broadcast)
                    seg_effect_preset = effect_preset or "broadcast"
                    if seg_effect_preset == "raw":
                        return audio_out

                    mastered_audio = apply_mastering(audio_out, sample_rate=sr)
                    effect_chain = get_effect_chain(seg_effect_preset)
                    if effect_chain:
                        mastered_audio = apply_effects_chain(
                            mastered_audio,
                            sample_rate=sr,
                            chain=effect_chain,
                        )
                    return normalize_audio(mastered_audio, target_dBFS=-2.0)
                except Exception as e:
                    is_oom = (
                        isinstance(e, torch.cuda.OutOfMemoryError)
                        or "out of memory" in str(e).lower()
                        or "CUDA error" in str(e)
                    )
                    import gc
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                        torch.mps.empty_cache()

                    if not is_oom:
                        raise

                    retry_steps = min(nstep, 8)
                    logger.warning(
                        "OOM on segment (nstep=%d), retrying with %d steps after cache flush",
                        nstep, retry_steps,
                    )
                    try:
                        audios = _model.generate(
                            text=text, language=lang if lang != "Auto" else None,
                            ref_audio=ref_audio, ref_text=ref_text,
                            instruct=instruct_str if instruct_str else None,
                            duration=dur_s, num_step=retry_steps, guidance_scale=cfg,
                            speed=spd, denoise=True, postprocess_output=True,
                        )
                        audio_out = audios[0]
                        sr = _model.sampling_rate if hasattr(_model, 'sampling_rate') else 24000

                        seg_effect_preset = effect_preset or "broadcast"
                        if seg_effect_preset == "raw":
                            return audio_out

                        mastered_audio = apply_mastering(audio_out, sample_rate=sr)
                        effect_chain = get_effect_chain(seg_effect_preset)
                        if effect_chain:
                            mastered_audio = apply_effects_chain(
                                mastered_audio,
                                sample_rate=sr,
                                chain=effect_chain,
                            )
                        return normalize_audio(mastered_audio, target_dBFS=-2.0)
                    except Exception as retry_err:
                        raise RuntimeError(
                            f"Ran out of GPU memory generating this segment. "
                            f"Retried with {retry_steps} steps but still failed. "
                            f"Try the Flush button in the header to free VRAM, "
                            f"or switch to CPU in Settings. "
                            f"Underlying error: {retry_err}"
                        ) from retry_err

            seg_profile = seg.profile_id or None
            seg_speed = seg.speed if hasattr(seg, 'speed') and seg.speed is not None else req.speed
            seg_lang = seg.target_lang if getattr(seg, 'target_lang', None) else req.language

            seg_instruct = seg.instruct or req.instruct
            # Phase 4.2 — if the segment carries a free-form direction, parse it
            # and append the taxonomy instruct (e.g. "urgent, surprised") on top
            # of whatever instruct was already set. Also apply the director's
            # speed bias so "urgent" actually sounds a bit quicker.
            seg_direction = getattr(seg, 'direction', None)
            if seg_direction and seg_direction.strip():
                try:
                    from services.director import parse as _parse_direction
                    d = _parse_direction(seg_direction)
                    extra_instruct = d.instruct_prompt()
                    if extra_instruct:
                        seg_instruct = (
                            f"{seg_instruct}, {extra_instruct}" if seg_instruct else extra_instruct
                        )
                    bias = d.rate_bias()
                    if bias and abs(bias - 1.0) > 0.01:
                        # Speed-bias from a Direction only multiplies seg_speed
                        # in strict_slot mode, which is the legacy path that
                        # compresses audio at synthesis time to fit the slot.
                        # In concise / stretch_video modes we preserve natural
                        # rate so the user gets the "urgent" or "slow" voice
                        # the director asked for without the chipmunk side-
                        # effect that overshooting the slot would otherwise
                        # cause.
                        if (req.timing_strategy or "concise") == "strict_slot":
                            seg_speed = (seg_speed or 1.0) * bias
                except Exception as e:
                    logger.debug("direction parse skipped for %s: %s", getattr(seg, 'id', '?'), e)

            loop = asyncio.get_running_loop()
            try:
                # Fast-preview mode for interactive edits — trade ~10–20 %
                # quality for ~2× speed by dropping flow-matching steps.
                # Client sends `preview=true` when the user is iterating;
                # before final export the client should re-call without the
                # flag to restore num_step=req.num_step quality.
                _num_step = 8 if req.preview else req.num_step
                _t_tts_0 = time.perf_counter()
                seg_effect_preset = getattr(seg, "effect_preset", None) or "broadcast"

                # In concise / stretch_video modes we pass dur_s=None so the
                # TTS model speaks at its natural rate for this text length —
                # the whole point of the new timing strategies is to never
                # squeeze the speech to fit. strict_slot keeps the legacy
                # behaviour where dur_s is the slot hint.
                _strategy = (req.timing_strategy or "concise").lower()
                _dur_for_tts = seg_duration if _strategy == "strict_slot" else None

                audio_tensor = await loop.run_in_executor(
                    _gpu_pool, _gen,
                    seg.text, seg_lang, seg_instruct, _dur_for_tts,
                    _num_step, req.guidance_scale, seg_speed, seg_profile, seg_effect_preset,
                )
                _t_tts += time.perf_counter() - _t_tts_0

                # Check abort immediately after GPU work completes
                if task_manager.is_cancelled(task_id):
                    yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i + 1})}\n\n"
                    return

                target_samples = int(seg_duration * _model.sampling_rate)
                current_samples = audio_tensor.shape[-1]

                if _strategy == "strict_slot":
                    # Legacy: pad short audio + trim long audio so the mix
                    # loop receives slot-sized buffers. The atempo squeeze
                    # in the mix loop never fires here because we already
                    # forced size = target_samples.
                    if target_samples > current_samples:
                        pad_amount = target_samples - current_samples
                        audio_tensor = torch.nn.functional.pad(audio_tensor, (0, pad_amount))
                    elif current_samples > target_samples:
                        audio_tensor = audio_tensor[..., :target_samples]
                # concise / stretch_video: keep audio at its natural length.
                # The mix loop decides per-mode whether to trim, slip, or
                # stretch the video to accommodate it.

                generated_dur = audio_tensor.shape[-1] / _model.sampling_rate
                sync_ratio = round(generated_dur / max(seg_duration, 0.01), 3)

                sync_scores.append(sync_ratio)

                # Build the fingerprint now (cheap) but defer the disk write
                # and job flush to the batch-write phase after the GPU loop.
                _seg_fp = None
                try:
                    _seg_fp = segment_fingerprint({
                        "text": seg.text,
                        "target_lang": getattr(seg, "target_lang", None),
                        "profile_id": getattr(seg, "profile_id", None),
                        "instruct": getattr(seg, "instruct", None),
                        "speed": getattr(seg, "speed", None),
                        "direction": getattr(seg, "direction", None),
                        "effect_preset": getattr(seg, "effect_preset", None),
                    })
                except Exception as e:
                    logger.debug("seg fingerprint skipped for %s: %s", seg_id, e)

                _pending_seg_writes.append((i, audio_tensor, _model.sampling_rate, seg_id, _seg_fp, _num_step))

                # RVC needs the WAV on disk, so write it immediately only
                # when RVC is active (uncommon path).
                if rvc_is_enabled():
                    seg_wav_path = dub_seg_path(job_id, seg_id)
                    atomic_save_wav(seg_wav_path, audio_tensor, _model.sampling_rate)
                    try:
                        await loop.run_in_executor(_gpu_pool, apply_rvc, seg_wav_path)
                        rvc_wav, rvc_sr = torchaudio.load(seg_wav_path)
                        if rvc_sr == _model.sampling_rate:
                            audio_tensor = rvc_wav

                            target_samples = int(seg_duration * _model.sampling_rate)
                            current_samples = audio_tensor.shape[-1]
                            if target_samples > current_samples:
                                audio_tensor = torch.nn.functional.pad(audio_tensor, (0, target_samples - current_samples))
                            elif current_samples > target_samples:
                                audio_tensor = audio_tensor[..., :target_samples]
                    except Exception as e:
                        yield f"data: {json.dumps({'type': 'warning', 'segment': i, 'message': f'RVC skipped: {str(e)[:120]}'})}\n\n"

                all_segment_wavs.append((seg.start, seg.end, audio_tensor, _model.sampling_rate))
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'segment': i, 'error': str(e)})}\n\n"
                sr = _model.sampling_rate
                all_segment_wavs.append((seg.start, seg.end, torch.zeros(1, int(seg_duration * sr)), sr))
                sync_scores.append(1.0)

        _t_loop_end = time.perf_counter()

        yield f"data: {json.dumps({'type': 'assembling'})}\n\n"

        # ── Batch disk-write phase ────────────────────────────────────
        # Flush all per-segment WAVs and fingerprints in one burst now
        # that the GPU-hot loop is done. This keeps I/O off the critical
        # path and cuts ~200ms × N_segments of latency.
        _t_diskw_0 = time.perf_counter()
        hashes = job.setdefault("seg_hashes", {})
        quality_map = job.setdefault("seg_num_step", {})
        for (_si, _wav, _sr, _sid, _fp, _nstep) in _pending_seg_writes:
            seg_wav_path = dub_seg_path(job_id, _sid)
            try:
                # Apply invisible watermark before writing to disk
                _wav = embed_watermark(_wav, _sr)
                atomic_save_wav(seg_wav_path, _wav, _sr)
            except Exception as e:
                logger.warning("deferred seg write failed for %s: %s", _sid, e)
            if _fp is not None:
                hashes[_sid] = _fp
            quality_map[_sid] = _nstep
        # Single job flush instead of one per 8 segments.
        _save_job(job_id, job)
        _t_diskw = time.perf_counter() - _t_diskw_0

        sr = _model.sampling_rate
        strategy = (req.timing_strategy or "concise").lower()
        slot_fit = (req.slot_fit or "time_stretch").lower()
        overflow_budget_s = max(0.0, float(req.overflow_budget_s or 0.0))

        # Per-segment fit_status emitted alongside the legacy sync_scores so
        # the UI can replace the lying "Sync: 100%" badge with a truthful
        # "Fits / Overflows +0.4s / Slipped 0.2s / Video stretched 1.18×".
        fit_status: list[dict] = []

        # Mode B layout: when stretch_video is on, compute a new timeline
        # where each segment's slot equals the natural-rate dub audio length;
        # gaps stay at 1.0×. Persisted on the job so dub_export.py can build
        # the matching per-segment setpts filter chain on the source video.
        new_layout: list[tuple[float, float]] = []
        video_stretch_plan: list[dict] = []
        orig_total_dur = float(job.get("duration") or 0.0)

        if strategy == "stretch_video":
            cursor = 0.0
            for i, (orig_start, orig_end, wav, _) in enumerate(all_segment_wavs):
                wl_i = wav.shape[-1]
                natural_dur = (wl_i / sr) if wl_i > 0 else max(0.0, orig_end - orig_start)
                if i == 0:
                    # Preserve the pre-roll (silence before the first seg).
                    cursor = orig_start
                else:
                    prev_orig_end = all_segment_wavs[i - 1][1]
                    gap = max(0.0, orig_start - prev_orig_end)
                    cursor += gap
                new_start = cursor
                new_end = cursor + natural_dur
                new_layout.append((new_start, new_end))
                orig_dur = max(1e-3, orig_end - orig_start)
                video_stretch_plan.append({
                    "orig_start": round(orig_start, 4),
                    "orig_end": round(orig_end, 4),
                    "new_start": round(new_start, 4),
                    "new_end": round(new_end, 4),
                    "stretch_ratio": round(natural_dur / orig_dur, 4),
                })
                cursor = new_end
            # Preserve the trailing tail (anything after the last seg in the
            # original video) at 1.0× rate.
            if all_segment_wavs:
                last_orig_end = all_segment_wavs[-1][1]
                cursor += max(0.0, orig_total_dur - last_orig_end)
            new_total_dur = max(cursor, orig_total_dur)
            total_samples = int(new_total_dur * sr)
        else:
            total_samples = int(orig_total_dur * sr)

        full_audio = torch.zeros(1, total_samples)

        for i, (start, end, wav, _) in enumerate(all_segment_wavs):
            seg_ref = req.segments[i] if i < len(req.segments) else None
            seg_gain = getattr(seg_ref, "gain", None) if seg_ref is not None else None
            seg_gain = seg_gain if seg_gain is not None else 1.0
            seg_gain = max(0.0, min(2.0, seg_gain))
            adjusted = wav * seg_gain
            wl = adjusted.shape[-1]
            natural_dur = wl / sr if wl > 0 else 0.0
            orig_dur = max(0.0, end - start)

            if strategy == "stretch_video":
                # Mode B: audio at natural rate, placed on the stretched
                # timeline. No trim, no atempo. dub_export handles the video.
                new_start, _new_end = new_layout[i]
                place_at = new_start
                fit_status.append({
                    "status": "video_stretched",
                    "stretch_ratio": round(natural_dur / max(orig_dur, 1e-3), 3),
                })

            elif strategy == "concise":
                # Mode A: never compress. Allow the audio to extend into the
                # silent gap before the next seg (existing heuristic) plus
                # any extra `overflow_budget_s`. Beyond that, hard-trim with
                # a short fade so we never overlap the next speaker.
                place_at = start
                effective_end = end
                if i + 1 < len(all_segment_wavs):
                    next_start = all_segment_wavs[i + 1][0]
                    gap = next_start - end
                    if gap > GAP_OVERFLOW_BUFFER_S:
                        effective_end = end + min(
                            gap - GAP_OVERFLOW_BUFFER_S, GAP_OVERFLOW_MAX_S,
                        )
                effective_end += overflow_budget_s
                slot_samples_eff = int(max(0.0, (effective_end - start)) * sr)
                if slot_samples_eff > 0 and wl > slot_samples_eff:
                    overflow_s = (wl - slot_samples_eff) / sr
                    adjusted = adjusted[..., :slot_samples_eff]
                    wl = adjusted.shape[-1]
                    fit_status.append({
                        "status": "overflows",
                        "overflow_s": round(overflow_s, 3),
                    })
                else:
                    fit_status.append({"status": "fits"})

            else:
                # strict_slot (legacy): preserve the previous atempo / trim /
                # off semantics so existing callers and back-compat tests
                # keep passing.
                place_at = start
                effective_end = end
                if i + 1 < len(all_segment_wavs):
                    next_start = all_segment_wavs[i + 1][0]
                    gap = next_start - end
                    if gap > GAP_OVERFLOW_BUFFER_S:
                        effective_end = end + min(
                            gap - GAP_OVERFLOW_BUFFER_S, GAP_OVERFLOW_MAX_S,
                        )
                slot_samples = int(max(0.0, (effective_end - start)) * sr)
                if slot_fit != "off" and slot_samples > 0 and wl > slot_samples:
                    if slot_fit == "time_stretch":
                        ratio = wl / slot_samples
                        capped_ratio = min(ratio, MAX_STRETCH_RATIO)
                        capped_target = int(wl / capped_ratio)
                        try:
                            adjusted = await _pitch_preserving_stretch(
                                adjusted, capped_target, sr,
                            )
                            if adjusted.shape[-1] > slot_samples:
                                adjusted = adjusted[..., :slot_samples]
                            if ratio > MAX_STRETCH_RATIO:
                                logger.info(
                                    "seg %d compression %.2f× exceeded cap; "
                                    "stretched to %.2f×, tail trimmed",
                                    i, ratio, capped_ratio,
                                )
                        except Exception as e:
                            logger.warning(
                                "atempo stretch failed for seg %d (%.2f×), "
                                "falling back to linear interp: %s",
                                i, ratio, e,
                            )
                            adjusted = torch.nn.functional.interpolate(
                                adjusted.unsqueeze(0),
                                size=slot_samples,
                                mode='linear',
                                align_corners=False,
                            ).squeeze(0)
                    else:  # "trim"
                        adjusted = adjusted[..., :slot_samples]
                    wl = adjusted.shape[-1]
                fit_status.append({
                    "status": "fits",
                    "compression_applied": (slot_fit == "time_stretch"
                                            and wl != int(natural_dur * sr)),
                })

            # Common: short fades to avoid pops, then mix into full_audio.
            fade_ms = 15
            fade_samples = int((fade_ms / 1000.0) * sr)
            if wl > fade_samples * 2:
                ramp_up = torch.linspace(0, 1, fade_samples, device=adjusted.device)
                ramp_down = torch.linspace(1, 0, fade_samples, device=adjusted.device)
                adjusted[0, :fade_samples] *= ramp_up
                adjusted[0, -fade_samples:] *= ramp_down

            s = int(place_at * sr)
            e = min(s + wl, total_samples)
            if s < total_samples:
                full_audio[:, s:e] += adjusted[:, :e - s]

        lang_code = req.language_code or "und"
        track_path = os.path.join(DUB_DIR, job_id, f"dubbed_{lang_code}.wav")
        _t_save_0 = time.perf_counter()
        # Apply invisible watermark to the final assembled track
        full_audio = embed_watermark(full_audio, sr)
        atomic_save_wav(track_path, full_audio, sr)
        _t_save = time.perf_counter() - _t_save_0
        _t_mix = _t_save_0 - _t_loop_end
        # Per-track metadata. For stretch_video, the dub wav is at the new
        # (longer) timeline, so we record its actual duration here too — the
        # mux step needs this to know whether to use the original video as-is
        # or stretch it per the plan.
        track_dur = full_audio.shape[-1] / sr if full_audio.shape[-1] > 0 else 0.0
        job["dubbed_tracks"][lang_code] = {
            "path": track_path,
            "language": req.language,
            "language_code": lang_code,
            "duration": round(track_dur, 4),
            "timing_strategy": strategy,
        }

        # Persist the timing strategy + (for Mode B) the per-segment stretch
        # plan so dub_export can build the matching video pipeline at mux
        # time. Plans are keyed by language code because each language gets
        # its own dub track with its own natural-rate audio layout.
        job["language"] = req.language
        job["language_code"] = lang_code
        job["timing_strategy"] = strategy
        if strategy == "stretch_video":
            stretch_plans = job.setdefault("video_stretch_plans", {})
            stretch_plans[lang_code] = {
                "plan": video_stretch_plan,
                "total_duration": round(track_dur, 4),
                "orig_duration": round(orig_total_dur, 4),
            }
        _save_job(job_id, job)

        _t_total = time.perf_counter() - _t_start
        logger.info(
            "bench[generate] total=%.2fs tts=%.2fs cache=%.2fs diskw=%.2fs mix=%.2fs save=%.2fs segs=%d%s",
            _t_total, _t_tts, _t_cache, _t_diskw, _t_mix, _t_save, total,
            f" regen={len(regen_only)}" if regen_only is not None else "",
        )

        yield f"data: {json.dumps({'type': 'done', 'segments_processed': total, 'language_code': lang_code, 'tracks': list(job['dubbed_tracks'].keys()), 'sync_scores': sync_scores, 'fit_status': fit_status, 'timing_strategy': strategy, 'seg_hashes': job.get('seg_hashes', {}), 'seg_num_step': job.get('seg_num_step', {})})}\n\n"

    task_id = f"dub_{job_id}_{int(time.time())}"
    await task_manager.add_task(task_id, "dub_generate", _stream, task_id)
    return {"task_id": task_id}


# ── Real-time segment preview ──────────────────────────────────────────
# Stream TTS for a single segment without the full pipeline overhead.
# The frontend calls this when the user edits a segment's text/instruct
# and wants to hear the result immediately.

from pydantic import BaseModel
from typing import Optional
from fastapi.responses import Response
import io


class SegmentPreviewRequest(BaseModel):
    text: str
    language: str = "Auto"
    instruct: Optional[str] = None
    profile_id: Optional[str] = None
    speed: float = 1.0
    duration: Optional[float] = None


@router.post("/dub/preview-segment/{job_id}")
async def preview_segment(job_id: str, req: SegmentPreviewRequest):
    """Generate TTS for a single segment and return WAV bytes.

    This is the fast path for interactive editing — 8 diffusion steps,
    no disk write, no watermark, no mix. Just raw audio preview.
    """
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    _model = await get_model()

    def _gen():
        ref_audio = None
        ref_text = None

        # Resolve profile / auto-clone
        pid = req.profile_id
        if pid and pid.startswith("auto:"):
            key = pid[len("auto:"):]
            clones = job.get("speaker_clones") or {}
            for spk, info in clones.items():
                if spk.lower().replace(" ", "_") == key or spk == key:
                    ref_audio = info.get("ref_audio")
                    ref_text = info.get("ref_text")
                    break
            pid = None

        instruct_str = req.instruct
        if pid:
            with db_conn() as conn:
                row = conn.execute(
                    "SELECT * FROM voice_profiles WHERE id=?", (pid,)
                ).fetchone()
            if row:
                if row["is_locked"] and row["locked_audio_path"]:
                    ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                    ref_text = row["ref_text"]
                elif row["ref_audio_path"]:
                    ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                    ref_text = row["ref_text"]
                if not instruct_str and row["instruct"]:
                    instruct_str = row["instruct"]

        lang = req.language if req.language != "Auto" else None
        audios = _model.generate(
            text=req.text,
            language=lang,
            ref_audio=ref_audio,
            ref_text=ref_text,
            instruct=instruct_str if instruct_str else None,
            duration=req.duration,
            num_step=8,  # fast preview
            guidance_scale=2.0,
            speed=req.speed,
            denoise=True,
            postprocess_output=True,
        )
        audio_out = audios[0]
        mastered = apply_mastering(
            audio_out,
            sample_rate=getattr(_model, "sampling_rate", 24000),
        )
        return normalize_audio(mastered, target_dBFS=-2.0)

    loop = asyncio.get_running_loop()
    audio_tensor = await loop.run_in_executor(_gpu_pool, _gen)

    sr = getattr(_model, "sampling_rate", 24000)
    buf = io.BytesIO()
    _safe_torchaudio_save(buf, audio_tensor, sr, format="wav")
    buf.seek(0)

    return Response(
        content=buf.read(),
        media_type="audio/wav",
        headers={
            "X-Audio-Duration": str(round(audio_tensor.shape[-1] / sr, 2)),
        },
    )

