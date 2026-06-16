import os
import re
import uuid
import time
import shutil
from typing import Optional
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from core.db import db_conn
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
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM voice_profiles ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]

_DESIGN_SEED = 42  # deterministic sample render, same as archetype previews


@router.post("/profiles")
async def create_profile(
    name: str = Form(...),
    ref_audio: Optional[UploadFile] = File(None),
    ref_text: str = Form(""),
    instruct: str = Form(""),
    language: str = Form("Auto"),
    seed: Optional[int] = Form(None),
    personality: str = Form(""),
    kind: str = Form("clone"),
    vd_states: Optional[str] = Form(None),
):
    """Create a voice profile (spec: docs/specs/voice-studio-unification.md §5).

    kind='clone'  — requires `ref_audio` (the user's reference recording).
    kind='design' — requires `vd_states` (JSON of category picks); the server
                    renders a deterministic sample WAV (seed 42, same path as
                    archetype materialization) and stores it as the profile's
                    reference so the voice identity is stable across runs.
    """
    if kind not in ("clone", "design"):
        raise HTTPException(status_code=422, detail="kind must be 'clone' or 'design'")
    if kind == "clone" and ref_audio is None:
        raise HTTPException(status_code=422, detail="clone profiles require ref_audio")
    if kind == "design":
        if not (vd_states or "").strip():
            raise HTTPException(status_code=422, detail="design profiles require vd_states")
        import json as _json
        try:
            parsed = _json.loads(vd_states)
            if not isinstance(parsed, dict):
                raise ValueError("not an object")
        except ValueError:
            raise HTTPException(status_code=422, detail="vd_states must be a JSON object")
        # An all-Auto design (every category left on "Auto") yields an empty
        # instruct — that's still a valid, saveable voice: synthesis falls back
        # to neutral instruct-only conditioning (see generation.py design path).
        # Don't gate save on a non-empty instruct.

    profile_id = str(uuid.uuid4())[:8]

    if kind == "clone":
        ext = os.path.splitext(ref_audio.filename or ".wav")[1]
        audio_filename = f"{profile_id}{ext}"
        audio_path = os.path.join(VOICES_DIR, audio_filename)
        with open(audio_path, "wb") as f:
            f.write(await ref_audio.read())
        used_seed = seed
    else:
        # Saving a design profile is a pure persistence operation — it must not
        # depend on a loaded TTS model (issue #476: on a fresh model-less Docker
        # image the render forced a full model load + inference that 503'd, so
        # the save failed). We try the deterministic identity sample opportunist-
        # ically through the one shared TTS path (archetypes' renderer, never a
        # second inference code path); if the engine isn't ready it's rendered
        # lazily on first preview/use. The row carries vd_states + instruct, so
        # the voice is fully usable without the sample (synthesis falls back to
        # instruct-only conditioning — see generation.py's design path).
        from pathlib import Path
        from api.routers.archetypes import _render_archetype_wav
        audio_filename = f"{profile_id}.wav"
        audio_path = os.path.join(VOICES_DIR, audio_filename)
        try:
            await _render_archetype_wav(
                {
                    "language": language,
                    "sample_script": ref_text,  # optional custom sample line
                    "instruct": instruct,
                },
                Path(audio_path),
            )
        except Exception:
            # Engine unavailable / OOM / inference failure — defer the sample.
            # Store the row with no ref_audio_path; the identity sample is
            # rendered on first preview or use. Never let this block the save.
            import logging
            logging.getLogger("omnivoice.profiles").info(
                "Design profile %s saved with sample pending — "
                "voice engine not ready; will render on first use", profile_id,
            )
            if os.path.exists(audio_path):  # partial/blank render: don't keep it
                with __import__("contextlib").suppress(OSError):
                    os.remove(audio_path)
            audio_filename = None
        used_seed = seed if seed is not None else _DESIGN_SEED

    try:
        with db_conn() as conn:
            conn.execute(
                "INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, instruct, "
                "language, seed, personality, kind, vd_states, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (profile_id, name, audio_filename, ref_text, instruct, language,
                 used_seed, personality, kind, vd_states, time.time())
            )
    except Exception:
        # Clean up orphaned audio file if DB insert fails
        if os.path.exists(audio_path):
            os.remove(audio_path)
        raise
    event_bus.emit("profiles", {"action": "created", "id": profile_id})
    return {"id": profile_id, "name": name, "kind": kind}

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


# profile_id is a request path param and the audio filename derives from it, so
# constrain it to the generated-id charset (no separators / `..` possible) before
# any path use, and read only a *direct child* of VOICES_DIR — os.path.basename()
# strips any directory component (a path-injection / CWE-22 barrier).
_PROFILE_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


