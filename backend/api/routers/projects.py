import uuid
import time
import json
from fastapi import APIRouter, HTTPException

from core.db import get_db
from core import event_bus
from schemas.requests import ProjectSaveRequest

router = APIRouter()

@router.get("/projects")
async def list_projects():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, name, video_path, duration, created_at, updated_at FROM studio_projects ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@router.get("/projects/{project_id}")
async def get_project(project_id: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM studio_projects WHERE id=?", (project_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    result = dict(row)
    if result.get("state_json"):
        try:
            result["state"] = json.loads(result["state_json"])
        except Exception:
            result["state"] = {}
    else:
        result["state"] = {}
    return result

@router.post("/projects")
async def create_project(req: ProjectSaveRequest):
    project_id = str(uuid.uuid4())[:8]
    now = time.time()
    conn = get_db()
    conn.execute(
        "INSERT INTO studio_projects (id, name, video_path, audio_path, duration, state_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (project_id, req.name, req.video_path, req.audio_path, req.duration, json.dumps(req.state), now, now),
    )
    conn.commit()
    conn.close()
    event_bus.emit("projects", {"action": "created", "id": project_id})
    return {"id": project_id, "name": req.name, "created_at": now}

@router.put("/projects/{project_id}")
async def update_project(project_id: str, req: ProjectSaveRequest):
    conn = get_db()
    row = conn.execute("SELECT id FROM studio_projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Project not found")
    now = time.time()
    conn.execute(
        "UPDATE studio_projects SET name=?, video_path=?, audio_path=?, duration=?, state_json=?, updated_at=? WHERE id=?",
        (req.name, req.video_path, req.audio_path, req.duration, json.dumps(req.state), now, project_id),
    )
    conn.commit()
    conn.close()
    event_bus.emit("projects", {"action": "updated", "id": project_id})
    return {"id": project_id, "name": req.name, "updated_at": now}

@router.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    conn = get_db()
    conn.execute("DELETE FROM studio_projects WHERE id=?", (project_id,))
    conn.commit()
    conn.close()
    event_bus.emit("projects", {"action": "deleted", "id": project_id})
    return {"deleted": project_id}
