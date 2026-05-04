"""
Voice Design Marketplace — v1.0.x voice profile sharing.

Export, import, and share custom voice profiles as portable `.omnivoice`
bundles. A bundle is a ZIP file containing:
  • metadata.json  — profile name, settings, engine, tags, creator info
  • ref_audio.wav  — reference audio clip
  • locked_audio.wav — locked/optimized audio (if locked)
  • thumbnail.jpg  — optional preview image

This enables:
  • Backup/restore of voice profiles across machines
  • Sharing voices via file transfer, Discord, forums
  • Future: P2P marketplace discovery (local network / IPFS)

Endpoints:
    POST /marketplace/export/{profile_id}  → download .omnivoice bundle
    POST /marketplace/import               → upload .omnivoice bundle → new profile
    GET  /marketplace/browse               → list importable bundles in local store
    POST /marketplace/publish/{profile_id} → save to local marketplace directory
"""
from __future__ import annotations

import io
import json
import logging
import os
import shutil
import time
import uuid
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from core.config import OUTPUTS_DIR, VOICES_DIR
from core.db import db_conn, get_db
from core import event_bus

logger = logging.getLogger("omnivoice.marketplace")

router = APIRouter(prefix="/marketplace", tags=["Voice Marketplace"])

# Local marketplace directory for published voices
MARKETPLACE_DIR = Path(OUTPUTS_DIR) / "marketplace"
MARKETPLACE_DIR.mkdir(parents=True, exist_ok=True)

# Bundle format version — increment if the schema changes
BUNDLE_VERSION = 1

# Maximum bundle upload size (100 MB) to prevent memory exhaustion
MAX_BUNDLE_BYTES = 100 * 1024 * 1024


# ── Export ──────────────────────────────────────────────────────────────────


@router.post("/export/{profile_id}")
def export_profile(profile_id: str):
    """Export a voice profile as a downloadable .omnivoice bundle (ZIP)."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM voice_profiles WHERE id = ?", (profile_id,)
        ).fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Voice profile not found")

    profile = dict(row)

    # Build the ZIP bundle in memory
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # Metadata
        metadata = {
            "bundle_version": BUNDLE_VERSION,
            "profile_name": profile.get("name", "Unnamed"),
            "ref_text": profile.get("ref_text", ""),
            "instruct": profile.get("instruct", ""),
            "language": profile.get("language", "Auto"),
            "personality": profile.get("personality", ""),
            "seed": profile.get("seed"),
            "is_locked": bool(profile.get("is_locked")),
            "created_at": profile.get("created_at"),
            "exported_at": time.time(),
            "omnivoice_version": "0.4.0",
        }
        zf.writestr("metadata.json", json.dumps(metadata, indent=2))

        # Reference audio
        ref_path = profile.get("ref_audio_path")
        if ref_path:
            full_ref = os.path.join(VOICES_DIR, ref_path)
            if os.path.isfile(full_ref):
                ext = os.path.splitext(ref_path)[1] or ".wav"
                zf.write(full_ref, f"ref_audio{ext}")

        # Locked audio (if profile is locked)
        locked_path = profile.get("locked_audio_path")
        if locked_path:
            full_locked = os.path.join(VOICES_DIR, locked_path)
            if os.path.isfile(full_locked):
                ext = os.path.splitext(locked_path)[1] or ".wav"
                zf.write(full_locked, f"locked_audio{ext}")

    buf.seek(0)
    safe_name = "".join(
        c if c.isalnum() or c in "-_ " else "" for c in profile.get("name", "voice")
    ).strip().replace(" ", "_")[:40]
    filename = f"{safe_name}.omnivoice"

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(buf.getbuffer().nbytes),
        },
    )


# ── Import ──────────────────────────────────────────────────────────────────


@router.post("/import")
async def import_profile(
    file: UploadFile = File(..., description="A .omnivoice bundle file"),
):
    """Import a voice profile from a .omnivoice bundle."""
    if not file.filename or not file.filename.endswith(".omnivoice"):
        raise HTTPException(
            status_code=400,
            detail="File must be a .omnivoice bundle (ZIP format).",
        )

    # Enforce upload size limit before reading
    content = await file.read()
    if len(content) > MAX_BUNDLE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Bundle too large ({len(content)} bytes). Max is {MAX_BUNDLE_BYTES}.",
        )

    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Invalid .omnivoice bundle (not a valid ZIP).") from exc

    # Read metadata
    if "metadata.json" not in zf.namelist():
        raise HTTPException(
            status_code=400,
            detail="Invalid .omnivoice bundle: missing metadata.json",
        )

    with zf.open("metadata.json") as mf:
        metadata = json.load(mf)
    profile_id = str(uuid.uuid4())[:8]

    # Extract audio files — stream from zip to disk
    ref_audio_filename = None
    locked_audio_filename = None

    for name in zf.namelist():
        if name.startswith("ref_audio"):
            ext = os.path.splitext(name)[1] or ".wav"
            ref_audio_filename = f"{profile_id}{ext}"
            ref_path = os.path.join(VOICES_DIR, ref_audio_filename)
            with zf.open(name) as src, open(ref_path, "wb") as dst:
                shutil.copyfileobj(src, dst)

        elif name.startswith("locked_audio"):
            ext = os.path.splitext(name)[1] or ".wav"
            locked_audio_filename = f"{profile_id}_locked{ext}"
            locked_path = os.path.join(VOICES_DIR, locked_audio_filename)
            with zf.open(name) as src, open(locked_path, "wb") as dst:
                shutil.copyfileobj(src, dst)

    if not ref_audio_filename:
        raise HTTPException(
            status_code=400,
            detail="Invalid .omnivoice bundle: no reference audio found.",
        )

    # Create the profile in the database
    is_locked = bool(metadata.get("is_locked") and locked_audio_filename)
    with db_conn() as conn:
        conn.execute(
            """INSERT INTO voice_profiles
               (id, name, ref_audio_path, ref_text, instruct, language,
                seed, personality, is_locked, locked_audio_path, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                profile_id,
                metadata.get("profile_name", "Imported Voice"),
                ref_audio_filename,
                metadata.get("ref_text", ""),
                metadata.get("instruct", ""),
                metadata.get("language", "Auto"),
                metadata.get("seed"),
                metadata.get("personality", ""),
                1 if is_locked else 0,
                locked_audio_filename or "",
                time.time(),
            ),
        )

    event_bus.emit("profiles", {"action": "created", "id": profile_id})
    logger.info(
        "Imported voice profile %r as %s from .omnivoice bundle",
        metadata.get("profile_name"), profile_id,
    )

    return {
        "success": True,
        "profile_id": profile_id,
        "name": metadata.get("profile_name", "Imported Voice"),
        "is_locked": is_locked,
        "source_bundle": file.filename,
    }


