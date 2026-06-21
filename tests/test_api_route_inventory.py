"""Backend API surface coverage — the whole route inventory in one guard.

Two layers, both reusable across the project:

1. **Snapshot diff** — the live FastAPI app's full route list must equal the
   committed snapshot (`tests/fixtures/api_routes.txt`). Any endpoint that is
   added, removed, renamed, or has its methods changed fails here, so the API
   surface can never drift silently. Intentional changes: regenerate with
   `uv run python scripts/dump_api_routes.py` and commit.

2. **Critical-endpoint guard** — a hardcoded set of must-exist endpoints (the
   features every platform's prod use depends on: health, generate, profiles,
   dub pipeline, engines, gallery, settings, OpenAI-compat, websockets). This
   can't be satisfied by carelessly regenerating the snapshot — the features
   themselves have to be present.

Boots the app in-process with `OMNIVOICE_MODEL=test` (no 2.4 GB model load),
the same convention as tests/test_router_smoke.py.
"""
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "scripts"))
from dump_api_routes import route_lines, SNAPSHOT  # noqa: E402


@pytest.fixture(scope="module")
def app():
    # Purge cached backend modules so OMNIVOICE_* env is read fresh (mirrors
    # tests/smoke/test_boot_smoke.py).
    for mod in list(sys.modules):
        if mod == "main" or mod == "core" or mod.startswith(("core.", "api.", "services.")):
            sys.modules.pop(mod, None)
    sys.path.insert(0, str(_REPO / "backend"))
    from main import app as _app
    return _app


# Features that MUST stay reachable — grouped by surface. Each entry is
# "METHODS /path" exactly as the snapshot encodes it (one method shown is
# enough; the snapshot diff covers the full method set).
_CRITICAL = [
    # liveness / system
    "GET /health",
    "GET /system/info",
    "GET /model/status",
    # TTS generation + history
    "POST /generate",
    "GET /history",
    # voice profiles (clone + design CRUD)
    "GET /profiles",
    "POST /profiles",
    "PUT /profiles/{profile_id}",
    "DELETE /profiles/{profile_id}",
    # voice design
    "POST /design/describe",
    # dubbing pipeline (upload → transcribe → generate → export)
    "POST /dub/upload",
    "POST /dub/ingest-url",
    "POST /dub/generate/{job_id}",
    "POST /dub/translate",
    # engines + models
    "GET /engines",
    "POST /engines/select",
    # gallery + archetypes
    "GET /gallery/voices",
    "GET /archetypes",
    # audiobook + stories + batch
    "POST /audiobook",
    "POST /stories/encode",
    "POST /batch/enqueue",
    # transcription / dictation
    "POST /transcribe",
    # settings (HF token, license)
    "GET /api/settings/hf-token/state",
    # OpenAI-compatible API
    "POST /v1/audio/speech",
    "POST /v1/audio/transcriptions",
    # realtime websockets
    "WS /ws/events",
    "WS /ws/tts",
    "WS /ws/transcribe",
]


def _live(app):
    return set(route_lines(app))


def test_route_inventory_matches_snapshot(app):
    assert SNAPSHOT.is_file(), (
        f"Missing route snapshot {SNAPSHOT} — run "
        "`uv run python scripts/dump_api_routes.py`."
    )
    snap = {
        ln.strip()
        for ln in SNAPSHOT.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.startswith("#")
    }
    live = _live(app)
    missing = sorted(snap - live)   # in snapshot but gone from the app
    added = sorted(live - snap)     # in the app but not yet snapshotted
    msg = []
    if missing:
        msg.append("Routes REMOVED/renamed since the snapshot (regression?):\n  "
                   + "\n  ".join(missing))
    if added:
        msg.append("Routes ADDED but not in the snapshot:\n  " + "\n  ".join(added))
    if msg:
        msg.append(
            "\nIf this change is intentional, regenerate the snapshot:\n"
            "  OMNIVOICE_MODEL=test uv run python scripts/dump_api_routes.py\n"
            "and commit tests/fixtures/api_routes.txt."
        )
        pytest.fail("\n\n".join(msg))


@pytest.mark.parametrize("entry", _CRITICAL, ids=lambda e: e.replace(" ", "_"))
def test_critical_endpoint_present(app, entry):
    """Each must-exist feature endpoint is registered (method-aware)."""
    method, path = entry.split(" ", 1)
    live_paths = {ln.split(" ", 1)[1] for ln in _live(app)}
    assert path in live_paths, f"Critical endpoint missing entirely: {path}"
    # method check: find the snapshot/live line(s) for this path and confirm
    # the method is served (WS lines carry "WS").
    served = set()
    for ln in _live(app):
        m, p = ln.split(" ", 1)
        if p == path:
            served.update(m.split(","))
    assert method in served, (
        f"{path} exists but does not serve {method} (serves: {sorted(served)})"
    )


def test_route_count_is_sane(app):
    """A floor so a broken router-mount (silently dropping routes) is caught
    even if the snapshot were regenerated against the breakage."""
    assert len(_live(app)) >= 180, (
        f"Only {len(_live(app))} routes registered — a router likely failed to "
        "mount. Expected 200+."
    )
