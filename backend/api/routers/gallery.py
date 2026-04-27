import os
import json
import uuid
import time
import asyncio
import logging
import subprocess
from typing import Optional, List
from pathlib import Path
from fastapi import APIRouter, File, Form, UploadFile, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from core.db import get_db
from core.config import VOICES_DIR, OUTPUTS_DIR
from core import event_bus

logger = logging.getLogger("omnivoice.gallery")

router = APIRouter()

VOICE_GALLERY_DIR = Path(os.path.join(OUTPUTS_DIR, "voice_gallery"))
VOICE_GALLERY_DIR.mkdir(parents=True, exist_ok=True)

CATEGORIES = [
    {
        "id": "disney",
        "name": "Disney",
        "icon": "🎬",
        "description": "Disney characters, Pixar, and animated films",
    },
    {
        "id": "anime",
        "name": "Anime",
        "icon": "🎌",
        "description": "Japanese anime characters",
    },
    {
        "id": "marvel",
        "name": "Marvel/DC",
        "icon": "🦸",
        "description": "Superhero movies and TV shows",
    },
    {
        "id": "celebs",
        "name": "Celebrities",
        "icon": "⭐",
        "description": "Famous actors and personalities",
    },
    {
        "id": "politicians",
        "name": "Politicians",
        "icon": "🏛️",
        "description": "World leaders and politicians",
    },
    {
        "id": "news",
        "name": "News Anchors",
        "icon": "📰",
        "description": "News broadcasters",
    },
    {
        "id": "gaming",
        "name": "Gaming",
        "icon": "🎮",
        "description": "Video game characters",
    },
    {
        "id": "books",
        "name": "Books/Movies",
        "icon": "📚",
        "description": "Literary and film characters",
    },
]


class VoiceEntry(BaseModel):
    id: str
    name: str
    character: str
    category: str
    source_type: str  # "youtube", "upload", "preset"
    source_url: Optional[str] = None
    audio_path: str
    duration: float
    description: Optional[str] = None
    thumbnail: Optional[str] = None
    tags: List[str] = []
    created_at: float


