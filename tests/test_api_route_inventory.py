"""Backend API surface coverage — the whole route inventory in one guard.

Two layers, both reusable across the project:

1. **Snapshot diff** — the live FastAPI app's router endpoints must equal the
   committed snapshot (`tests/fixtures/api_routes.txt`). Any endpoint added,
   removed, renamed, or with changed methods fails here, so the API surface can
   never drift silently. Intentional changes: regenerate with
   `uv run python scripts/dump_api_routes.py` and commit.

2. **Critical-endpoint guard** — a hardcoded set of must-exist endpoints (the
   features every platform's prod use depends on). This can't be satisfied by
   carelessly regenerating the snapshot — the features have to be present.

The route list is computed in a SUBPROCESS (`scripts/dump_api_routes.py
--print`) so importing the app never pollutes this pytest process's
`sys.modules` — which would break later DB-touching tests. The subprocess uses
the same code path as snapshot generation, so the comparison is deterministic
(no in-process / cross-platform skew). `OMNIVOICE_MODEL=test` skips the 2.4 GB
model load.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "scripts"))
from dump_api_routes import SNAPSHOT  # noqa: E402


@pytest.fixture(scope="module")
def live_routes():
    """Route lines from a fresh subprocess — fully isolated from this process."""
    env = dict(os.environ, OMNIVOICE_MODEL="test", OMNIVOICE_DISABLE_FILE_LOG="1")
    proc = subprocess.run(
        [sys.executable, str(_REPO / "scripts" / "dump_api_routes.py"), "--print"],
        cwd=str(_REPO), env=env, capture_output=True, text=True, timeout=180,
    )
    assert proc.returncode == 0, f"route dump failed:\n{proc.stderr}"
    return {ln.strip() for ln in proc.stdout.splitlines() if ln.strip()}


# Features that MUST stay reachable. Each entry is "METHOD /path" exactly as the
# snapshot encodes it (the snapshot diff covers the full method set).
_CRITICAL = [
    "GET /health", "GET /system/info", "GET /model/status",
    "POST /generate", "GET /history",
    "GET /profiles", "POST /profiles", "PUT /profiles/{profile_id}",
    "DELETE /profiles/{profile_id}", "POST /design/describe",
    "POST /dub/upload", "POST /dub/ingest-url", "POST /dub/generate/{job_id}",
    "POST /dub/translate",
    "GET /engines", "POST /engines/select",
    "GET /gallery/voices", "GET /archetypes",
    "POST /audiobook", "POST /stories/encode", "POST /batch/enqueue",
    "POST /transcribe", "GET /api/settings/hf-token/state",
    "POST /v1/audio/speech", "POST /v1/audio/transcriptions",
    "WS /ws/events", "WS /ws/tts", "WS /ws/transcribe",
]


def test_route_inventory_matches_snapshot(live_routes):
    assert SNAPSHOT.is_file(), (
        f"Missing route snapshot {SNAPSHOT} — run "
        "`uv run python scripts/dump_api_routes.py`."
    )
    snap = {
        ln.strip()
        for ln in SNAPSHOT.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.startswith("#")
    }
    missing = sorted(snap - live_routes)   # in snapshot but gone from the app
    added = sorted(live_routes - snap)     # in the app but not yet snapshotted
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
def test_critical_endpoint_present(live_routes, entry):
    """Each must-exist feature endpoint is registered (method-aware)."""
    method, path = entry.split(" ", 1)
    served = set()
    for ln in live_routes:
        m, p = ln.split(" ", 1)
        if p == path:
            served.update(m.split(","))
    assert served, f"Critical endpoint missing entirely: {path}"
    assert method in served, (
        f"{path} exists but does not serve {method} (serves: {sorted(served)})"
    )


def test_route_count_is_sane(live_routes):
    """A floor so a broken router-mount (silently dropping routes) is caught even
    if the snapshot were regenerated against the breakage."""
    assert len(live_routes) >= 180, (
        f"Only {len(live_routes)} routes registered — a router likely failed to "
        "mount. Expected 200+."
    )
