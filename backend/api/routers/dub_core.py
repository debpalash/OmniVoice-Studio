import os
import io
import sys
import uuid
import json
import time
import asyncio
import logging
import shutil
import subprocess
import threading
import soundfile as sf
import torch
import torchaudio
from typing import Optional, List
from fastapi import APIRouter, File, Form, UploadFile, HTTPException, Query
from fastapi.responses import FileResponse, Response, StreamingResponse, JSONResponse

from core.db import get_db, db_conn
from core.config import DATA_DIR, DUB_DIR, PREVIEW_DIR, VOICES_DIR
from core.tasks import task_manager
from schemas.requests import DubRequest, TranslateRequest
from services.model_manager import get_model, _gpu_pool, _cpu_pool, get_best_device, get_diarization_pipeline
from services.audio_dsp import apply_mastering, normalize_audio
from services.ffmpeg_utils import find_ffmpeg
from services.segmentation import (
    segment_transcript,
    assign_speakers_from_diarization,
    assign_speakers_heuristic,
    clean_up_segments,
)

router = APIRouter()
logger = logging.getLogger("omnivoice.api")

_dub_jobs = {}
# Tracks live subprocesses per job so POST /dub/abort/{job_id} can terminate them.
_active_procs: dict[str, list] = {}
_active_procs_lock = threading.Lock()

_DUB_DIR_REAL = os.path.realpath(DUB_DIR)


def _safe_job_dir(job_id: str) -> Optional[str]:
    """Resolve a job directory under DUB_DIR, rejecting traversal."""
    if not job_id or "/" in job_id or "\\" in job_id or job_id in (".", ".."):
        return None
    candidate = os.path.realpath(os.path.join(DUB_DIR, job_id))
    if not candidate.startswith(_DUB_DIR_REAL + os.sep):
        return None
    return candidate


def _register_proc(job_id: str, proc):
    with _active_procs_lock:
        _active_procs.setdefault(job_id, []).append(proc)


def _unregister_proc(job_id: str, proc):
    with _active_procs_lock:
        lst = _active_procs.get(job_id)
        if lst and proc in lst:
            lst.remove(proc)
        if lst is not None and not lst:
            _active_procs.pop(job_id, None)


def _kill_job_procs(job_id: str):
    with _active_procs_lock:
        procs = list(_active_procs.get(job_id, []))
    for proc in procs:
        try:
            if proc.returncode is None:
                proc.kill()
        except ProcessLookupError:
            pass
        except Exception as e:
            logger.warning("Failed to kill subprocess for %s: %s", job_id, e)
    with _active_procs_lock:
        _active_procs.pop(job_id, None)

def _get_job(job_id: str):
    if job_id in _dub_jobs:
        return _dub_jobs[job_id]
    conn = get_db()
    try:
        row = conn.execute("SELECT job_data FROM dub_history WHERE id=?", (job_id,)).fetchone()
    finally:
        conn.close()
    if row and row["job_data"]:
        try:
            job = json.loads(row["job_data"])
            _dub_jobs[job_id] = job
            return job
        except json.JSONDecodeError as e:
            logger.error("Failed to decode dub_history.job_data for %s: %s", job_id, e)
    return None

def _save_job(job_id: str, job: dict, filename: str = "", duration: float = 0.0):
    """Persist dub job state to SQLite so it survives restarts."""
    try:
        segments = job.get("segments") or []
        tracks = list((job.get("dubbed_tracks") or {}).keys())
        with db_conn() as conn:
            conn.execute(
                """INSERT INTO dub_history
                   (id, filename, duration, segments_count, language, language_code, tracks, job_data, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     filename=excluded.filename,
                     duration=excluded.duration,
                     segments_count=excluded.segments_count,
                     tracks=excluded.tracks,
                     job_data=excluded.job_data""",
                (job_id, filename or job.get("filename", ""),
                 duration or job.get("duration", 0.0),
                 len(segments), job.get("language", ""), job.get("language_code", ""),
                 json.dumps(tracks), json.dumps(job, default=str), time.time()),
            )
    except Exception as e:
        logger.error("Failed to persist dub job %s: %s", job_id, e)