def _init_gallery_db():
    """Initialize the voice gallery table."""
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS voice_gallery (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            character TEXT NOT NULL,
            category TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_url TEXT,
            audio_path TEXT NOT NULL,
            duration REAL NOT NULL,
            description TEXT,
            thumbnail TEXT,
            tags TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        )
    """)
    # Migration: add is_favorite column if missing (existing DBs)
    try:
        conn.execute("SELECT is_favorite FROM voice_gallery LIMIT 1")
    except Exception:
        conn.execute("ALTER TABLE voice_gallery ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()


@router.get("/gallery/categories")
def list_categories():
    """List all voice gallery categories."""
    return CATEGORIES


@router.get("/gallery/voices")
def list_voices(
    category: Optional[str] = Query(None, description="Filter by category"),
    search: Optional[str] = Query(None, description="Search by name or character"),
    limit: int = Query(50, ge=1, le=200),
):
    """List voices in the gallery, optionally filtered by category or search."""
    conn = get_db()
    query = "SELECT * FROM voice_gallery"
    params = []
    conditions = []

    if category:
        conditions.append("category = ?")
        params.append(category)
    if search:
        conditions.append("(name LIKE ? OR character LIKE ? OR description LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])

    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(query, params).fetchall()
    conn.close()

    results = []
    for row in rows:
        r = dict(row)
        r["tags"] = json.loads(r.get("tags", "[]") or "[]")
        results.append(r)
    return results


@router.get("/gallery/voices/{voice_id}")
def get_voice(voice_id: str):
    """Get a specific voice from the gallery."""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM voice_gallery WHERE id = ?", (voice_id,)
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Voice not found")
    r = dict(row)
    r["tags"] = json.loads(r.get("tags", "[]") or "[]")
    return r


@router.delete("/gallery/voices/{voice_id}")
def delete_voice(voice_id: str):
    """Delete a voice from the gallery."""
    conn = get_db()
    row = conn.execute(
        "SELECT audio_path FROM voice_gallery WHERE id = ?", (voice_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Voice not found")

    audio_path = row["audio_path"]
    if audio_path and os.path.exists(audio_path):
        try:
            os.remove(audio_path)
        except Exception:
            pass

    conn.execute("DELETE FROM voice_gallery WHERE id = ?", (voice_id,))
    conn.commit()
    conn.close()
    return {"success": True}


@router.post("/gallery/search/youtube")
async def search_youtube(
    query: str = Query(..., description="Character or celebrity name to search"),
    category: str = Query(..., description="Category to associate results with"),
    max_results: int = Query(5, ge=1, le=20),
):
    """Search YouTube for character/celebrity clips using yt-dlp."""
    try:
        result = await asyncio.create_subprocess_exec(
            "yt-dlp",
            "--dump-json",
            "--remote-components", "ejs:github",
            f"ytsearch{max_results}:{query}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await result.communicate()

        if result.returncode != 0:
            logger.error(f"yt-dlp search failed: {stderr.decode()}")
            raise HTTPException(
                status_code=500, detail=f"YouTube search failed: {stderr.decode()}"
            )

        lines = stdout.decode().strip().split("\n")
        results = []
        for line in lines:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                results.append(
                    {
                        "title": data.get("title", ""),
                        "video_id": data.get("id", ""),
                        "duration": str(data.get("duration")) if data.get("duration") is not None else None,
                        "thumbnail": data.get("thumbnail", None),
                    }
                )
            except json.JSONDecodeError:
                logger.warning(f"Failed to parse yt-dlp JSON line: {line}")

        return {"results": results, "query": query, "category": category}
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="yt-dlp not installed")
    except Exception as e:
        logger.error(f"YouTube search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/gallery/download")
async def download_youtube_clip(
    video_url: str = Query(..., description="YouTube video URL"),
    start_time: float = Query(0, ge=0, description="Start time in seconds"),
    duration: float = Query(10, ge=1, le=30, description="Clip duration in seconds"),
    character_name: str = Query(..., description="Character/celebrity name"),
    category: str = Query(..., description="Category"),
    description: str = Query("", description="Optional description"),
):
    """Download a clip from YouTube for voice cloning."""
    voice_id = str(uuid.uuid4())[:8]
    output_path = str(VOICE_GALLERY_DIR / f"{voice_id}.wav")
    temp_path = str(VOICE_GALLERY_DIR / f"{voice_id}.%(ext)s")

    try:
        cmd = [
            "yt-dlp",
            "--remote-components", "ejs:github",
            "-f",
            "bestaudio",
            "--download-sections",
            f"*{start_time:.1f}-{start_time + duration:.1f}",
            "-x",
            "--audio-format",
            "wav",
            "--audio-quality",
            "0",
            "-o",
            temp_path,
            video_url,
        ]

        result = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await result.communicate()

        if result.returncode != 0:
            logger.error(f"yt-dlp download failed: {stderr.decode()}")
            raise HTTPException(
                status_code=500, detail=f"Download failed: {stderr.decode()}"
            )

        # Find the downloaded file (yt-dlp replaces %s with actual extension)
        downloaded_files = list(VOICE_GALLERY_DIR.glob(f"{voice_id}.*"))
        if not downloaded_files:
            raise HTTPException(status_code=500, detail="Downloaded file not found")

        actual_path = downloaded_files[0]
        # Rename to output_path
        final_path = Path(output_path)
        actual_path.rename(final_path)

        conn = get_db()
        conn.execute(
            """
            INSERT INTO voice_gallery 
            (id, name, character, category, source_type, source_url, audio_path, duration, description, tags, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                voice_id,
                character_name,
                character_name,
                category,
                "youtube",
                video_url,
                output_path,
                duration,
                description,
                json.dumps([character_name.lower(), category]),
                time.time(),
            ),
        )
        conn.commit()
        conn.close()

        return {
            "success": True,
            "voice_id": voice_id,
            "audio_path": output_path,
            "duration": duration,
        }
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="yt-dlp not installed")
    except Exception as e:
        logger.error(f"Download error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/gallery/upload")
async def upload_voice_clip(
    name: str = Form(...),
    character: str = Form(...),
    category: str = Form(...),
    description: str = Form(""),
    audio: UploadFile = File(...),
):
    """Upload a voice clip directly to the gallery."""
    voice_id = str(uuid.uuid4())[:8]
    ext = os.path.splitext(audio.filename or ".wav")[1]
    audio_path = str(VOICE_GALLERY_DIR / f"{voice_id}{ext}")

    with open(audio_path, "wb") as f:
        f.write(await audio.read())

    try:
        import soundfile as sf

        info = sf.info(audio_path)
        duration = info.frames / info.samplerate
    except Exception:
        duration = 10.0

    conn = get_db()
    conn.execute(
        """
        INSERT INTO voice_gallery 
        (id, name, character, category, source_type, source_url, audio_path, duration, description, tags, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """,
        (
            voice_id,
            name,
            character,
            category,
            "upload",
            None,
            audio_path,
            duration,
            description,
            json.dumps([character.lower(), category]),
            time.time(),
        ),
    )
    conn.commit()
    conn.close()

    return {
        "id": voice_id,
        "name": name,
        "audio_path": audio_path,
        "duration": duration,
    }


