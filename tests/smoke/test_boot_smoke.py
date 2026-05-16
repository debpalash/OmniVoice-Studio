"""
PR-blocking smoke test (GATE-01).

Boots the FastAPI app in-process against the frozen regression fixture at
`tests/fixtures/omnivoice_data/` and asserts the lowest-cost endpoints
respond correctly. Designed to run in < 30 s on a warm uv cache so it can
sit on every PR across macOS / Windows / Linux without slowing reviewers.

Pattern source: `tests/test_router_smoke.py` (in-process TestClient + module
fixture). This file extends that pattern by pointing the backend at the
checked-in fixture via `OMNIVOICE_DATA_DIR`, so the smoke also validates
DB-touching paths (profiles list, history list) — not just route imports.

The 2.4 GB OmniVoice model load is short-circuited by `OMNIVOICE_MODEL=test`
(same convention as `test_router_smoke.py`).
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest


# ── env setup BEFORE any backend import ────────────────────────────────────
os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

FIXTURE_SRC = Path(__file__).resolve().parents[1] / "fixtures" / "omnivoice_data"
if not FIXTURE_SRC.exists():
    pytest.fail(
        "Fixture missing — run: uv run python scripts/seed-test-fixture.py",
        pytrace=False,
    )

# Copy the frozen fixture into a per-session temp dir so the smoke test
# never mutates the checked-in artifact. SQLite touches its file-change
# counter just on open, and the backend creates runtime subdirs
# (dub_jobs/, outputs/, preview/) under OMNIVOICE_DATA_DIR — both would
# show up as dirty in `git status` after every test run.
_FIXTURE_COPY = Path(tempfile.mkdtemp(prefix="omnivoice-smoke-"))
shutil.copytree(FIXTURE_SRC, _FIXTURE_COPY, dirs_exist_ok=True)

# Point backend.core.config.get_app_data_dir() at the COPY before any
# import that pulls in core.config (which caches DB_PATH at module import).
os.environ.setdefault("OMNIVOICE_DATA_DIR", str(_FIXTURE_COPY))


@pytest.fixture(scope="module")
def client():
    # Lazy import — env must be set before `core.config` is touched.
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app)


# ── tests ──────────────────────────────────────────────────────────────────
def test_health_returns_ok(client):
    """`/health` is the canonical liveness probe (release.yml uses it too)."""
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "device" in body


def test_profiles_endpoint_lists_fixture_voice(client):
    """The seeded voice_profiles row must surface via the public `/profiles` API."""
    r = client.get("/profiles")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert any(p.get("id") == "test-voice" for p in data), (
        f"expected fixture profile 'test-voice', got {data}"
    )


def test_system_info_includes_data_dir(client):
    """`/system/info` must resolve `data_dir` — smokes the fixture-wiring path."""
    r = client.get("/system/info")
    assert r.status_code == 200
    assert "data_dir" in r.json()


def test_history_endpoint_empty(client):
    """Fixture has zero history rows; the route must reach the DB and return []."""
    r = client.get("/history")
    assert r.status_code == 200
    assert r.json() == []
