import os
import json
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
from api.routers.dub_core import _get_job, _save_job

router = APIRouter()

@router.post("/dub/generate/{job_id}")
async def dub_generate(job_id: str, req: DubRequest):
    """Adds a dub generation job to the async batch task pool."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    _model = await get_model()

    async def _stream(task_id):
        total = len(req.segments)
        all_segment_wavs = []
        sync_scores = []

        for i, seg in enumerate(req.segments):
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

            def _gen(text, lang, instruct_str, dur_s, nstep, cfg, spd, profile_id=None):
                ref_audio = None
                ref_text = None
                used_seed = None

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
                    raise RuntimeError(f"Engine VRAM crash on segment: {str(e)}")

            seg_instruct = seg.instruct or req.instruct
            seg_profile = seg.profile_id or None
            seg_speed = seg.speed if hasattr(seg, 'speed') and seg.speed is not None else req.speed
            seg_lang = seg.target_lang if getattr(seg, 'target_lang', None) else req.language

            loop = asyncio.get_event_loop()
            try:
                audio_tensor = await loop.run_in_executor(
                    _gpu_pool, _gen,
                    seg.text, seg_lang, seg_instruct, seg_duration,
                    req.num_step, req.guidance_scale, seg_speed, seg_profile,
                )

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
                all_segment_wavs.append((seg.start, seg.end, audio_tensor, _model.sampling_rate))
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'segment': i, 'error': str(e)})}\n\n"
                sr = _model.sampling_rate
                all_segment_wavs.append((seg.start, seg.end, torch.zeros(1, int(seg_duration * sr)), sr))
                sync_scores.append(1.0)

        yield f"data: {json.dumps({'type': 'assembling'})}\n\n"

        sr = _model.sampling_rate
        total_samples = int(job["duration"] * sr)
        full_audio = torch.zeros(1, total_samples)

        for i, (start, end, wav, _) in enumerate(all_segment_wavs):
            s = int(start * sr)
            seg_ref = req.segments[i] if i < len(req.segments) else None
            seg_gain = getattr(seg_ref, "gain", None) if seg_ref is not None else None
            seg_gain = seg_gain if seg_gain is not None else 1.0
            seg_gain = max(0.0, min(2.0, seg_gain))
            adjusted = wav * seg_gain
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
        torchaudio.save(track_path, full_audio, sr)
        job["dubbed_tracks"][lang_code] = {
            "path": track_path,
            "language": req.language,
            "language_code": lang_code,
        }

        job["language"] = req.language
        job["language_code"] = lang_code
        _save_job(job_id, job)

        yield f"data: {json.dumps({'type': 'done', 'segments_processed': total, 'language_code': lang_code, 'tracks': list(job['dubbed_tracks'].keys()), 'sync_scores': sync_scores})}\n\n"

    task_id = f"dub_{job_id}_{int(time.time())}"
    await task_manager.add_task(task_id, "dub_generate", _stream, task_id)
    return {"task_id": task_id}
