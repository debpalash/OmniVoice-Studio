"""Model download and deletion endpoints.

Extracted from the monolithic ``setup.py``.

- ``GET  /setup/download-stream``  — SSE for HF tqdm progress
- ``POST /models/install``         — start background model download
- ``DELETE /models/{repo_id}``     — remove cached model from disk
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from utils import hf_progress
from .models import KNOWN_MODELS, invalidate_cache

logger = logging.getLogger("omnivoice.setup.download")
router = APIRouter()


# ── SSE Download Stream ───────────────────────────────────────────────────

def _safe_put(queue: asyncio.Queue, event) -> None:
    """Non-blocking enqueue — drop oldest on overflow rather than block."""
    try:
        queue.put_nowait(event)
    except asyncio.QueueFull:
        try:
            queue.get_nowait()
            queue.put_nowait(event)
        except Exception:
            pass


@router.get("/setup/download-stream")
async def setup_download_stream():
    """SSE: forward every HuggingFace download tqdm update as a JSON event."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    loop = asyncio.get_event_loop()

    def listener(event):
        try:
            loop.call_soon_threadsafe(_safe_put, queue, event)
        except RuntimeError:
            pass

    listener_id = hf_progress.register_listener(listener)

    async def gen():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            hf_progress.unregister_listener(listener_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ── Install ────────────────────────────────────────────────────────────────

class InstallModelRequest(BaseModel):
    repo_id: str


@router.post("/models/install")
async def install_model(req: InstallModelRequest):
    """Download one HF repo snapshot; progress goes through the shared
    ``/setup/download-stream`` SSE feed."""
    if req.repo_id not in [m["repo_id"] for m in KNOWN_MODELS]:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown model: {req.repo_id!r}. Known: "
                + ", ".join(m["repo_id"] for m in KNOWN_MODELS)
            ),
        )
    loop = asyncio.get_event_loop()

    def _do():
        token = hf_progress.current_repo_id.set(req.repo_id)
        hf_progress.emit({
            "repo_id": req.repo_id,
            "filename": req.repo_id,
            "downloaded": 0, "total": 0, "pct": 0.0,
            "phase": "install_start",
        })
        try:
            from huggingface_hub import snapshot_download
            from huggingface_hub.utils import (
                HfHubHTTPError,
                LocalEntryNotFoundError,
            )
            logger.info("model install starting: %s", req.repo_id)
            dl_kwargs: dict = {"repo_id": req.repo_id}
            if sys.platform == "win32":
                dl_kwargs["local_dir_use_symlinks"] = False

            _max_attempts = 5
            _attempt = 0
            while True:
                _attempt += 1
                try:
                    snapshot_download(**dl_kwargs)
                    break
                except (HfHubHTTPError, LocalEntryNotFoundError, OSError) as net_err:
                    if _attempt >= _max_attempts:
                        raise
                    _backoff = min(30, 2 ** _attempt)
                    logger.warning(
                        "model install %s: attempt %d/%d failed (%s); retry in %ds",
                        req.repo_id, _attempt, _max_attempts, net_err, _backoff,
                    )
                    hf_progress.emit({
                        "repo_id": req.repo_id,
                        "filename": req.repo_id,
                        "downloaded": 0, "total": 0, "pct": 0.0,
                        "phase": "install_retry",
                        "attempt": _attempt,
                        "error": str(net_err),
                    })
                    import time as _t
                    _t.sleep(_backoff)
            logger.info("model install done: %s", req.repo_id)
            hf_progress.emit({
                "repo_id": req.repo_id,
                "filename": req.repo_id,
                "downloaded": 0, "total": 0, "pct": 1.0,
                "phase": "install_done",
            })
            invalidate_cache()
        except Exception as e:
            logger.warning("model install failed for %s: %s", req.repo_id, e)
            hf_progress.emit({
                "repo_id": req.repo_id,
                "filename": req.repo_id,
                "downloaded": 0, "total": 0, "pct": 0.0,
                "phase": "install_error",
                "error": str(e),
            })
        finally:
            hf_progress.current_repo_id.reset(token)

    loop.create_task(asyncio.to_thread(_do))
    return {"status": "install_started", "repo_id": req.repo_id}


# ── Delete ─────────────────────────────────────────────────────────────────

@router.delete("/models/{repo_id:path}")
def delete_model(repo_id: str):
    """Remove every cached revision of a repo from the HF cache."""
    hf_progress.emit({
        "repo_id": repo_id,
        "filename": repo_id,
        "downloaded": 0, "total": 0, "pct": 0.0,
        "phase": "delete_start",
    })
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        commits = [
            rev.commit_hash
            for entry in info.repos if entry.repo_id == repo_id
            for rev in entry.revisions
        ]
        if not commits:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Model {repo_id!r} isn't installed. Nothing to delete — "
                    "run POST /models/install first if you want a fresh download."
                ),
            )
        strategy = info.delete_revisions(*commits)
        strategy.execute()
        hf_progress.emit({
            "repo_id": repo_id,
            "filename": repo_id,
            "downloaded": 0, "total": 0, "pct": 1.0,
            "phase": "delete_done",
            "freed_bytes": strategy.expected_freed_size,
        })
        invalidate_cache()
        return {
            "deleted": True,
            "repo_id": repo_id,
            "freed_bytes": strategy.expected_freed_size,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Could not delete {repo_id}: {e}. "
                "Close any process using the model (e.g. the app's main dub job) and retry."
            ),
        )