# ── Local Marketplace (Publish & Browse) ───────────────────────────────────


@router.post("/publish/{profile_id}")
def publish_to_marketplace(
    profile_id: str,
    tags: str = Query("", description="Comma-separated tags"),
):
    """Publish a voice profile to the local marketplace directory.

    This saves a .omnivoice bundle to the marketplace folder so other
    OmniVoice instances on the same machine (or shared network drive)
    can discover and import it.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM voice_profiles WHERE id = ?", (profile_id,)
        ).fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Voice profile not found")

    profile = dict(row)
    safe_name = "".join(
        c if c.isalnum() or c in "-_ " else "" for c in profile.get("name", "voice")
    ).strip().replace(" ", "_")[:40]
    bundle_path = MARKETPLACE_DIR / f"{safe_name}_{profile_id}.omnivoice"

    # Build the bundle
    with zipfile.ZipFile(str(bundle_path), "w", zipfile.ZIP_DEFLATED) as zf:
        metadata = {
            "bundle_version": BUNDLE_VERSION,
            "profile_name": profile.get("name", "Unnamed"),
            "ref_text": profile.get("ref_text", ""),
            "instruct": profile.get("instruct", ""),
            "language": profile.get("language", "Auto"),
            "personality": profile.get("personality", ""),
            "seed": profile.get("seed"),
            "is_locked": bool(profile.get("is_locked")),
            "tags": [t.strip() for t in tags.split(",") if t.strip()],
            "published_at": time.time(),
            "omnivoice_version": "0.4.0",
        }
        zf.writestr("metadata.json", json.dumps(metadata, indent=2))

        ref_path = profile.get("ref_audio_path")
        if ref_path:
            full_ref = os.path.join(VOICES_DIR, ref_path)
            if os.path.isfile(full_ref):
                ext = os.path.splitext(ref_path)[1] or ".wav"
                zf.write(full_ref, f"ref_audio{ext}")

        locked_path = profile.get("locked_audio_path")
        if locked_path:
            full_locked = os.path.join(VOICES_DIR, locked_path)
            if os.path.isfile(full_locked):
                ext = os.path.splitext(locked_path)[1] or ".wav"
                zf.write(full_locked, f"locked_audio{ext}")

    logger.info("Published voice %r to marketplace: %s", profile.get("name"), bundle_path)
    return {
        "success": True,
        "profile_id": profile_id,
        "bundle_path": str(bundle_path),
        "bundle_size": os.path.getsize(bundle_path),
    }


@router.get("/browse")
def browse_marketplace(
    search: Optional[str] = Query(None, description="Search by name or tags"),
):
    """List available .omnivoice bundles in the local marketplace directory."""
    bundles = []

    for path in sorted(MARKETPLACE_DIR.glob("*.omnivoice"), key=os.path.getmtime, reverse=True):
        try:
            with zipfile.ZipFile(str(path)) as zf:
                if "metadata.json" not in zf.namelist():
                    continue
                metadata = json.loads(zf.read("metadata.json"))

                # Apply search filter
                if search:
                    searchable = " ".join([
                        metadata.get("profile_name", ""),
                        " ".join(metadata.get("tags", [])),
                        metadata.get("personality", ""),
                    ]).lower()
                    if search.lower() not in searchable:
                        continue

                bundles.append({
                    "filename": path.name,
                    "name": metadata.get("profile_name", path.stem),
                    "language": metadata.get("language", "unknown"),
                    "tags": metadata.get("tags", []),
                    "is_locked": metadata.get("is_locked", False),
                    "personality": metadata.get("personality", ""),
                    "published_at": metadata.get("published_at"),
                    "size_bytes": os.path.getsize(path),
                    "has_ref_audio": any(
                        n.startswith("ref_audio") for n in zf.namelist()
                    ),
                    "has_locked_audio": any(
                        n.startswith("locked_audio") for n in zf.namelist()
                    ),
                })
        except Exception as e:
            logger.warning("Skipping invalid bundle %s: %s", path.name, e)

    return {"bundles": bundles, "total": len(bundles), "directory": str(MARKETPLACE_DIR)}


@router.post("/install/{filename}")
async def install_from_marketplace(filename: str):
    """Import a voice profile from a bundle in the local marketplace directory."""
    bundle_path = MARKETPLACE_DIR / filename
    if not bundle_path.is_file():
        raise HTTPException(status_code=404, detail=f"Bundle not found: {filename}")

    # Read and delegate to the import logic
    with open(bundle_path, "rb") as f:
        content = f.read()

    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Invalid .omnivoice bundle.") from exc

    if "metadata.json" not in zf.namelist():
        raise HTTPException(status_code=400, detail="Invalid bundle: missing metadata.json")

    with zf.open("metadata.json") as mf:
        metadata = json.load(mf)
    profile_id = str(uuid.uuid4())[:8]

    ref_audio_filename = None
    locked_audio_filename = None

    for name in zf.namelist():
        if name.startswith("ref_audio"):
            ext = os.path.splitext(name)[1] or ".wav"
            ref_audio_filename = f"{profile_id}{ext}"
            with zf.open(name) as src, open(os.path.join(VOICES_DIR, ref_audio_filename), "wb") as dst:
                shutil.copyfileobj(src, dst)
        elif name.startswith("locked_audio"):
            ext = os.path.splitext(name)[1] or ".wav"
            locked_audio_filename = f"{profile_id}_locked{ext}"
            with zf.open(name) as src, open(os.path.join(VOICES_DIR, locked_audio_filename), "wb") as dst:
                shutil.copyfileobj(src, dst)

    if not ref_audio_filename:
        raise HTTPException(status_code=400, detail="No reference audio in bundle.")

    is_locked = bool(metadata.get("is_locked") and locked_audio_filename)
    with db_conn() as conn:
        conn.execute(
            """INSERT INTO voice_profiles
               (id, name, ref_audio_path, ref_text, instruct, language,
                seed, personality, is_locked, locked_audio_path, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                profile_id,
                metadata.get("profile_name", "Marketplace Voice"),
                ref_audio_filename,
                metadata.get("ref_text", ""),
                metadata.get("instruct", ""),
                metadata.get("language", "Auto"),
                metadata.get("seed"),
                metadata.get("personality", ""),
                1 if is_locked else 0,
                locked_audio_filename or "",
                time.time(),
            ),
        )

    event_bus.emit("profiles", {"action": "created", "id": profile_id})

    return {
        "success": True,
        "profile_id": profile_id,
        "name": metadata.get("profile_name", "Marketplace Voice"),
        "source": filename,
    }


@router.delete("/{filename}")
def remove_from_marketplace(filename: str):
    """Remove a bundle from the local marketplace directory."""
    bundle_path = MARKETPLACE_DIR / filename
    if not bundle_path.is_file():
        raise HTTPException(status_code=404, detail=f"Bundle not found: {filename}")
    try:
        os.unlink(bundle_path)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete: {e}")
    return {"success": True, "deleted": filename}
