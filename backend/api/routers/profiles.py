import os
import uuid
import time
import shutil
from typing import Optional
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from core.db import get_db, db_conn
from core.config import VOICES_DIR, OUTPUTS_DIR
from core import event_bus
from core.personalities import get_personalities

router = APIRouter()


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    ref_text: Optional[str] = None
    instruct: Optional[str] = None
    language: Optional[str] = None
    personality: Optional[str] = None


@router.get("/personalities")
def list_personalities():
    """Return built-in voice personality presets."""
    return get_personalities()

@router.get("/profiles")
def list_profiles():
    conn = get_db()
    rows = conn.execute("SELECT * FROM voice_profiles ORDER BY created_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@router.post("/profiles")
async def create_profile(
    name: str = Form(...),
    ref_audio: UploadFile = File(...),
    ref_text: str = Form(""),
    instruct: str = Form(""),
    language: str = Form("Auto"),
    seed: Optional[int] = Form(None),
    personality: str = Form(""),
):
    profile_id = str(uuid.uuid4())[:8]
    ext = os.path.splitext(ref_audio.filename or ".wav")[1]
    audio_filename = f"{profile_id}{ext}"
    audio_path = os.path.join(VOICES_DIR, audio_filename)

    with open(audio_path, "wb") as f:
        f.write(await ref_audio.read())

    conn = get_db()
    conn.execute(
        "INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, instruct, language, seed, personality, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (profile_id, name, audio_filename, ref_text, instruct, language, seed, personality, time.time())
    )
    conn.commit()
    conn.close()
    event_bus.emit("profiles", {"action": "created", "id": profile_id})
    return {"id": profile_id, "name": name}

@router.get("/profiles/{profile_id}")
def get_profile(profile_id: str):
    """Full profile record for the voice profile page."""
    with db_conn() as conn:
        row = conn.execute(
            "SELECT * FROM voice_profiles WHERE id = ?", (profile_id,),
        ).fetchone()
    if not row:
        raise HTTPException(
            status_code=404,
            detail="That voice profile doesn't exist. It may have been deleted from another tab.",
        )
    return dict(row)


@router.put("/profiles/{profile_id}")
def update_profile(profile_id: str, patch: ProfileUpdate):
    """Partial update — only fields set on the payload are changed."""
    fields = []
    params = []
    for col in ("name", "ref_text", "instruct", "language", "personality"):
        val = getattr(patch, col)
        if val is None:
            continue
        if col == "name" and not val.strip():
            raise HTTPException(status_code=400, detail="A voice profile needs a name.")
        fields.append(f"{col} = ?")
        params.append(val.strip() if col in ("name", "language") else val)
    if not fields:
        raise HTTPException(
            status_code=400,
            detail="PUT /profiles/{id} body contained no editable fields. Include at least one of: name, language, instruct, description.",
        )
    params.append(profile_id)
    with db_conn() as conn:
        cur = conn.execute(
            f"UPDATE voice_profiles SET {', '.join(fields)} WHERE id = ?",
            params,
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status_code=404,
                detail="That voice profile doesn't exist. It may have been deleted from another tab.",
            )
        row = conn.execute(
            "SELECT * FROM voice_profiles WHERE id = ?", (profile_id,),
        ).fetchone()
    event_bus.emit("profiles", {"action": "updated", "id": profile_id})
    return dict(row)


@router.get("/profiles/{profile_id}/usage")
def get_profile_usage(profile_id: str):
    """Where has this voice been used? Synth-history + segment counts per project."""
    with db_conn() as conn:
        synth_rows = conn.execute(
            "SELECT id, text, audio_path, created_at, generation_time "
            "FROM generation_history WHERE profile_id = ? "
            "ORDER BY created_at DESC LIMIT 20",
            (profile_id,),
        ).fetchall()
        synth_total = conn.execute(
            "SELECT COUNT(*) AS n FROM generation_history WHERE profile_id = ?",
            (profile_id,),
        ).fetchone()["n"]

    # Dub project usage is harder — profile_id lives inside state_json.segments[].profile_id.
    # We scan the persisted state blob; for tens of projects this is fine.
    import json
    project_hits: list[dict] = []
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, updated_at, state_json FROM studio_projects ORDER BY updated_at DESC"
        ).fetchall()
    for r in rows:
        try:
            state = json.loads(r["state_json"] or "{}")
        except Exception:
            continue
        segs = state.get("segments") or []
        n = sum(1 for s in segs if s.get("profile_id") == profile_id)
        if n:
            project_hits.append({
                "project_id": r["id"],
                "project_name": r["name"],
                "segment_count": n,
                "updated_at": r["updated_at"],
            })

    return {
        "synth_recent": [dict(r) for r in synth_rows],
        "synth_total": synth_total,
        "projects": project_hits,
        "project_total_segments": sum(p["segment_count"] for p in project_hits),
    }


