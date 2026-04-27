import os
import uuid
import time
import shutil
import subprocess
import platform
from fastapi import APIRouter, HTTPException

from core.db import get_db
from core.config import OUTPUTS_DIR
from core import event_bus
from schemas.requests import ExportRequest, ExportRecordRequest, RevealRequest

router = APIRouter()


def _safe_destination(raw: str) -> str:
    """Resolve + validate an export destination. Rejects relative/empty paths."""
    if not raw or not raw.strip():
        raise HTTPException(
            status_code=400,
            detail="Export needs a destination folder. Pick where the file should go and try again.",
        )
    dest = os.path.realpath(os.path.expanduser(raw))
    if not os.path.isabs(dest):
        raise HTTPException(
            status_code=400,
            detail="The destination needs to be a full path (e.g. /Users/you/Movies/OmniVoice) — not relative.",
        )
    parent = os.path.dirname(dest)
    if not parent or not os.path.isdir(parent):
        raise HTTPException(
            status_code=400,
            detail="That destination folder doesn't exist yet. Create it first, or pick an existing one.",
        )
    return dest


def _safe_source(filename: str) -> str:
    """Resolve a source filename against OUTPUTS_DIR / dub outputs, blocking traversal."""
    base = os.path.basename(filename or "")
    if not base or base != filename:
        raise HTTPException(
            status_code=400,
            detail="The file to export has an unexpected name. Try re-generating the audio and exporting again.",
        )
    for root in (OUTPUTS_DIR, os.path.join("dub", "outputs")):
        candidate = os.path.realpath(os.path.join(root, base))
        root_real = os.path.realpath(root)
        if candidate.startswith(root_real + os.sep) and os.path.exists(candidate):
            return candidate
    raise HTTPException(
        status_code=404,
        detail="That file isn't on disk anymore — it may have been cleaned up. Regenerate and try again.",
    )


@router.post("/export")
def export_file(req: ExportRequest):
    src = _safe_source(req.source_filename)
    dest = _safe_destination(req.destination_path)
    try:
        # Video exports: overlay OmniVoice logo if visible watermark is enabled
        if src.lower().endswith(".mp4"):
            from services.watermark import is_visible_video_enabled, get_ffmpeg_overlay_args
            logo_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "docs", "logo.png")
            logo_path = os.path.realpath(logo_path)
            if is_visible_video_enabled() and os.path.exists(logo_path):
                overlay_args = get_ffmpeg_overlay_args(logo_path)
                if overlay_args:
                    try:
                        subprocess.run(
                            ["ffmpeg", "-y", "-i", src, "-i", logo_path]
                            + overlay_args
                            + ["-codec:a", "copy", dest],
                            check=True,
                            capture_output=True,
                            timeout=120,
                        )
                    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
                        # Fallback: plain copy if ffmpeg overlay fails
                        shutil.copy2(src, dest)
                else:
                    shutil.copy2(src, dest)
            else:
                shutil.copy2(src, dest)
        else:
            shutil.copy2(src, dest)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))

    export_id = str(uuid.uuid4())[:8]
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO export_history (id, filename, destination_path, mode, created_at) VALUES (?, ?, ?, ?, ?)",
            (export_id, req.source_filename, dest, req.mode, time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    event_bus.emit("export_history", {"action": "exported", "id": export_id})
    return {"success": True, "id": export_id}


@router.post("/export/record")
def record_export(req: ExportRecordRequest):
    export_id = str(uuid.uuid4())[:8]
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO export_history (id, filename, destination_path, mode, created_at) VALUES (?, ?, ?, ?, ?)",
            (export_id, req.filename, req.destination_path, req.mode, time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    event_bus.emit("export_history", {"action": "recorded", "id": export_id})
    return {"success": True, "id": export_id}


@router.get("/export/history")
def get_export_history():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM export_history ORDER BY created_at DESC LIMIT 50").fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@router.post("/export/reveal")
def reveal_in_folder(req: RevealRequest):
    # Tauri/native dialog-provided path; subprocess uses list args (no shell interpolation).
    if not req.path or not req.path.strip():
        raise HTTPException(
            status_code=400,
            detail="No path was provided — nothing to reveal.",
        )
    target = os.path.realpath(os.path.expanduser(req.path))
    if not os.path.exists(target):
        raise HTTPException(
            status_code=404,
            detail="That file or folder is no longer on disk. It may have been moved or deleted.",
        )

    folder = target if os.path.isdir(target) else os.path.dirname(target)
    system = platform.system()
    try:
        if system == "Darwin":
            if os.path.isfile(target):
                subprocess.Popen(["open", "-R", target])
            else:
                subprocess.Popen(["open", folder])
        elif system == "Windows":
            if os.path.isfile(target):
                subprocess.Popen(["explorer", "/select,", target.replace("/", "\\")])
            else:
                subprocess.Popen(["explorer", folder.replace("/", "\\")])
        else:
            subprocess.Popen(["xdg-open", folder])
        return {"success": True}
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
