"""Batch dubbing queue — POST videos with settings, process sequentially.

This is a lightweight batch orchestrator. Each job is a dub project that
runs through the same ingest→transcribe→translate→generate pipeline as
a manual dub, but driven by the queue instead of the UI.

The queue is in-memory (lives for the process lifetime). Jobs persist to
the SQLite `jobs` table for history, but the queue itself restarts empty
on backend restart — intentional, since GPU jobs can't be safely resumed.
"""
import os
import uuid
import time
import asyncio
import logging
from typing import Optional, List

from fastapi import APIRouter, File, UploadFile, HTTPException, Form
from pydantic import BaseModel

from core.config import DATA_DIR

router = APIRouter()
logger = logging.getLogger("omnivoice.batch")

# ── In-memory queue ─────────────────────────────────────────────────────

_queue: asyncio.Queue = None       # Lazily initialised
_worker_task: asyncio.Task = None  # Background consumer
_jobs: dict = {}                   # job_id → status dict


class BatchJobStatus(BaseModel):
    id: str
    status: str  # "queued" | "running" | "done" | "failed" | "cancelled"
    filename: str
    langs: List[str]
    voice_id: Optional[str] = None
    preserve_bg: bool = True
    created_at: float
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    error: Optional[str] = None
    progress: Optional[dict] = None


def _ensure_queue():
    """Lazy-init the asyncio queue + worker on first use."""
    global _queue, _worker_task
    if _queue is None:
        _queue = asyncio.Queue()
        _worker_task = asyncio.ensure_future(_worker())


async def _worker():
    """Process jobs one at a time from the queue."""
    while True:
        job_id = await _queue.get()
        job = _jobs.get(job_id)
        if not job or job["status"] == "cancelled":
            _queue.task_done()
            continue

        job["status"] = "running"
        job["started_at"] = time.time()
        logger.info("Batch job %s starting: %s", job_id, job["filename"])

        try:
            await _run_batch_pipeline(job_id, job)
            if job["status"] != "cancelled":
                job["status"] = "done"
                job["finished_at"] = time.time()
                logger.info(
                    "Batch job %s completed in %.1fs",
                    job_id, job["finished_at"] - job["started_at"],
                )
        except asyncio.CancelledError:
            job["status"] = "cancelled"
            job["finished_at"] = time.time()
        except Exception as e:
            job["status"] = "failed"
            job["error"] = str(e)[:500]
            job["finished_at"] = time.time()
            logger.error("Batch job %s failed: %s", job_id, e, exc_info=True)
        finally:
            _queue.task_done()


def _set_progress(job, stage, percent=0, **extra):
    """Update a job's progress dict."""
    job["progress"] = {"stage": stage, "percent": percent, **extra}


