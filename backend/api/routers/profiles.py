import os
import uuid
import time
import shutil
from typing import Optional
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import FileResponse, Response

from core.db import get_db
from core.config import VOICES_DIR, OUTPUTS_DIR

router = APIRouter()

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
):
    profile_id = str(uuid.uuid4())[:8]
    ext = os.path.splitext(ref_audio.filename or ".wav")[1]
    audio_filename = f"{profile_id}{ext}"
    audio_path = os.path.join(VOICES_DIR, audio_filename)

    with open(audio_path, "wb") as f:
        f.write(await ref_audio.read())

    conn = get_db()
    conn.execute(
        "INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, instruct, language, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (profile_id, name, audio_filename, ref_text, instruct, language, seed, time.time())
    )
    conn.commit()
    conn.close()
    return {"id": profile_id, "name": name}

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
        raise HTTPException(status_code=404, detail="Profile not found")

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
    return {"locked": True, "profile_id": profile_id, "locked_audio_path": locked_filename}

@router.post("/profiles/{profile_id}/unlock")
async def unlock_profile(profile_id: str):
    conn = get_db()
    profile = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if not profile:
        conn.close()
        raise HTTPException(status_code=404, detail="Profile not found")

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
    conn.execute("DELETE FROM voice_profiles WHERE id=?", (profile_id,))
    conn.commit()
    conn.close()
    return {"deleted": profile_id}
