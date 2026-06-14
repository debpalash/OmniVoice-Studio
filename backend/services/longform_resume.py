"""Durable resume for longform (audiobook / story) renders.

Chapter WAVs are already content-addressed in a shared cache, so re-rendering an
identical plan reuses what finished — the synthesis-level resume. The missing
piece this module adds is **durability of the *plan itself***: a render that's
interrupted (crash, app quit, power loss) leaves a `resume.json` manifest in the
job's work dir holding the compiled plan + render params, so the job can be
resumed later *without the user still having the original script* — which matters
for Stories, whose plan is compiled from cast+lines and can't be retyped.

Pure file/JSON I/O (no torch, no model) so it's unit-testable. The router wires
it into the SSE renderer (write on start, clear on done) and exposes
``GET /audiobook/jobs`` (resumable) + ``POST /audiobook/resume/{job_id}``.
"""
from __future__ import annotations

import json
import os
from typing import Optional

MANIFEST_VERSION = 1
_MANIFEST_NAME = "resume.json"
# Longform front doors that produce a resumable work dir (job_type → dir prefix).
RESUMABLE_TYPES = ("audiobook", "story")


def work_dir(job_type: str, job_id: str) -> str:
    """The per-job work directory ``OUTPUTS_DIR/<job_type>_<job_id>``."""
    from core.config import OUTPUTS_DIR
    return os.path.join(OUTPUTS_DIR, f"{job_type}_{job_id}")


def manifest_path(job_type: str, job_id: str) -> str:
    return os.path.join(work_dir(job_type, job_id), _MANIFEST_NAME)


def build_manifest(
    *,
    job_id: str,
    job_type: str,
    plan_chapters: list[dict],
    params: dict,
    title: str = "",
) -> dict:
    """Assemble the manifest dict. ``plan_chapters`` is the canonical span-plan
    (``[{title, spans:[{voice_id,text,pause_ms_after,speed}]}]``); ``params`` is
    the render kwargs (default_voice / fmt / bitrate / loudness / cover_path /
    metadata / lexicon). Pure — no I/O."""
    return {
        "version": MANIFEST_VERSION,
        "job_id": job_id,
        "job_type": job_type,
        "title": title or "",
        "total_chapters": len(plan_chapters),
        "params": params,
        "plan": plan_chapters,
    }


def write_manifest(manifest: dict) -> Optional[str]:
    """Persist the manifest to the job work dir. Best-effort — resume is an
    enhancement, never block the render — returns the path or None on failure."""
    try:
        path = manifest_path(manifest["job_type"], manifest["job_id"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False)
        os.replace(tmp, path)  # atomic — a half-written manifest never resumes
        return path
    except OSError:
        return None


def read_manifest(job_type: str, job_id: str) -> Optional[dict]:
    """Load a job's resume manifest, or None if absent/unreadable/foreign-shape."""
    try:
        with open(manifest_path(job_type, job_id), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("version") != MANIFEST_VERSION:
        return None
    if not isinstance(data.get("plan"), list):
        return None
    return data


def clear_manifest(job_type: str, job_id: str) -> None:
    """Remove the manifest once a job completes (no resume needed). Best-effort."""
    try:
        os.remove(manifest_path(job_type, job_id))
    except OSError:
        pass


def has_manifest(job_type: str, job_id: str) -> bool:
    return os.path.isfile(manifest_path(job_type, job_id))
