"""Longform Job Library (PR 7).

``GET /longform/jobs`` — list finished Audiobook + Story renders so the user can
re-download them from the Projects view. The render itself (the m4b/mp3) already
landed in ``OUTPUTS_DIR`` and is served at ``/audio/<output>``; here we just
recover, from each finished job's persisted SSE tail, the output filename plus
the chapter count and duration the ``done`` event carried.

Pure recovery, no synthesis. Defensive by construction: a job whose ``done``
event is missing or unparseable is skipped, never surfaced and never a 500.

The work lives in :func:`build_longform_library`, a pure function over the
job-store callables, so it's unit-testable without importing ``main`` (and the
torch graph behind it).
"""
from __future__ import annotations

import json
import logging
from typing import Callable, Optional

from fastapi import APIRouter, Query

logger = logging.getLogger("omnivoice.longform_jobs")
router = APIRouter()

#: Job types this library surfaces. Both flow through the shared longform
#: renderer (``_render_longform_sse``) and emit the same ``done`` event shape.
_LONGFORM_TYPES = ("audiobook", "story")


def _done_payload_from_events(events: list[dict]) -> Optional[dict]:
    """Recover the final ``{"type": "done", ...}`` payload from a job's SSE tail.

    Each row's ``payload`` is the JSON the renderer stored via
    ``job_store.append_event(job_id, json.dumps(payload))``. We scan newest-first
    and return the first parseable ``done`` event. Anything malformed is skipped
    — this never raises.
    """
    for ev in reversed(events):
        raw = ev.get("payload") if isinstance(ev, dict) else None
        if not raw or not isinstance(raw, str):
            continue
        try:
            obj = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict) and obj.get("type") == "done":
            return obj
    return None


def _coerce_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def build_longform_library(
    list_jobs: Callable[..., list[dict]],
    events_since: Callable[..., list[dict]],
    *,
    limit: int = 50,
) -> list[dict]:
    """Build the newest-first list of finished longform renders.

    Pure over the two job-store callables so tests can pass them directly:

    * ``list_jobs(status="done", limit=...)`` → all done jobs, newest-first.
    * ``events_since(job_id)`` → that job's persisted SSE events.

    Returns ``[{job_id, type, title?, output, duration_s, chapters,
    created_at}]``. Jobs that aren't a longform type, or whose ``done`` event /
    output filename can't be recovered, are silently skipped — the library only
    ever lists things the user can actually re-download.
    """
    limit = max(1, min(_coerce_int(limit, 50), 500))
    try:
        # Over-fetch: non-longform done jobs (dub, etc.) get filtered out below,
        # so ask for more rows than the caller's limit to still fill the page.
        rows = list_jobs(status="done", limit=limit * 4)
    except Exception:
        logger.warning("longform library: list_jobs failed", exc_info=True)
        return []

    out: list[dict] = []
    for row in rows or []:
        if len(out) >= limit:
            break
        try:
            job_type = row.get("type")
            job_id = row.get("id")
            if job_type not in _LONGFORM_TYPES or not job_id:
                continue
            try:
                events = events_since(job_id)
            except Exception:
                logger.warning("longform library: events_since failed for %s",
                               job_id, exc_info=True)
                continue
            done = _done_payload_from_events(events or [])
            if not done:
                continue
            output = done.get("output")
            if not output or not isinstance(output, str):
                continue  # nothing to re-download → not worth listing

            item = {
                "job_id": job_id,
                "type": job_type,
                "output": output,
                "duration_s": round(_coerce_float(done.get("duration_s")), 2),
                "chapters": _coerce_int(done.get("chapters")),
                "created_at": row.get("created_at"),
            }
            # Title is optional — prefer the done event, fall back to job meta.
            title = done.get("title")
            if not title:
                meta_raw = row.get("meta_json")
                if isinstance(meta_raw, str) and meta_raw:
                    try:
                        meta = json.loads(meta_raw)
                        if isinstance(meta, dict):
                            title = meta.get("title")
                    except (ValueError, TypeError):
                        title = None
            if title:
                item["title"] = title
            out.append(item)
        except Exception:
            # Per-row isolation: one bad row never sinks the whole list.
            logger.warning("longform library: skipping unparseable job row",
                           exc_info=True)
            continue
    return out


@router.get("/longform/jobs")
def longform_jobs(limit: int = Query(50, ge=1, le=500)) -> dict:
    """Finished Audiobook + Story renders, newest-first, ready to re-download.

    Each item's ``output`` is served at ``/audio/<output>``. Never 500s — on any
    backend hiccup it returns an empty list rather than an error.
    """
    from core import job_store

    jobs = build_longform_library(
        job_store.list_jobs, job_store.events_since, limit=limit,
    )
    return {"jobs": jobs}