@router.post("/gallery/voices/{voice_id}/save-as-profile")
async def save_voice_as_profile(
    voice_id: str,
    profile_name: str = Query(..., description="Name for the voice profile"),
):
    """Save a gallery voice as a voice profile for cloning."""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM voice_gallery WHERE id = ?", (voice_id,)
    ).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Voice not found")

    profile_id = str(uuid.uuid4())[:8]
    import shutil

    ext = os.path.splitext(row["audio_path"])[1]
    new_audio_path = os.path.join(VOICES_DIR, f"{profile_id}{ext}")
    shutil.copy(row["audio_path"], new_audio_path)

    conn = get_db()
    conn.execute(
        """
        INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, instruct, language, seed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """,
        (
            profile_id,
            profile_name,
            f"{profile_id}{ext}",
            row["description"] or "",
            row["character"] or "",
            "Auto",
            None,
            time.time(),
        ),
    )
    conn.commit()
    conn.close()
    event_bus.emit("profiles", {"action": "created", "id": profile_id})

    return {"profile_id": profile_id, "name": profile_name}


@router.get("/gallery/voices/{voice_id}/preview")
def preview_voice(voice_id: str):
    """Get a voice clip for preview playback."""
    conn = get_db()
    row = conn.execute(
        "SELECT audio_path FROM voice_gallery WHERE id = ?", (voice_id,)
    ).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Voice not found")

    audio_path = row["audio_path"]

    # Debug logging
    is_absolute = os.path.isabs(audio_path)
    path_exists = os.path.exists(audio_path) if audio_path else False

    # If absolute path, serve directly or redirect
    if is_absolute and path_exists:
        # Get just the relative path from outputs dir
        outputs_path = str(OUTPUTS_DIR)
        if audio_path.startswith(outputs_path):
            # Remove outputs_dir prefix to get relative path within outputs
            rel_path = os.path.relpath(audio_path, outputs_path)
            # The audio_path is like: /Users/user4/.../outputs/voice_gallery/file.wav
            # rel_path becomes: voice_gallery/file.wav
            # We want to serve from /audio/ so: /audio/voice_gallery/file.wav
            return RedirectResponse(f"/audio/{rel_path}")
        return FileResponse(audio_path, media_type="audio/wav")

    raise HTTPException(
        status_code=404,
        detail=f"Audio not found: abs={is_absolute}, exists={path_exists}, path={audio_path}",
    )


# ── Library management endpoints ──────────────────────────────────────────

@router.patch("/gallery/voices/{voice_id}")
def update_voice(voice_id: str, body: dict):
    """Update voice metadata — name, tags, is_favorite."""
    conn = get_db()
    row = conn.execute("SELECT id FROM voice_gallery WHERE id = ?", (voice_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Voice not found")

    updates = []
    params = []
    if "name" in body:
        updates.append("name = ?")
        params.append(body["name"])
    if "tags" in body:
        updates.append("tags = ?")
        params.append(json.dumps(body["tags"]) if isinstance(body["tags"], list) else body["tags"])
    if "is_favorite" in body:
        updates.append("is_favorite = ?")
        params.append(1 if body["is_favorite"] else 0)
    if "description" in body:
        updates.append("description = ?")
        params.append(body["description"])

    if not updates:
        conn.close()
        return {"success": True, "updated": []}

    params.append(voice_id)
    conn.execute(f"UPDATE voice_gallery SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    conn.close()
    return {"success": True, "updated": list(body.keys())}


@router.post("/gallery/voices/batch-delete")
def batch_delete_voices(body: dict):
    """Delete multiple voices by ID list."""
    ids = body.get("ids", [])
    if not ids:
        return {"deleted": 0}

    conn = get_db()
    deleted = 0
    for vid in ids:
        row = conn.execute("SELECT audio_path FROM voice_gallery WHERE id = ?", (vid,)).fetchone()
        if row:
            audio_path = row["audio_path"]
            if audio_path and os.path.exists(audio_path):
                try:
                    os.remove(audio_path)
                except Exception:
                    pass
            conn.execute("DELETE FROM voice_gallery WHERE id = ?", (vid,))
            deleted += 1
    conn.commit()
    conn.close()
    return {"deleted": deleted}


@router.post("/gallery/voices/{voice_id}/to-profile")
def voice_to_profile(voice_id: str):
    """Create a voice profile from a gallery clip."""
    conn = get_db()
    row = conn.execute("SELECT * FROM voice_gallery WHERE id = ?", (voice_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Voice not found")

    voice = dict(row)
    audio_path = voice["audio_path"]
    if not os.path.exists(audio_path):
        conn.close()
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    import shutil
    import uuid

    profile_id = str(uuid.uuid4())[:8]
    # Copy audio to voices dir
    dest_filename = f"{profile_id}_gallery.wav"
    dest_path = os.path.join(VOICES_DIR, dest_filename)
    shutil.copy2(audio_path, dest_path)

    import time
    now = time.time()
    conn.execute(
        """INSERT INTO voice_profiles
           (id, name, ref_audio_path, ref_text, instruct, seed, is_locked, locked_audio_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (profile_id, voice["name"], dest_filename, "", None, None, 0, None, now, now),
    )
    conn.commit()
    conn.close()
    event_bus.emit("profiles", {"action": "created", "id": profile_id})

    return {"success": True, "profile_id": profile_id, "name": voice["name"]}