@router.get("/profiles/{profile_id}/audio")
async def get_profile_audio(profile_id: str):
    if not _PROFILE_ID_RE.fullmatch(profile_id or ""):
        return Response("Profile not found", status_code=404)
    with db_conn() as conn:
        row = conn.execute(
            "SELECT ref_audio_path, locked_audio_path, kind, instruct, language, ref_text "
            "FROM voice_profiles WHERE id=?",
            (profile_id,),
        ).fetchone()
    if not row:
        return Response("Profile not found", status_code=404)
    audio_file = row["locked_audio_path"] or row["ref_audio_path"]
    if not audio_file:
        # A design profile saved before the engine was ready (issue #476) has no
        # identity sample yet. Render it lazily now — the deterministic seed-42
        # sample is reproducible, so a deferred render matches a save-time one.
        rendered = await _materialize_design_sample(profile_id, row)
        if rendered is None:
            return Response("No audio available", status_code=404)
        audio_file = rendered
    # CWE-22: resolve the DB-stored filename strictly inside VOICES_DIR via the
    # shared guard — _voices_path() applies the os.path.basename() barrier plus
    # symlink-resolved containment (same path the consent endpoint trusts).
    audio_path = _voices_path(str(audio_file))
    if audio_path is None or not os.path.exists(audio_path):
        return Response("Audio file missing", status_code=404)
    return FileResponse(audio_path, media_type="audio/wav")


async def _materialize_design_sample(profile_id: str, row) -> Optional[str]:
    """Render a design profile's pending identity sample on first request.

    Returns the stored filename on success, or None if this isn't a renderable
    design row. Raises HTTPException(503) with a precise "model not ready"
    message if the engine is genuinely unavailable — saving never depends on
    this, but a user who explicitly asks for the sample gets a clear signal.
    """
    try:
        kind = row["kind"]
    except (KeyError, IndexError):
        kind = "clone"
    if kind != "design":
        return None

    from pathlib import Path
    from api.routers.archetypes import _render_archetype_wav

    audio_filename = f"{profile_id}.wav"
    # CWE-22: resolve under VOICES_DIR via the shared basename + containment
    # guard before rendering (rejects any escape).
    audio_path = _voices_path(audio_filename)
    if audio_path is None:
        raise HTTPException(status_code=400, detail="invalid profile identifier")
    try:
        await _render_archetype_wav(
            {
                "language": row["language"] or "Auto",
                "sample_script": row["ref_text"] or "",
                "instruct": row["instruct"] or "",
            },
            Path(audio_path),
        )
    except Exception as e:
        with __import__("contextlib").suppress(OSError):
            if os.path.exists(audio_path):
                os.remove(audio_path)
        raise HTTPException(
            status_code=503,
            detail=(
                "The voice engine isn't ready yet, so this designed voice's "
                "preview sample can't be rendered. Finish setup / download a "
                f"model, then try again. ({e})"
            ),
        )

    with db_conn() as conn:
        conn.execute(
            "UPDATE voice_profiles SET ref_audio_path=? WHERE id=?",
            (audio_filename, profile_id),
        )
    return audio_filename

@router.post("/profiles/{profile_id}/lock")
async def lock_profile(
    profile_id: str,
    history_id: str = Form(...),
    seed: Optional[int] = Form(None),
):
    with db_conn() as conn:
        profile = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if not profile:
            raise HTTPException(
                status_code=404,
                detail="Voice profile not found. It may have been deleted from another window — refresh the sidebar to see the current list.",
            )

        history = conn.execute("SELECT * FROM generation_history WHERE id=?", (history_id,)).fetchone()
        if not history or not history["audio_path"]:
            raise HTTPException(status_code=404, detail="History item not found or has no audio")

        src_path = os.path.join(OUTPUTS_DIR, history["audio_path"])
        if not os.path.exists(src_path):
            raise HTTPException(status_code=404, detail="Audio file not found on disk")

        locked_filename = f"{profile_id}_locked.wav"
        locked_path = os.path.join(VOICES_DIR, locked_filename)
        shutil.copy2(src_path, locked_path)

        ref_text = history["text"][:100] if history["text"] else ""

        conn.execute(
            "UPDATE voice_profiles SET locked_audio_path=?, seed=?, is_locked=1, ref_text=? WHERE id=?",
            (locked_filename, seed, ref_text, profile_id)
        )
    event_bus.emit("profiles", {"action": "locked", "id": profile_id})
    return {"locked": True, "profile_id": profile_id, "locked_audio_path": locked_filename}

@router.post("/profiles/{profile_id}/unlock")
async def unlock_profile(profile_id: str):
    with db_conn() as conn:
        profile = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if not profile:
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
    event_bus.emit("profiles", {"action": "unlocked", "id": profile_id})
    return {"unlocked": True, "profile_id": profile_id}

