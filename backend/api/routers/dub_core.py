import os
import io
import sys
import uuid
import json
import time
import hashlib
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
from schemas.requests import DubRequest, TranslateRequest, DubIngestUrlRequest
from services.model_manager import get_model, _gpu_pool, _cpu_pool, get_best_device, get_diarization_pipeline
from services.audio_dsp import apply_mastering, normalize_audio
from services.ffmpeg_utils import find_ffmpeg, _get_semaphore, _spawn_with_retry
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

_HASH_BUF_SIZE = 1 << 18  # 256 KB chunks for hashing


def _compute_file_hash(path: str) -> str:
    """SHA-256 digest of a file, streamed in 256 KB chunks."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(_HASH_BUF_SIZE)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _find_cached_job(content_hash: str, exclude_job_id: str) -> Optional[dict]:
    """Look up a previous job with the same content hash that has completed artifacts.

    Returns {job_dir, vocals_path, no_vocals_path, scene_cuts, thumb_path, duration}
    if a usable cache exists, else None.
    """
    if not content_hash:
        return None
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, job_data FROM dub_history WHERE content_hash=? AND id!=? ORDER BY created_at DESC LIMIT 5",
            (content_hash, exclude_job_id),
        ).fetchall()
    finally:
        conn.close()
    for row in rows:
        try:
            job = json.loads(row["job_data"])
        except (json.JSONDecodeError, TypeError):
            continue
        cached_dir = _safe_job_dir(row["id"])
        if not cached_dir or not os.path.isdir(cached_dir):
            continue
        # Check that the heavy artifacts actually exist on disk
        vocals = job.get("vocals_path") or os.path.join(cached_dir, "vocals.wav")
        if not os.path.isfile(vocals):
            continue
        return {
            "job_dir": cached_dir,
            "job_id": row["id"],
            "vocals_path": vocals,
            "no_vocals_path": job.get("no_vocals_path"),
            "scene_cuts": job.get("scene_cuts") or [],
            "thumb_path": job.get("thumb_path"),
            "duration": job.get("duration", 0.0),
        }
    return None


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

def _save_job(job_id: str, job: dict, filename: str = "", duration: float = 0.0, content_hash: str = ""):
    """Persist dub job state to SQLite so it survives restarts."""
    try:
        segments = job.get("segments") or []
        tracks = list((job.get("dubbed_tracks") or {}).keys())
        with db_conn() as conn:
            conn.execute(
                """INSERT INTO dub_history
                   (id, filename, duration, segments_count, language, language_code, tracks, job_data, content_hash, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     filename=excluded.filename,
                     duration=excluded.duration,
                     segments_count=excluded.segments_count,
                     tracks=excluded.tracks,
                     job_data=excluded.job_data,
                     content_hash=CASE WHEN excluded.content_hash != '' THEN excluded.content_hash ELSE dub_history.content_hash END""",
                (job_id, filename or job.get("filename", ""),
                 duration or job.get("duration", 0.0),
                 len(segments), job.get("language", ""), job.get("language_code", ""),
                 json.dumps(tracks), json.dumps(job, default=str), content_hash or "", time.time()),
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

def _run_proc_factory(job_id: str):
    """Return an async _run_proc helper bound to a job_id (for subprocess tracking)."""
    async def _run_proc(cmd, timeout: float = 900.0):
        async with _get_semaphore():
            p = await _spawn_with_retry(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
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
                    try:
                        await asyncio.wait_for(p.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        pass
                    raise HTTPException(status_code=504, detail=f"subprocess timed out after {timeout}s")
                return p, stdout, stderr
            finally:
                _unregister_proc(job_id, p)
                if p.returncode is None:
                    try:
                        p.kill()
                    except ProcessLookupError:
                        pass
                    try:
                        await asyncio.wait_for(p.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        pass
    return _run_proc


def _prep_event(event_type: str, **fields) -> str:
    payload = {"type": event_type, **fields}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _yt_download_sync(url: str, job_dir: str) -> tuple[str, str]:
    """Blocking yt-dlp download. Returns (video_path, title)."""
    import yt_dlp
    outtmpl = os.path.join(job_dir, "original.%(ext)s")
    ydl_opts = {
        "outtmpl": outtmpl,
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "socket_timeout": 30,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = ydl.prepare_filename(info)
        root, _ = os.path.splitext(path)
        mp4 = root + ".mp4"
        if os.path.exists(mp4):
            return mp4, info.get("title") or os.path.basename(mp4)
        return path, info.get("title") or os.path.basename(path)


async def _ingest_gen(job_id: str, job_dir: str, source: dict, filename_hint: Optional[str] = None):
    """Async generator: emit SSE events per processing stage.

    Stages: download_start, download_done, extract_start, extract_done, demucs_start,
    demucs_done, scene_start, scene_done, ready (terminal), error (terminal), cancelled.

    After extract_done the job is queryable via /dub/audio, /dub/media, /dub/thumb.
    After demucs_done, /dub/download and /dub/preview-video work with bg mix.
    """
    try:
        if source.get("kind") == "url":
            url = source["url"]
            yield _prep_event("download_start", url=url)
            try:
                video_path, title = await asyncio.to_thread(_yt_download_sync, url, job_dir)
            except Exception as e:
                yield _prep_event("error", stage="download", error=str(e)[:300])
                shutil.rmtree(job_dir, ignore_errors=True)
                return
            filename = title or os.path.basename(video_path)
            try:
                size = os.path.getsize(video_path)
            except OSError:
                size = 0
            yield _prep_event("download_done", title=title, size=size, filename=filename)
        else:
            video_path = source["path"]
            filename = filename_hint or os.path.basename(video_path)

        audio_path = os.path.join(job_dir, "audio.wav")
        ffmpeg = find_ffmpeg()
        _run_proc = _run_proc_factory(job_id)

        yield _prep_event("extract_start")
        try:
            p, _, stderr = await _run_proc([
                ffmpeg, "-i", video_path, "-vn", "-acodec", "pcm_s16le",
                "-ar", "16000", "-ac", "1", audio_path, "-y",
            ])
            if p.returncode != 0:
                raise Exception(stderr.decode(errors="replace")[:500])
        except asyncio.CancelledError:
            raise
        except Exception as e:
            yield _prep_event("error", stage="extract", error=str(e)[:300])
            return

        try:
            dur = float(sf.info(audio_path).frames) / float(sf.info(audio_path).samplerate)
        except Exception:
            dur = 0.0

        # ── Content-hash cache: skip demucs + scene if same file was processed before ──
        content_hash = await asyncio.to_thread(_compute_file_hash, audio_path)
        cached = _find_cached_job(content_hash, job_id)
        if cached:
            logger.info("Cache hit for job %s (hash %s) → reusing artifacts from %s", job_id, content_hash[:12], cached["job_id"])
            vocals_path = os.path.join(job_dir, "vocals.wav")
            no_vocals_path = os.path.join(job_dir, "no_vocals.wav")
            thumb_path = os.path.join(job_dir, "thumb.jpg")

            # Copy cached artifacts into this job's directory
            if cached["vocals_path"] and os.path.isfile(cached["vocals_path"]):
                shutil.copy2(cached["vocals_path"], vocals_path)
            else:
                vocals_path = audio_path  # fallback
            if cached["no_vocals_path"] and os.path.isfile(cached["no_vocals_path"]):
                shutil.copy2(cached["no_vocals_path"], no_vocals_path)
            else:
                no_vocals_path = None
            if cached["thumb_path"] and os.path.isfile(cached["thumb_path"]):
                shutil.copy2(cached["thumb_path"], thumb_path)
            else:
                thumb_path = None

            scene_cuts = cached["scene_cuts"] or []

            full_job = {
                "video_path": video_path,
                "audio_path": audio_path,
                "vocals_path": vocals_path,
                "no_vocals_path": no_vocals_path,
                "thumb_path": thumb_path if thumb_path and os.path.exists(thumb_path) else None,
                "duration": dur,
                "filename": filename,
                "segments": None,
                "dubbed_tracks": {},
                "scene_cuts": scene_cuts,
            }
            _dub_jobs[job_id] = full_job
            _save_job(job_id, full_job, filename, dur, content_hash)
            yield _prep_event("extract_done", job_id=job_id, duration=round(dur, 2), filename=filename)
            yield _prep_event("cached", has_bg=bool(no_vocals_path and os.path.exists(no_vocals_path)),
                              scene_count=len(scene_cuts))
            yield _prep_event("ready", job_id=job_id, duration=round(dur, 2), filename=filename)

        else:
            # ── Full pipeline: extract → demucs → scene → thumbnail ──

            # Persist partial job so media/audio endpoints resolve even before Demucs finishes.
            partial = {
                "video_path": video_path,
                "audio_path": audio_path,
                "vocals_path": audio_path,  # fallback until demucs completes
                "no_vocals_path": None,
                "thumb_path": None,
                "duration": dur,
                "filename": filename,
                "segments": None,
                "dubbed_tracks": {},
                "scene_cuts": [],
            }
            _dub_jobs[job_id] = partial
            _save_job(job_id, partial, filename, dur, content_hash)
            yield _prep_event("extract_done", job_id=job_id, duration=round(dur, 2), filename=filename)

            vocals_path = os.path.join(job_dir, "vocals.wav")
            no_vocals_path = os.path.join(job_dir, "no_vocals.wav")
            scene_cuts: list = []

            yield _prep_event("demucs_start")
            try:
                demucs_cmd = [sys.executable, "-m", "demucs.separate",
                              "--two-stems", "vocals", "-n", "htdemucs", "-d", get_best_device(),
                              audio_path, "-o", job_dir]
                p, _, stderr = await _run_proc(demucs_cmd, timeout=1800.0)
                if p.returncode != 0:
                    raise Exception(stderr.decode(errors="replace")[:500])
                demucs_out = os.path.join(job_dir, "htdemucs", "audio")
                if os.path.exists(os.path.join(demucs_out, "vocals.wav")):
                    shutil.move(os.path.join(demucs_out, "vocals.wav"), vocals_path)
                    shutil.move(os.path.join(demucs_out, "no_vocals.wav"), no_vocals_path)
                    shutil.rmtree(os.path.join(job_dir, "htdemucs"), ignore_errors=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Demucs failed for %s, falling back to mixed audio: %s", job_id, e)
                vocals_path = audio_path
                no_vocals_path = None
            yield _prep_event("demucs_done", has_bg=bool(no_vocals_path and os.path.exists(no_vocals_path)))

            yield _prep_event("scene_start")
            try:
                p, _, stderr_scene = await _run_proc([
                    ffmpeg, "-i", video_path, "-filter:v",
                    "select='gt(scene,0.3)',showinfo", "-f", "null", "-",
                ], timeout=600.0)
                import re
                matches = re.finditer(r"pts_time:([\d\.]+)", stderr_scene.decode(errors="replace"))
                scene_cuts = [float(m.group(1)) for m in matches]
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Scene detection failed for %s: %s", job_id, e)
            yield _prep_event("scene_done", count=len(scene_cuts))

            thumb_path = os.path.join(job_dir, "thumb.jpg")
            offset = max(0.5, min(1.5, dur * 0.1)) if dur else 1.0
            try:
                await _run_proc([
                    ffmpeg, "-y", "-ss", f"{offset:.2f}", "-i", video_path,
                    "-vframes", "1", "-vf", "scale=320:-2",
                    "-q:v", "4", thumb_path,
                ], timeout=30.0)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Thumbnail extraction failed for %s: %s", job_id, e)

            _dub_jobs[job_id].update({
                "vocals_path": vocals_path,
                "no_vocals_path": no_vocals_path,
                "thumb_path": thumb_path if os.path.exists(thumb_path) else None,
                "scene_cuts": scene_cuts,
            })
            _save_job(job_id, _dub_jobs[job_id], filename, dur, content_hash)
            yield _prep_event("ready", job_id=job_id, duration=round(dur, 2), filename=filename)

    except asyncio.CancelledError:
        logger.info("Dub prep cancelled for job %s; killing subprocesses and cleaning up", job_id)
        _kill_job_procs(job_id)
        try:
            shutil.rmtree(job_dir, ignore_errors=True)
        finally:
            _dub_jobs.pop(job_id, None)
        yield _prep_event("cancelled")
        raise
    finally:
        with _active_procs_lock:
            _active_procs.pop(job_id, None)


@router.post("/dub/upload")
async def dub_upload(video: UploadFile = File(...), job_id: Optional[str] = Form(None)):
    """Accept video upload, write to disk, queue background prep task.

    Returns 202 with {job_id, task_id, filename}. Client should open SSE on
    /tasks/stream/{task_id} to monitor extract/demucs/scene stages and wait for
    the 'ready' event before starting transcription.
    """
    job_id = job_id or str(uuid.uuid4())[:8]
    job_dir = _safe_job_dir(job_id)
    if job_dir is None:
        raise HTTPException(status_code=400, detail="invalid job_id")
    os.makedirs(job_dir, exist_ok=True)

    ext = os.path.splitext(video.filename or "video.mp4")[1]
    video_path = os.path.join(job_dir, f"original{ext}")
    with open(video_path, "wb") as f:
        f.write(await video.read())

    filename = video.filename or f"video{ext}"
    task_id = f"prep_{job_id}"
    await task_manager.add_task(
        task_id, "prep",
        _ingest_gen, job_id, job_dir,
        {"kind": "file", "path": video_path}, filename,
    )
    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "task_id": task_id, "filename": filename},
    )


@router.post("/dub/ingest-url")
async def dub_ingest_url(req: DubIngestUrlRequest):
    """Ingest a remote video URL via yt-dlp. Queues background prep task.

    Returns 202 immediately with {job_id, task_id}. All work (download,
    audio extract, Demucs, scene detect, thumbnail) happens in the background
    task and progress is streamed via /tasks/stream/{task_id}.
    """
    url = (req.url or "").strip()
    if not url or not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="invalid url")

    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        raise HTTPException(status_code=500, detail="yt-dlp not installed")

    job_id = req.job_id or str(uuid.uuid4())[:8]
    job_dir = _safe_job_dir(job_id)
    if job_dir is None:
        raise HTTPException(status_code=400, detail="invalid job_id")
    os.makedirs(job_dir, exist_ok=True)

    task_id = f"prep_{job_id}"
    await task_manager.add_task(
        task_id, "prep",
        _ingest_gen, job_id, job_dir,
        {"kind": "url", "url": url}, None,
    )
    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "task_id": task_id, "filename": ""},
    )


TRANSCRIBE_CHUNK_S = float(os.environ.get("OMNIVOICE_TRANSCRIBE_CHUNK_S", "30.0"))


def _sse_event(event: str, payload) -> bytes:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


@router.get("/dub/transcribe-stream/{job_id}")
async def dub_transcribe_stream(job_id: str):
    """Stream per-chunk segments via SSE, then emit diarized final pass."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    _model = await get_model()
    if _model._asr_pipe is None:
        raise HTTPException(status_code=503, detail="ASR not loaded")

    asr_audio_target = job.get("vocals_path")
    if not asr_audio_target or not os.path.exists(asr_audio_target):
        asr_audio_target = job.get("audio_path")
    if not asr_audio_target or not os.path.exists(asr_audio_target):
        raise HTTPException(status_code=404, detail="No audio available for transcription")

    use_mlx = torch.backends.mps.is_available()
    asr_model = os.environ.get("ASR_MODEL", "mlx-community/whisper-large-v3-mlx")
    scene_cuts = job.get("scene_cuts") or []

    async def gen():
        import math
        import tempfile
        loop = asyncio.get_event_loop()

        def _load():
            audio_np, sr = sf.read(asr_audio_target, dtype="float32")
            if audio_np.ndim > 1:
                audio_np = audio_np.mean(axis=1)
            return audio_np, sr

        try:
            audio_np, sr = await loop.run_in_executor(_cpu_pool, _load)
        except Exception as e:
            yield _sse_event("error", {"detail": f"audio load failed: {e}"})
            return

        total = float(len(audio_np)) / float(sr) if sr else 0.0
        chunks_n = max(1, int(math.ceil(total / TRANSCRIBE_CHUNK_S))) if total > 0 else 1
        yield _sse_event("start", {"duration": total, "chunks": chunks_n, "chunk_s": TRANSCRIBE_CHUNK_S})

        all_segments: list[dict] = []
        detected_lang = None
        next_seg_id = 0

        for i in range(chunks_n):
            if job.get("aborted"):
                yield _sse_event("aborted", {})
                return
            t0 = i * TRANSCRIBE_CHUNK_S
            t1 = min(total, t0 + TRANSCRIBE_CHUNK_S)
            s_from = int(t0 * sr)
            s_to = int(t1 * sr)
            chunk_arr = audio_np[s_from:s_to]
            if len(chunk_arr) == 0:
                continue

            def _transcribe_chunk(arr=chunk_arr, offset=t0, local_sr=sr):
                try:
                    if use_mlx:
                        import mlx_whisper
                        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                        tmp.close()
                        try:
                            sf.write(tmp.name, arr, local_sr)
                            r = mlx_whisper.transcribe(
                                tmp.name, path_or_hf_repo=asr_model, word_timestamps=True,
                            )
                        finally:
                            try: os.remove(tmp.name)
                            except OSError: pass
                        shifted = []
                        for seg in r.get("segments", []) or []:
                            shifted.append({
                                "text": seg.get("text", ""),
                                "timestamp": (float(seg.get("start", 0.0)) + offset,
                                              float(seg.get("end", 0.0)) + offset),
                            })
                        return {"chunks": shifted, "language": r.get("language")}
                    else:
                        r = _model._asr_pipe(
                            {"array": arr, "sampling_rate": local_sr},
                            return_timestamps=True, chunk_length_s=15, batch_size=1,
                        )
                        shifted = []
                        for c in (r.get("chunks", []) if isinstance(r, dict) else []):
                            ts = c.get("timestamp", (0.0, 0.0)) or (0.0, 0.0)
                            a0 = (ts[0] if ts[0] is not None else 0.0) + offset
                            a1 = (ts[1] if ts[1] is not None else 0.0) + offset
                            shifted.append({"text": c.get("text", ""), "timestamp": (a0, a1)})
                        return {"chunks": shifted, "language": r.get("language") if isinstance(r, dict) else None}
                except Exception as e:
                    logger.exception("chunk transcribe failed")
                    return {"chunks": [], "language": None, "error": str(e)}

            part = await loop.run_in_executor(_gpu_pool, _transcribe_chunk)
            if detected_lang is None and part.get("language"):
                detected_lang = part["language"]
            chunk_segs = segment_transcript(part, duration=t1, scene_cuts=scene_cuts)
            chunk_segs = assign_speakers_heuristic(chunk_segs)
            for s in chunk_segs:
                s["id"] = f"s{next_seg_id:05x}"
                # Preserve pristine transcript so later translations can re-run from source
                # instead of compounding on previously-translated text.
                s["text_original"] = s.get("text", "")
                next_seg_id += 1
            all_segments.extend(chunk_segs)
            yield _sse_event("segments", {
                "chunk": i, "total_chunks": chunks_n,
                "segments": chunk_segs,
                "progress": (i + 1) / chunks_n,
                "error": part.get("error"),
            })

        if job.get("aborted"):
            yield _sse_event("aborted", {})
            return

        def _diarize():
            diar_pipe = get_diarization_pipeline()
            try:
                if diar_pipe:
                    diar = diar_pipe(asr_audio_target)
                    return assign_speakers_from_diarization(all_segments, diar)
            except Exception as e:
                logger.error(f"Diarization failed: {e}")
            return assign_speakers_heuristic(all_segments)

        final_segs = await loop.run_in_executor(_gpu_pool, _diarize)
        job["segments"] = final_segs
        job["source_lang"] = ((detected_lang or "en").split("_")[0][:2] or "en").lower()
        job["full_transcript"] = " ".join(s.get("text", "") for s in final_segs)
        _save_job(job_id, job)

        if torch.backends.mps.is_available():
            try: torch.mps.empty_cache()
            except Exception: pass

        yield _sse_event("final", {
            "segments": final_segs,
            "source_lang": job["source_lang"],
            "full_transcript": job["full_transcript"],
        })
        yield _sse_event("done", {})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


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

        for s in segments:
            s.setdefault("text_original", s.get("text", ""))
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
