import os
import uuid
import time
import shutil
import subprocess
import platform
from fastapi import APIRouter, HTTPException

from core.db import get_db
from core.config import OUTPUTS_DIR
from schemas.requests import ExportRequest, ExportRecordRequest, RevealRequest

router = APIRouter()


def _safe_destination(raw: str) -> str:
    """Resolve + validate an export destination. Rejects relative/empty paths."""
    if not raw or not raw.strip():
        raise HTTPException(status_code=400, detail="destination_path required")
    dest = os.path.realpath(os.path.expanduser(raw))
    if not os.path.isabs(dest):
        raise HTTPException(status_code=400, detail="destination_path must be absolute")
    parent = os.path.dirname(dest)
    if not parent or not os.path.isdir(parent):
        raise HTTPException(status_code=400, detail="destination directory does not exist")
    return dest


def _safe_source(filename: str) -> str:
    """Resolve a source filename against OUTPUTS_DIR / dub outputs, blocking traversal."""
    base = os.path.basename(filename or "")
    if not base or base != filename:
        raise HTTPException(status_code=400, detail="invalid source_filename")
    for root in (OUTPUTS_DIR, os.path.join("dub", "outputs")):
        candidate = os.path.realpath(os.path.join(root, base))
        root_real = os.path.realpath(root)
        if candidate.startswith(root_real + os.sep) and os.path.exists(candidate):
            return candidate
    raise HTTPException(status_code=404, detail="Source file not found")


@router.post("/export")
def export_file(req: ExportRequest):
    src = _safe_source(req.source_filename)
    dest = _safe_destination(req.destination_path)
    try:
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
        raise HTTPException(status_code=400, detail="path required")
    target = os.path.realpath(os.path.expanduser(req.path))
    if not os.path.exists(target):
        raise HTTPException(status_code=404, detail="path not found")

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