# ── Consent lock (parity program Wave 0.2) ─────────────────────────────────
#
# A profile becomes "verified own voice" when its owner records themselves
# reading a consent statement. The recording is provenance, not a voiceprint
# check — agentic features and gallery sharing gate on the flag; plain local
# synthesis never does. Spec: docs/competitive-analysis.md Action 22.

_MIN_CONSENT_AUDIO_BYTES = 1000  # same floor as the frontend recorder

# Upload filename extension whitelist — anything else falls back to .wav so a
# crafted filename can never influence the on-disk path (py/path-injection).
_CONSENT_EXT_RE = re.compile(r"^\.[A-Za-z0-9]{1,8}$")


def _voices_path(filename: str) -> Optional[str]:
    """Resolve a DB-stored audio filename strictly inside VOICES_DIR.

    Rejects anything that isn't a bare filename or that escapes the voices
    directory after symlink resolution. Returns None instead of raising so
    cleanup paths can simply skip bad values.
    """
    if not filename or os.path.basename(filename) != filename:
        return None
    root = os.path.realpath(VOICES_DIR)
    path = os.path.realpath(os.path.join(root, filename))
    if not path.startswith(root + os.sep):
        return None
    return path


@router.post("/profiles/{profile_id}/consent")
async def record_consent(
    profile_id: str,
    consent_audio: UploadFile = File(...),
    consent_text: str = Form(...),
):
    if not consent_text.strip():
        raise HTTPException(status_code=422, detail="consent_text must not be empty")
    data = await consent_audio.read()
    if len(data) < _MIN_CONSENT_AUDIO_BYTES:
        raise HTTPException(status_code=422, detail="consent recording is too short")

    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, consent_audio_path FROM voice_profiles WHERE id=?", (profile_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Profile not found")

    ext = os.path.splitext(consent_audio.filename or "")[1]
    if not _CONSENT_EXT_RE.match(ext):
        ext = ".wav"
    audio_filename = f"{profile_id}_consent{ext}"
    audio_path = _voices_path(audio_filename)
    if audio_path is None:  # profile_id is server-generated; this is belt+braces
        raise HTTPException(status_code=400, detail="Invalid profile id")
    with open(audio_path, "wb") as f:
        f.write(data)

    # A re-record may change the extension; drop the superseded file.
    old = row["consent_audio_path"]
    if old and old != audio_filename:
        old_path = _voices_path(old)
        if old_path and os.path.exists(old_path):
            os.remove(old_path)

    recorded_at = time.time()
    try:
        with db_conn() as conn:
            conn.execute(
                "UPDATE voice_profiles SET verified_own_voice=1, consent_text=?, "
                "consent_audio_path=?, consent_recorded_at=? WHERE id=?",
                (consent_text.strip(), audio_filename, recorded_at, profile_id),
            )
    except Exception:
        if os.path.exists(audio_path):
            os.remove(audio_path)
        raise
    event_bus.emit("profiles", {"action": "consent_recorded", "id": profile_id})
    return {
        "id": profile_id,
        "verified_own_voice": True,
        "consent_recorded_at": recorded_at,
    }


@router.delete("/profiles/{profile_id}/consent")
def revoke_consent(profile_id: str):
    with db_conn() as conn:
        row = conn.execute(
            "SELECT consent_audio_path FROM voice_profiles WHERE id=?", (profile_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found")
        conn.execute(
            "UPDATE voice_profiles SET verified_own_voice=0, consent_text='', "
            "consent_audio_path='', consent_recorded_at=NULL WHERE id=?",
            (profile_id,),
        )
    if row["consent_audio_path"]:
        path = _voices_path(row["consent_audio_path"])
        if path and os.path.exists(path):
            os.remove(path)
    event_bus.emit("profiles", {"action": "consent_revoked", "id": profile_id})
    return {"id": profile_id, "verified_own_voice": False}


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str):
    with db_conn() as conn:
        row = conn.execute("SELECT ref_audio_path, locked_audio_path, consent_audio_path FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if row:
            for col in ["ref_audio_path", "locked_audio_path", "consent_audio_path"]:
                if row[col]:
                    path = _voices_path(row[col])
                    if path and os.path.exists(path):
                        os.remove(path)
        # Prevent FOREIGN KEY constraint failure
        conn.execute("UPDATE generation_history SET profile_id = NULL WHERE profile_id=?", (profile_id,))
        conn.execute("DELETE FROM voice_profiles WHERE id=?", (profile_id,))
    event_bus.emit("profiles", {"action": "deleted", "id": profile_id})
    return {"deleted": profile_id}