@router.post("/dub/cleanup-segments/{job_id}")
def dub_cleanup_segments(job_id: str):
    """Re-run merge/stitch passes on a job's existing segments to drop fragments."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    segments = job.get("segments") or []
    cleaned = clean_up_segments(segments)
    job["segments"] = cleaned
    _save_job(job_id, job)
    return {"segments": cleaned, "before": len(segments), "after": len(cleaned)}


@router.post("/dub/abort/{job_id}")
def dub_abort(job_id: str):
    """Cancel in-flight upload/transcribe subprocesses for a job."""
    with _active_procs_lock:
        had_procs = bool(_active_procs.get(job_id))
    _kill_job_procs(job_id)
    job = _dub_jobs.get(job_id)
    if job is not None:
        job["aborted"] = True
    try:
        task_manager.cancel_task(job_id)
    except Exception:
        pass
    return {"aborted": True, "had_active_procs": had_procs}


@router.get("/dub/history")
def list_dub_history():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM dub_history ORDER BY created_at DESC LIMIT 30").fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]

@router.delete("/dub/history")
def clear_dub_history():
    """Delete persisted dub rows and their on-disk dirs (scoped to known IDs)."""
    conn = get_db()
    try:
        ids = [r["id"] for r in conn.execute("SELECT id FROM dub_history").fetchall()]
        conn.execute("DELETE FROM dub_history")
        conn.commit()
    finally:
        conn.close()
    for jid in ids:
        safe = _safe_job_dir(jid)
        if safe and os.path.isdir(safe):
            shutil.rmtree(safe, ignore_errors=True)
    return {"cleared": True, "count": len(ids)}

@router.delete("/dub/history/{history_id}")
def delete_single_dub_history(history_id: str):
    with db_conn() as conn:
        conn.execute("DELETE FROM dub_history WHERE id=?", (history_id,))
    safe = _safe_job_dir(history_id)
    if safe and os.path.isdir(safe):
        shutil.rmtree(safe, ignore_errors=True)
    _dub_jobs.pop(history_id, None)
    return {"deleted": True}

@router.post("/preview/upload")
async def preview_upload(video: UploadFile = File(...)):
    ext = os.path.splitext(video.filename or "video.mp4")[1].lower()
    safe_name = f"{uuid.uuid4().hex[:12]}"
    vid_path = os.path.join(PREVIEW_DIR, f"{safe_name}{ext}")
    wav_path = os.path.join(PREVIEW_DIR, f"{safe_name}.wav")
    
    with open(vid_path, "wb") as f:
        f.write(await video.read())
        
    has_audio = False
    if ext not in [".wav", ".mp3", ".m4a", ".aac"]:
        try:
            ffmpeg_cmd = [
                find_ffmpeg(), "-y", "-i", vid_path,
                "-vn", "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1",
                wav_path
            ]
            subprocess.run(
                ffmpeg_cmd, check=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=300,
            )
            has_audio = True
        except Exception as e:
            logger.warning(f"FFmpeg extraction failed: {e}")
            pass

    return {
        "url": f"/preview/{safe_name}{ext}",
        "audioUrl": f"/preview/{safe_name}.wav" if has_audio else f"/preview/{safe_name}{ext}",
        "filename": video.filename,
    }

@router.get("/preview/{filename}")
async def preview_serve(filename: str):
    if not filename or "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(400, "Invalid preview filename")
    preview_real = os.path.realpath(PREVIEW_DIR)
    path = os.path.realpath(os.path.join(PREVIEW_DIR, filename))
    if not path.startswith(preview_real + os.sep):
        raise HTTPException(400, "Invalid preview filename")
    if not os.path.isfile(path):
        raise HTTPException(404, "Preview not found")
    ext = os.path.splitext(filename)[1].lower()
    media_types = {
        ".mp4": "video/mp4", ".mov": "video/quicktime", 
        ".mkv": "video/x-matroska", ".webm": "video/webm", 
        ".avi": "video/x-msvideo", ".wav": "audio/wav", 
        ".mp3": "audio/mpeg"
    }
    return FileResponse(path, media_type=media_types.get(ext, "application/octet-stream"))

@router.post("/dub/upload")
async def dub_upload(video: UploadFile = File(...), job_id: Optional[str] = Form(None)):
    job_id = job_id or str(uuid.uuid4())[:8]
    job_dir = _safe_job_dir(job_id)
    if job_dir is None:
        raise HTTPException(status_code=400, detail="invalid job_id")
    os.makedirs(job_dir, exist_ok=True)

    ext = os.path.splitext(video.filename or "video.mp4")[1]
    video_path = os.path.join(job_dir, f"original{ext}")
    with open(video_path, "wb") as f:
        f.write(await video.read())

    audio_path = os.path.join(job_dir, "audio.wav")
    ffmpeg = find_ffmpeg()

    async def _run_proc(cmd, timeout: float = 900.0):
        p = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _register_proc(job_id, p)
        try:
            try:
                stdout, stderr = await asyncio.wait_for(p.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                try:
                    p.kill()
                except ProcessLookupError:
                    pass
                raise HTTPException(status_code=504, detail=f"subprocess timed out after {timeout}s")
            return p, stdout, stderr
        finally:
            _unregister_proc(job_id, p)

    try:
        try:
            p, _, stderr = await _run_proc([
                ffmpeg, "-i", video_path, "-vn", "-acodec", "pcm_s16le",
                "-ar", "16000", "-ac", "1", audio_path, "-y",
            ])
            if p.returncode != 0:
                raise Exception(stderr.decode())
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"ffmpeg failed: {str(e)}")

        try:
            dur = float(sf.info(audio_path).frames) / float(sf.info(audio_path).samplerate)
        except Exception:
            dur = 0.0

        vocals_path = os.path.join(job_dir, "vocals.wav")
        no_vocals_path = os.path.join(job_dir, "no_vocals.wav")
        scene_cuts = []

        async def run_demucs():
            nonlocal vocals_path, no_vocals_path
            try:
                demucs_cmd = [sys.executable, "-m", "demucs.separate",
                              "--two-stems", "vocals", "-n", "htdemucs", "-d", get_best_device(),
                              audio_path, "-o", job_dir]
                p, _, stderr = await _run_proc(demucs_cmd, timeout=1800.0)
                if p.returncode != 0:
                    raise Exception(stderr.decode())

                demucs_out = os.path.join(job_dir, "htdemucs", "audio")
                if os.path.exists(os.path.join(demucs_out, "vocals.wav")):
                    shutil.move(os.path.join(demucs_out, "vocals.wav"), vocals_path)
                    shutil.move(os.path.join(demucs_out, "no_vocals.wav"), no_vocals_path)
                    shutil.rmtree(os.path.join(job_dir, "htdemucs"), ignore_errors=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Demucs failed, falling back to mixed audio. {e}")
                vocals_path = audio_path
                no_vocals_path = None

        async def run_scene_detection():
            nonlocal scene_cuts
            try:
                p, _, stderr_scene = await _run_proc([
                    ffmpeg, "-i", video_path, "-filter:v",
                    "select='gt(scene,0.3)',showinfo", "-f", "null", "-",
                ], timeout=600.0)
                import re
                matches = re.finditer(r"pts_time:([\d\.]+)", stderr_scene.decode())
                scene_cuts = [float(m.group(1)) for m in matches]
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Scene detection failed: {e}")

        await asyncio.gather(run_demucs(), run_scene_detection())

        _dub_jobs[job_id] = {
            "video_path": video_path,
            "audio_path": audio_path,
            "vocals_path": vocals_path,
            "no_vocals_path": no_vocals_path,
            "duration": dur, "filename": video.filename,
            "segments": None, "dubbed_tracks": {},
            "scene_cuts": scene_cuts,
        }
        _save_job(job_id, _dub_jobs[job_id], video.filename, dur)
        return {"job_id": job_id, "duration": round(dur, 2), "filename": video.filename}

    except asyncio.CancelledError:
        logger.info("Dub upload cancelled for job %s; killing subprocesses and cleaning up", job_id)
        _kill_job_procs(job_id)
        try:
            shutil.rmtree(job_dir, ignore_errors=True)
        finally:
            _dub_jobs.pop(job_id, None)
        raise
    finally:
        with _active_procs_lock:
            _active_procs.pop(job_id, None)


@router.post("/dub/transcribe/{job_id}")
async def dub_transcribe(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    _model = await get_model()
    if _model._asr_pipe is None:
        raise HTTPException(status_code=503, detail="ASR not loaded")

    def _transcribe():
        import re
        import traceback
        
        asr_audio_target = job.get("vocals_path")
        if not asr_audio_target or not os.path.exists(asr_audio_target):
            asr_audio_target = job.get("audio_path")
            
        import torch

        detected_lang = None

        if torch.backends.mps.is_available():
            try:
                import mlx_whisper
                asr_model = os.environ.get("ASR_MODEL", "mlx-community/whisper-large-v3-mlx")
                logger.info(f"Transcribing via MLX CoreML Engine ({asr_model})...")
                result = mlx_whisper.transcribe(
                    asr_audio_target,
                    path_or_hf_repo=asr_model,
                    word_timestamps=True
                )
                detected_lang = result.get("language")

                if "segments" in result:
                    result["chunks"] = []
                    for seg in result["segments"]:
                        result["chunks"].append({
                            "text": seg["text"],
                            "timestamp": (seg["start"], seg["end"])
                        })
            except Exception as e:
                logger.error(f"MLX Whisper failed, falling back to PyTorch: {e}")
                audio_np, sr = sf.read(asr_audio_target, dtype="float32")
                if audio_np.ndim > 1: audio_np = audio_np.mean(axis=1)
                bs = 16 if torch.cuda.is_available() else 2
                result = _model._asr_pipe({"array": audio_np, "sampling_rate": sr}, return_timestamps=True, chunk_length_s=15, batch_size=bs)
                detected_lang = (result.get("language") if isinstance(result, dict) else None)
        else:
            audio_np, sr = sf.read(asr_audio_target, dtype="float32")
            if audio_np.ndim > 1: audio_np = audio_np.mean(axis=1)
            bs = 16 if torch.cuda.is_available() else 1
            result = _model._asr_pipe({"array": audio_np, "sampling_rate": sr}, return_timestamps=True, chunk_length_s=15, batch_size=bs)
            detected_lang = (result.get("language") if isinstance(result, dict) else None)

        job["source_lang"] = (detected_lang or "en").split("_")[0][:2].lower()

        scene_cuts = job.get("scene_cuts") or []
        segments = segment_transcript(result, duration=job.get("duration", 0.0), scene_cuts=scene_cuts)

        diar_pipe = get_diarization_pipeline()
        if diar_pipe:
            try:
                diar_target = job.get("vocals_path") or job.get("audio_path")
                diarization = diar_pipe(diar_target)
                segments = assign_speakers_from_diarization(segments, diarization)
            except Exception as e:
                logger.error(f"Pyannote diarization failed during inference: {e}. Falling back to heuristic.")
                segments = assign_speakers_heuristic(segments)
        else:
            segments = assign_speakers_heuristic(segments)

        job["full_transcript"] = " ".join(s["text"] for s in segments)

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

        return segments

    try:
        loop = asyncio.get_event_loop()
        try:
            segments_result = await loop.run_in_executor(_gpu_pool, _transcribe)
        except asyncio.CancelledError:
            job["aborted"] = True
            raise
        if job.get("aborted"):
            raise HTTPException(status_code=499, detail="Transcription aborted")
        job["segments"] = segments_result
        source_lang = job.get("source_lang")
        _save_job(job_id, job)
        return {
            "job_id": job_id,
            "segments": segments_result,
            "full_transcript": job.get("full_transcript", ""),
            "source_lang": source_lang,
        }
    except HTTPException:
        raise
    except asyncio.CancelledError:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
