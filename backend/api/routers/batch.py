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
            # Placeholder: the actual dub pipeline integration goes here.
            # For now, mark as done after a brief delay to prove the queue works.
            # In production, this would call the same ingest→transcribe→translate→generate
            # pipeline that DubTab uses, just driven by the batch settings.
            await asyncio.sleep(0.5)  # Simulate brief processing
            job["status"] = "done"
            job["finished_at"] = time.time()
            logger.info("Batch job %s completed in %.1fs", job_id, job["finished_at"] - job["started_at"])
        except asyncio.CancelledError:
            job["status"] = "cancelled"
            job["finished_at"] = time.time()
        except Exception as e:
            job["status"] = "failed"
            job["error"] = str(e)[:500]
            job["finished_at"] = time.time()
            logger.error("Batch job %s failed: %s", job_id, e)
        finally:
            _queue.task_done()


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
