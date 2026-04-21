import os
import json
import logging
import time
import asyncio
import torch
import torchaudio
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from core.db import get_db
from core.config import DUB_DIR, VOICES_DIR
from core.tasks import task_manager
from schemas.requests import DubRequest
from services.model_manager import get_model, _gpu_pool
from services.audio_dsp import apply_mastering, normalize_audio
from services.rvc import apply_rvc, is_enabled as rvc_is_enabled
from services.incremental import segment_fingerprint
from api.routers.dub_core import _get_job, _save_job

logger = logging.getLogger("omnivoice.dub")

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
                seg_wav_path = os.path.join(DUB_DIR, job_id, f"seg_{i}.wav")
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

            def _gen(text, lang, instruct_str, dur_s, nstep, cfg, spd, profile_id=None):
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
                    conn = get_db()
                    try:
                        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
                    finally:
                        conn.close()
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
                    mastered_audio = apply_mastering(audio_out, sample_rate=_model.sampling_rate if hasattr(_model, 'sampling_rate') else 24000)
                    return normalize_audio(mastered_audio, target_dBFS=-2.0)
                except Exception as e:
                    import gc
                    gc.collect()
                    if torch.backends.mps.is_available():
                        torch.mps.empty_cache()
                    elif torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    # User-facing: what happened · why · what to do.
                    raise RuntimeError(
                        f"Ran out of GPU memory generating this segment. "
                        f"Try the Flush button in the header to free VRAM, or switch to CPU in Settings. "
                        f"Underlying error: {e}"
                    )

            seg_instruct = seg.instruct or req.instruct
            seg_profile = seg.profile_id or None
            seg_speed = seg.speed if hasattr(seg, 'speed') and seg.speed is not None else req.speed
            seg_lang = seg.target_lang if getattr(seg, 'target_lang', None) else req.language

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
                        seg_speed = (seg_speed or 1.0) * bias
                except Exception as e:
                    logger.debug("direction parse skipped for %s: %s", getattr(seg, 'id', '?'), e)

            loop = asyncio.get_event_loop()
            try:
                # Fast-preview mode for interactive edits — trade ~10–20 %
                # quality for ~2× speed by dropping flow-matching steps.
                # Client sends `preview=true` when the user is iterating;
                # before final export the client should re-call without the
                # flag to restore num_step=req.num_step quality.
                _num_step = 8 if req.preview else req.num_step
                _t_tts_0 = time.perf_counter()
                audio_tensor = await loop.run_in_executor(
                    _gpu_pool, _gen,
                    seg.text, seg_lang, seg_instruct, seg_duration,
                    _num_step, req.guidance_scale, seg_speed, seg_profile,
                )
                _t_tts += time.perf_counter() - _t_tts_0

                # Check abort immediately after GPU work completes
                if task_manager.is_cancelled(task_id):
                    yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i + 1})}\n\n"
                    return
                
                target_samples = int(seg_duration * _model.sampling_rate)
                current_samples = audio_tensor.shape[-1]
                
                if target_samples > current_samples:
                    pad_amount = target_samples - current_samples
                    audio_tensor = torch.nn.functional.pad(audio_tensor, (0, pad_amount))
                elif current_samples > target_samples:
                    audio_tensor = audio_tensor[..., :target_samples]
                    
                generated_dur = audio_tensor.shape[-1] / _model.sampling_rate
                sync_ratio = round(generated_dur / max(seg_duration, 0.01), 3)
                
                sync_scores.append(sync_ratio)

                seg_wav_path = os.path.join(DUB_DIR, job_id, f"seg_{i}.wav")
                torchaudio.save(seg_wav_path, audio_tensor, _model.sampling_rate)

                # Phase 4.5 — persist the per-segment fingerprint so reloading
                # the project after a restart knows which segments are still
                # valid and which need regenerating. Stored at `job.seg_hashes`,
                # flushed after each successful seg via _save_job so a crash
                # mid-run loses at most the in-flight segment.
                try:
                    hashes = job.setdefault("seg_hashes", {})
                    fp = segment_fingerprint({
                        "text": seg.text,
                        "target_lang": getattr(seg, "target_lang", None),
                        "profile_id": getattr(seg, "profile_id", None),
                        "instruct": getattr(seg, "instruct", None),
                        "speed": getattr(seg, "speed", None),
                        "direction": getattr(seg, "direction", None),
                    })
                    hashes[seg_id] = fp
                    # Track the num_step actually used for this seg so the
                    # export path can find preview-quality segs and upgrade them.
                    quality_map = job.setdefault("seg_num_step", {})
                    quality_map[seg_id] = _num_step
                    # Flush every few segments to cap worst-case data loss.
                    if (i + 1) % 8 == 0:
                        _save_job(job_id, job)
                except Exception as e:
                    logger.debug("seg_hashes update skipped for %s: %s", seg_id, e)

                if rvc_is_enabled():
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

        sr = _model.sampling_rate
        total_samples = int(job["duration"] * sr)
        full_audio = torch.zeros(1, total_samples)

        slot_fit = (req.slot_fit or "time_stretch").lower()
        for i, (start, end, wav, _) in enumerate(all_segment_wavs):
            s = int(start * sr)
            seg_ref = req.segments[i] if i < len(req.segments) else None
            seg_gain = getattr(seg_ref, "gain", None) if seg_ref is not None else None
            seg_gain = seg_gain if seg_gain is not None else 1.0
            seg_gain = max(0.0, min(2.0, seg_gain))
            adjusted = wav * seg_gain

            # Slot-fit: keep each seg from bleeding into the next. "time_stretch"
            # resamples to the slot via linear interpolation (slight pitch lift
            # on compression, negligible at ≤1.15×, audible at ≥1.3×). "trim"
            # hard-clips + fade-out. "off" is the legacy overlap behaviour.
            slot_samples = int(max(0.0, (end - start)) * sr)
            wl = adjusted.shape[-1]
            if slot_fit != "off" and slot_samples > 0 and wl > slot_samples:
                if slot_fit == "time_stretch":
                    try:
                        # Shape: (1, wl) → interpolate(..., size=slot_samples) → (1, slot_samples)
                        adjusted = torch.nn.functional.interpolate(
                            adjusted.unsqueeze(0),
                            size=slot_samples,
                            mode='linear',
                            align_corners=False,
                        ).squeeze(0)
                    except Exception as e:
                        logger.warning("time_stretch failed for seg %d, falling back to trim: %s", i, e)
                        adjusted = adjusted[..., :slot_samples]
                else:  # "trim"
                    adjusted = adjusted[..., :slot_samples]
                wl = adjusted.shape[-1]

            fade_ms = 15
            fade_samples = int((fade_ms / 1000.0) * sr)
            if wl > fade_samples * 2:
                ramp_up = torch.linspace(0, 1, fade_samples, device=adjusted.device)
                ramp_down = torch.linspace(1, 0, fade_samples, device=adjusted.device)
                adjusted[0, :fade_samples] *= ramp_up
                adjusted[0, -fade_samples:] *= ramp_down

            e = min(s + wl, total_samples)
            full_audio[:, s:e] += adjusted[:, :e - s]

        lang_code = req.language_code or "und"
        track_path = os.path.join(DUB_DIR, job_id, f"dubbed_{lang_code}.wav")
        _t_save_0 = time.perf_counter()
        torchaudio.save(track_path, full_audio, sr)
        _t_save = time.perf_counter() - _t_save_0
        _t_mix = _t_save_0 - _t_loop_end
        job["dubbed_tracks"][lang_code] = {
            "path": track_path,
            "language": req.language,
            "language_code": lang_code,
        }

        job["language"] = req.language
        job["language_code"] = lang_code
        _save_job(job_id, job)

        _t_total = time.perf_counter() - _t_start
        if regen_only is not None:
            logger.info(
                "bench[incremental] total=%.2fs cache=%.2fs tts=%.2fs mix=%.2fs save=%.2fs segs=%d regen=%d",
                _t_total, _t_cache, _t_tts, _t_mix, _t_save, total, len(regen_only),
            )

        yield f"data: {json.dumps({'type': 'done', 'segments_processed': total, 'language_code': lang_code, 'tracks': list(job['dubbed_tracks'].keys()), 'sync_scores': sync_scores, 'seg_hashes': job.get('seg_hashes', {}), 'seg_num_step': job.get('seg_num_step', {})})}\n\n"

    task_id = f"dub_{job_id}_{int(time.time())}"
    await task_manager.add_task(task_id, "dub_generate", _stream, task_id)
    return {"task_id": task_id}