@router.get("/profiles/{profile_id}/audio")
def get_profile_audio(profile_id: str):
    conn = get_db()
    row = conn.execute("SELECT ref_audio_path, locked_audio_path FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    conn.close()
    if not row:
        return Response("Profile not found", status_code=404)
    audio_file = row["locked_audio_path"] or row["ref_audio_path"]
    if not audio_file:
        return Response("No audio available", status_code=404)
    audio_path = os.path.join(VOICES_DIR, audio_file)
    if not os.path.exists(audio_path):
        return Response("Audio file missing", status_code=404)
    return FileResponse(audio_path, media_type="audio/wav")

@router.post("/profiles/{profile_id}/lock")
async def lock_profile(
    profile_id: str,
    history_id: str = Form(...),
    seed: Optional[int] = Form(None),
):
    conn = get_db()
    profile = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if not profile:
        conn.close()
        raise HTTPException(
            status_code=404,
            detail="Voice profile not found. It may have been deleted from another window — refresh the sidebar to see the current list.",
        )

    history = conn.execute("SELECT * FROM generation_history WHERE id=?", (history_id,)).fetchone()
    if not history or not history["audio_path"]:
        conn.close()
        raise HTTPException(status_code=404, detail="History item not found or has no audio")

    src_path = os.path.join(OUTPUTS_DIR, history["audio_path"])
    if not os.path.exists(src_path):
        conn.close()
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    locked_filename = f"{profile_id}_locked.wav"
    locked_path = os.path.join(VOICES_DIR, locked_filename)
    shutil.copy2(src_path, locked_path)

    ref_text = history["text"][:100] if history["text"] else ""

    conn.execute(
        "UPDATE voice_profiles SET locked_audio_path=?, seed=?, is_locked=1, ref_text=? WHERE id=?",
        (locked_filename, seed, ref_text, profile_id)
    )
    conn.commit()
    conn.close()
    event_bus.emit("profiles", {"action": "locked", "id": profile_id})
    return {"locked": True, "profile_id": profile_id, "locked_audio_path": locked_filename}

@router.post("/profiles/{profile_id}/unlock")
async def unlock_profile(profile_id: str):
    conn = get_db()
    profile = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if not profile:
        conn.close()
        raise HTTPException(
            status_code=404,
            detail="Voice profile not found. It may have been deleted from another window — refresh the sidebar to see the current list.",
        )

    if profile["locked_audio_path"]:
        locked_path = os.path.join(VOICES_DIR, profile["locked_audio_path"])
        if os.path.exists(locked_path):
            os.remove(locked_path)

    conn.execute(
        "UPDATE voice_profiles SET locked_audio_path='', seed=NULL, is_locked=0 WHERE id=?",
        (profile_id,)
    )
    conn.commit()
    conn.close()
    event_bus.emit("profiles", {"action": "unlocked", "id": profile_id})
    return {"unlocked": True, "profile_id": profile_id}

@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str):
    conn = get_db()
    row = conn.execute("SELECT ref_audio_path, locked_audio_path FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if row:
        for col in ["ref_audio_path", "locked_audio_path"]:
            if row[col]:
                path = os.path.join(VOICES_DIR, row[col])
                if os.path.exists(path):
                    os.remove(path)
    # Prevent FOREIGN KEY constraint failure
    conn.execute("UPDATE generation_history SET profile_id = NULL WHERE profile_id=?", (profile_id,))
    conn.execute("DELETE FROM voice_profiles WHERE id=?", (profile_id,))
    conn.commit()
    conn.close()
    event_bus.emit("profiles", {"action": "deleted", "id": profile_id})
    return {"deleted": profile_id}
