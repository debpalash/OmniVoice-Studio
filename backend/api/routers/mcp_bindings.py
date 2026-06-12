"""REST CRUD for per-agent MCP voice bindings (Wave 2.2 / Spec 2).

Loopback-gated — the Settings UI manages bindings here. The MCP tools
themselves resolve voices via ``services.mcp_bindings.resolve_voice``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.dependencies import require_loopback
from services import mcp_bindings

router = APIRouter(
    prefix="/api/mcp",
    tags=["mcp"],
    dependencies=[Depends(require_loopback)],
)


class _BindingBody(BaseModel):
    client_id: str = Field(..., min_length=1, max_length=128)
    label: str | None = None
    profile_id: str | None = None
    default_engine: str | None = None


@router.get("/bindings")
def list_bindings():
    """All per-agent voice bindings, most-recently-seen first."""
    return mcp_bindings.list_bindings()


@router.put("/bindings")
def upsert_binding(body: _BindingBody):
    """Create or update the binding for an MCP client id."""
    try:
        return mcp_bindings.upsert_binding(
            body.client_id,
            label=body.label,
            profile_id=body.profile_id,
            default_engine=body.default_engine,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/bindings/{client_id}")
def delete_binding(client_id: str):
    if not mcp_bindings.delete_binding(client_id):
        raise HTTPException(status_code=404, detail="No binding for that client id")
    return {"deleted": client_id}
