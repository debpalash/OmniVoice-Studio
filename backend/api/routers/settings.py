"""Settings API — HF token save/clear/state endpoints (Phase 1 AUTH-03 backend half).

These endpoints are the backend half of the Wave 2 Settings → API Keys
panel. Threat T-01-03 mitigation: every write endpoint is gated by the
router-level `require_loopback` dep, so non-loopback origins get 403
before the handler runs. Reads are loopback-gated too — the masked
token preview is useful telemetry that we still don't want exposed on
the LAN.

The state endpoint duplicates `/system/hf-token/state` (which lives on
`system.py` for legacy-router compatibility); both return the same shape.
"""
from __future__ import annotations

import logging
from dataclasses import asdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.dependencies import require_loopback

logger = logging.getLogger("omnivoice.api.settings")

router = APIRouter(
    prefix="/api/settings",
    tags=["settings"],
    dependencies=[Depends(require_loopback)],
)


class _HFTokenBody(BaseModel):
    token: str = Field(..., min_length=1, description="HuggingFace access token")


def _state_response() -> dict:
    """Return the same shape the React panel renders. Never includes raw token."""
    from services import token_resolver

    s = token_resolver.state()
    return {
        "active": s["active"],
        "sources": [asdict(row) for row in s["sources"]],
    }


@router.post("/hf-token")
def save_hf_token(body: _HFTokenBody):
    """Persist a new HF token to the encrypted settings store + the HF
    canonical file (via huggingface_hub.login). Returns the updated
    cascade state."""
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="token must be non-empty")
    from services import token_resolver
    try:
        token_resolver.save_app_token(token)
    except Exception:
        logger.exception("save_app_token failed")
        raise HTTPException(status_code=500, detail="Failed to save HF token")
    return _state_response()


@router.delete("/hf-token")
def clear_hf_token(also_clear_hf_cli: bool = Query(False)):
    """Clear the App-source token. Optionally also call huggingface_hub.logout
    to clear the canonical HF file. Returns the updated cascade state."""
    from services import token_resolver
    try:
        token_resolver.clear_app_token(also_clear_hf_cli=also_clear_hf_cli)
    except Exception:
        logger.exception("clear_app_token failed")
        raise HTTPException(status_code=500, detail="Failed to clear HF token")
    return _state_response()


@router.get("/hf-token/state")
def get_hf_token_state():
    """3-source HF token cascade state for the Settings UI."""
    return _state_response()


# ── Performance settings (INST-12) ────────────────────────────────────────
# Threat T-02-04: same loopback guard as the hf-token endpoints via the
# router-level `require_loopback` dep.


_TORCH_COMPILE_KEY = "perf.torch_compile_disabled"


class _TorchCompileBody(BaseModel):
    enabled: bool = Field(..., description="True to set TORCH_COMPILE_DISABLE=1 on engine subprocesses")


def _torch_compile_state() -> dict:
    import sys
    from services import settings_store

    raw = settings_store.get_text(_TORCH_COMPILE_KEY, "0")
    return {"enabled": raw == "1", "platform": sys.platform}


@router.get("/perf/torch-compile-disabled")
def get_torch_compile_disabled():
    """Return the current torch.compile-disabled toggle + the runtime platform.
    UI uses the platform to render the toggle disabled (with an explainer)
    on non-Windows hosts, since the OOM is Windows-specific (issue #65)."""
    return _torch_compile_state()


@router.put("/perf/torch-compile-disabled")
def set_torch_compile_disabled(body: _TorchCompileBody):
    """Persist the toggle. Honoured by `services.engine_env.build_engine_env()`
    which injects TORCH_COMPILE_DISABLE=1 on Windows when enabled."""
    from services import settings_store

    try:
        settings_store.set_text(_TORCH_COMPILE_KEY, "1" if body.enabled else "0")
    except Exception:
        logger.exception("set_torch_compile_disabled failed")
        raise HTTPException(status_code=500, detail="Failed to persist setting")
    return _torch_compile_state()


# ── License acceptance (Phase 3 Plan 03-01 / TTS-05) ──────────────────────
# Frontend ``SupertonicLicenseDialog`` flips the engine-license bit via this
# endpoint. The handler is loopback-gated (router-level dep) and the
# engine_id is allow-listed so an arbitrary string cannot be persisted.
# Threat T-03-04 in the plan frontmatter: this is an honest-acknowledgment
# gate, not a security boundary; the loopback + allow-list keeps the
# attack surface tight regardless.


#: Engines that have an in-tree acceptance dialog. Adding a new engine
#: here means adding a corresponding frontend dialog + a license URLs
#: dict in its constants module. Until that, the API refuses the write.
_LICENSE_ALLOWED_ENGINES: frozenset[str] = frozenset({"supertonic3"})


class _LicenseAcceptBody(BaseModel):
    engine_id: str = Field(..., min_length=1, max_length=64)
    accepted: bool = Field(..., description="True to accept the license terms")


@router.post("/license")
def post_license_acceptance(body: _LicenseAcceptBody) -> dict:
    """Persist a per-engine license-acceptance boolean.

    Returns ``{"ok": True, "engine_id": ..., "accepted": ...}`` so the
    caller can update its UI without a second round-trip. Validation:
    ``engine_id`` must be in the in-tree allow-list ‑‑ refuses arbitrary
    keys so the settings table can't be polluted via this route.
    """
    eid = body.engine_id.strip().lower()
    if eid not in _LICENSE_ALLOWED_ENGINES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"engine_id {eid!r} is not in the license allow-list "
                f"{sorted(_LICENSE_ALLOWED_ENGINES)}"
            ),
        )
    from services import settings_store
    try:
        settings_store.set_license_accepted(eid, body.accepted)
    except Exception:
        logger.exception("set_license_accepted failed for %s", eid)
        raise HTTPException(status_code=500, detail="Failed to persist license acceptance")
    return {"ok": True, "engine_id": eid, "accepted": bool(body.accepted)}


@router.get("/license/{engine_id}")
def get_license_acceptance(engine_id: str) -> dict:
    """Return ``{"engine_id": ..., "accepted": bool}``.

    Same allow-list as the POST handler so an unknown engine id is a
    400 rather than a silent ``accepted=false`` for a non-existent
    engine.
    """
    eid = engine_id.strip().lower()
    if eid not in _LICENSE_ALLOWED_ENGINES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"engine_id {eid!r} is not in the license allow-list "
                f"{sorted(_LICENSE_ALLOWED_ENGINES)}"
            ),
        )
    from services import settings_store
    try:
        accepted = settings_store.get_license_accepted(eid)
    except Exception:
        logger.exception("get_license_accepted failed for %s", eid)
        raise HTTPException(status_code=500, detail="Failed to read license acceptance")
    return {"engine_id": eid, "accepted": bool(accepted)}