async def _run_batch_pipeline(job_id: str, job: dict):
    """Full batch dub pipeline: extract → transcribe → translate → generate → mix → export."""
    import subprocess
    import tempfile
    import soundfile as sf

    loop = asyncio.get_event_loop()
    video_path = job["video_path"]
    langs = job["langs"]
    batch_dir = os.path.join(DATA_DIR, "batch", job_id)
    os.makedirs(batch_dir, exist_ok=True)

    # ── 1. Extract audio ──────────────────────────────────────────────
    _set_progress(job, "extract", 0)
    audio_path = os.path.join(batch_dir, "audio.wav")

    from services.ffmpeg_utils import find_ffmpeg
    ffmpeg = find_ffmpeg()

    def _extract():
        subprocess.run(
            [ffmpeg, "-y", "-i", video_path,
             "-vn", "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1",
             audio_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=300, check=True,
        )
        # Get duration
        result = subprocess.run(
            [ffmpeg, "-i", audio_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30,
        )
        import re
        match = re.search(r"Duration: (\d+):(\d+):(\d+)\.(\d+)", result.stderr.decode("utf-8", errors="replace"))
        if match:
            h, m, s, cs = match.groups()
            return int(h) * 3600 + int(m) * 60 + int(s) + int(cs) / 100
        return 0.0

    duration = await loop.run_in_executor(None, _extract)
    job["duration"] = duration
    _set_progress(job, "extract", 100)

    if job["status"] == "cancelled":
        return

    # ── 2. Transcribe ─────────────────────────────────────────────────
    _set_progress(job, "transcribe", 0)

    from services.asr_backend import get_active_asr_backend
    from services.model_manager import _gpu_pool, _cpu_pool
    from services.segmentation import (
        segment_transcript, assign_speakers_heuristic,
    )

    def _transcribe():
        backend = get_active_asr_backend()
        result = backend.transcribe(audio_path, word_timestamps=True)
        detected_lang = result.get("language", "en")
        segments = segment_transcript(result, duration=duration)
        segments = assign_speakers_heuristic(segments)
        for i, s in enumerate(segments):
            s["id"] = f"s{i:05x}"
            s.setdefault("text_original", s.get("text", ""))
        try:
            backend.unload()
        except Exception:
            pass
        return segments, detected_lang

    segments, source_lang = await loop.run_in_executor(_gpu_pool, _transcribe)
    source_lang = (source_lang or "en").split("_")[0][:2].lower()
    job["segments"] = segments
    job["source_lang"] = source_lang
    _set_progress(job, "transcribe", 100, segments_count=len(segments))

    if job["status"] == "cancelled" or not segments:
        if not segments:
            job["error"] = "Transcription produced no segments"
            job["status"] = "failed"
        return

    # ── 3. Translate + Generate per language ───────────────────────────
    total_langs = len(langs)
    outputs = {}

    for lang_idx, target_lang in enumerate(langs):
        if job["status"] == "cancelled":
            return

        # ── 3a. Translate ─────────────────────────────────────────────
        _set_progress(
            job, "translate",
            percent=int((lang_idx / total_langs) * 100),
            current_lang=target_lang,
        )

        translated_segments = list(segments)  # copy
        if target_lang != source_lang:
            try:
                def _translate_batch(segs, src, tgt):
                    """Translate segment texts via Google Translate."""
                    from deep_translator import GoogleTranslator
                    TRANSLATE_CODES = {
                        "en": "en", "es": "es", "fr": "fr", "de": "de",
                        "it": "it", "pt": "pt", "ru": "ru", "ja": "ja",
                        "ko": "ko", "zh": "zh-CN", "ar": "ar", "hi": "hi",
                        "tr": "tr", "pl": "pl", "nl": "nl", "sv": "sv",
                    }
                    src_code = TRANSLATE_CODES.get(src, src) or "auto"
                    tgt_code = TRANSLATE_CODES.get(tgt, tgt)
                    translator = GoogleTranslator(source=src_code, target=tgt_code)
                    out = []
                    for s in segs:
                        s_copy = dict(s)
                        text = s.get("text", "").strip()
                        if text:
                            try:
                                s_copy["text"] = translator.translate(text) or text
                            except Exception as e:
                                logger.warning("Translate seg failed: %s", e)
                        out.append(s_copy)
                    return out

                translated_segments = await loop.run_in_executor(
                    _cpu_pool, _translate_batch,
                    segments, source_lang, target_lang,
                )
            except ImportError:
                logger.warning("deep_translator not installed, skipping translation for %s", target_lang)
            except Exception as e:
                logger.warning("Translation failed for %s: %s, using original", target_lang, e)
                translated_segments = segments

        if job["status"] == "cancelled":
            return

        # ── 3b. Generate TTS ──────────────────────────────────────────
        _set_progress(
            job, "generate",
            percent=int((lang_idx / total_langs) * 100),
            current_lang=target_lang,
            current_segment=0,
            total_segments=len(translated_segments),
        )

        from services.model_manager import get_model
        from services.audio_dsp import apply_mastering, normalize_audio
        import torch
        import torchaudio

        _model = await get_model()
        sr = _model.sampling_rate
        total_samples = int(duration * sr)
        full_audio = torch.zeros(1, total_samples)
        total_segs = len(translated_segments)

        for i, seg in enumerate(translated_segments):
            if job["status"] == "cancelled":
                return

            _set_progress(
                job, "generate",
                percent=int(((lang_idx + (i / total_segs)) / total_langs) * 100),
                current_lang=target_lang,
                current_segment=i + 1,
                total_segments=total_segs,
            )

            seg_start = seg.get("start", 0)
            seg_end = seg.get("end", 0)
            seg_duration = seg_end - seg_start
            seg_text = seg.get("text", "").strip()

            if seg_duration <= 0.05 or not seg_text:
                continue

            def _gen(text=seg_text, lang=target_lang, dur=seg_duration):
                ref_audio = None
                ref_text = None

                # Use voice_id if provided
                if job.get("voice_id"):
                    from core.db import get_db
                    from core.config import VOICES_DIR as _VD
                    conn = get_db()
                    try:
                        row = conn.execute(
                            "SELECT * FROM voice_profiles WHERE id=?",
                            (job["voice_id"],),
                        ).fetchone()
                    finally:
                        conn.close()
                    if row:
                        if row["is_locked"] and row["locked_audio_path"]:
                            ref_audio = os.path.join(_VD, row["locked_audio_path"])
                        elif row["ref_audio_path"]:
                            ref_audio = os.path.join(_VD, row["ref_audio_path"])
                        ref_text = row.get("ref_text")

                try:
                    audios = _model.generate(
                        text=text, language=lang,
                        ref_audio=ref_audio, ref_text=ref_text,
                        duration=dur, num_step=16,
                        guidance_scale=2.0, speed=1.0,
                        denoise=True, postprocess_output=True,
                    )
                    audio_out = audios[0]
                    mastered = apply_mastering(
                        audio_out,
                        sample_rate=sr,
                    )
                    return normalize_audio(mastered, target_dBFS=-2.0)
                except Exception as e:
                    logger.warning("TTS failed for seg %d (lang=%s): %s", i, lang, e)
                    return torch.zeros(1, int(dur * sr))

            try:
                audio_tensor = await loop.run_in_executor(_gpu_pool, _gen)

                # Fit to slot
                target_samples_seg = int(seg_duration * sr)
                current_samples = audio_tensor.shape[-1]
                if target_samples_seg > current_samples:
                    audio_tensor = torch.nn.functional.pad(
                        audio_tensor, (0, target_samples_seg - current_samples)
                    )
                elif current_samples > target_samples_seg:
                    audio_tensor = audio_tensor[..., :target_samples_seg]

                # Crossfade
                fade_samples = int(0.015 * sr)
                wl = audio_tensor.shape[-1]
                if wl > fade_samples * 2:
                    ramp_up = torch.linspace(0, 1, fade_samples)
                    ramp_down = torch.linspace(1, 0, fade_samples)
                    audio_tensor[0, :fade_samples] *= ramp_up
                    audio_tensor[0, -fade_samples:] *= ramp_down

                s_idx = int(seg_start * sr)
                e_idx = min(s_idx + wl, total_samples)
                full_audio[:, s_idx:e_idx] += audio_tensor[:, :e_idx - s_idx]

            except Exception as e:
                logger.warning("Batch TTS seg %d failed: %s", i, e)

        # ── 3c. Save dubbed audio track ───────────────────────────────
        track_path = os.path.join(batch_dir, f"dubbed_{target_lang}.wav")
        torchaudio.save(track_path, full_audio, sr)

        # ── 3d. Mix with original video ───────────────────────────────
        _set_progress(
            job, "mix",
            percent=int(((lang_idx + 0.8) / total_langs) * 100),
            current_lang=target_lang,
        )

        output_path = os.path.join(batch_dir, f"output_{target_lang}.mp4")

        def _mix(bg=job.get("preserve_bg", True)):
            if bg:
                # Mix dubbed audio with original background
                subprocess.run(
                    [ffmpeg, "-y",
                     "-i", video_path,
                     "-i", track_path,
                     "-filter_complex",
                     "[0:a]volume=0.15[bg];[1:a]volume=1.0[dub];[bg][dub]amix=inputs=2:duration=first[out]",
                     "-map", "0:v", "-map", "[out]",
                     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                     "-shortest", output_path],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=600, check=True,
                )
            else:
                # Replace audio entirely
                subprocess.run(
                    [ffmpeg, "-y",
                     "-i", video_path,
                     "-i", track_path,
                     "-map", "0:v", "-map", "1:a",
                     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                     "-shortest", output_path],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=600, check=True,
                )

        await loop.run_in_executor(None, _mix)
        outputs[target_lang] = output_path

    job["outputs"] = outputs
    _set_progress(job, "done", 100)


# ── Endpoints ───────────────────────────────────────────────────────────

@router.post("/batch/enqueue")
async def enqueue_batch_job(
    video: UploadFile = File(...),
    langs: str = Form("es"),            # comma-separated lang codes
    voice_id: Optional[str] = Form(None),
    preserve_bg: bool = Form(True),
):
    """Enqueue a video for batch dubbing.

    The video is saved to disk and a job is added to the queue.
    Returns the job ID for status polling.
    """
    _ensure_queue()

    job_id = str(uuid.uuid4())[:12]
    lang_list = [l.strip() for l in langs.split(",") if l.strip()]
    if not lang_list:
        raise HTTPException(400, "At least one target language is required")

    # Save the uploaded video
    batch_dir = os.path.join(DATA_DIR, "batch")
    os.makedirs(batch_dir, exist_ok=True)
    ext = os.path.splitext(video.filename or "video.mp4")[1] or ".mp4"
    video_path = os.path.join(batch_dir, f"{job_id}{ext}")

    with open(video_path, "wb") as f:
        content = await video.read()
        f.write(content)

    job = {
        "id": job_id,
        "status": "queued",
        "filename": video.filename or f"{job_id}{ext}",
        "video_path": video_path,
        "langs": lang_list,
        "voice_id": voice_id,
        "preserve_bg": preserve_bg,
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "error": None,
        "progress": None,
    }
    _jobs[job_id] = job
    await _queue.put(job_id)

    logger.info("Batch job %s enqueued: %s → %s", job_id, video.filename, lang_list)
    return {"job_id": job_id, "status": "queued", "queue_position": _queue.qsize()}


@router.get("/batch/jobs")
def list_batch_jobs(status: Optional[str] = None, limit: int = 50):
    """List batch jobs, optionally filtered by status."""
    jobs = list(_jobs.values())
    if status:
        if status == "active":
            jobs = [j for j in jobs if j["status"] in ("queued", "running")]
        else:
            jobs = [j for j in jobs if j["status"] == status]
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return jobs[:limit]


@router.get("/batch/jobs/{job_id}")
def get_batch_job(job_id: str):
    """Get the status of a specific batch job."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.post("/batch/jobs/{job_id}/cancel")
def cancel_batch_job(job_id: str):
    """Cancel a queued or running batch job."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] in ("done", "failed", "cancelled"):
        return {"already": job["status"]}
    job["status"] = "cancelled"
    job["finished_at"] = time.time()
    return {"cancelled": True}


@router.delete("/batch/jobs/{job_id}")
def delete_batch_job(job_id: str):
    """Delete a batch job record and its video file."""
    job = _jobs.pop(job_id, None)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("video_path") and os.path.exists(job["video_path"]):
        try:
            os.remove(job["video_path"])
        except Exception:
            pass
    return {"deleted": True}


@router.get("/batch/download/{job_id}/{lang}")
def download_batch_output(job_id: str, lang: str):
    """Download a completed batch job's output video for a given language."""
    from fastapi.responses import FileResponse

    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "done":
        raise HTTPException(400, f"Job is {job['status']}, not done")

    outputs = job.get("outputs", {})
    path = outputs.get(lang)
    if not path or not os.path.exists(path):
        raise HTTPException(404, f"No output for language '{lang}'")

    filename = f"{os.path.splitext(job['filename'])[0]}_{lang}.mp4"
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=filename,
    )
