"""Tests for the compute-device override endpoints (Settings → Performance).

Covers the API contract of GET/PUT /api/settings/compute-device:
  - GET reports the resolved pick, what this process applied, and the host's
    available families (the UI renders only those + Auto).
  - PUT persists a valid pick to prefs.json and echoes the new state with
    restart_required=True (caps are immutable per process).
  - PUT rejects unknown values and accelerators this host doesn't have —
    a silent no-op pick would read as "the setting doesn't work".
  - An OMNIVOICE_DEVICE env pin is reported (env_pinned) and wins over PUT.
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture
def fresh_app(monkeypatch, tmp_path):
    """Same isolation pattern as tests/backend/test_perf_settings.py."""
    monkeypatch.setenv("OMNIVOICE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("OMNIVOICE_DEVICE", raising=False)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)

    for mod in list(sys.modules):
        if (
            mod == "core" or mod.startswith("core.")
            or mod == "services" or mod.startswith("services.")
            or mod == "api" or mod.startswith("api.")
        ):
            del sys.modules[mod]

    from core import db as _db
    _db.init_db()

    from fastapi import FastAPI
    from api.routers import settings as settings_router

    app = FastAPI()
    app.include_router(settings_router.router)
    return app


def _client(app):
    from fastapi.testclient import TestClient
    return TestClient(app, client=("127.0.0.1", 12345))


def test_get_reports_state_and_families(fresh_app):
    c = _client(fresh_app)
    r = c.get("/api/settings/compute-device")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] in body["choices"]
    assert "cpu" in body["available_families"]  # invariant: cpu always present
    assert body["effective_family"] in body["available_families"]
    assert isinstance(body["env_pinned"], bool)


def test_put_persists_and_flags_restart(fresh_app):
    c = _client(fresh_app)
    r = c.put("/api/settings/compute-device", json={"value": "cpu"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] == "cpu"
    # Caps are cached per process: the pick applies at next start, and the
    # endpoint must say so instead of pretending it already did.
    assert body["restart_required"] is True

    from core import prefs
    assert prefs.resolve("compute_device", default="auto") == "cpu"

    # auto round-trips back
    r = c.put("/api/settings/compute-device", json={"value": "auto"})
    assert r.status_code == 200
    assert r.json()["value"] == "auto"


def test_put_rejects_unknown_and_unavailable_values(fresh_app):
    c = _client(fresh_app)
    r = c.put("/api/settings/compute-device", json={"value": "quantum"})
    assert r.status_code == 400
    assert "Valid:" in r.json()["detail"]

    # Find an accelerator this host does NOT have (CI hosts are cpu-only,
    # but don't assume — pick from the full choice list minus available).
    state = c.get("/api/settings/compute-device").json()
    missing = [
        f for f in state["choices"]
        if f not in ("auto", "cpu") and f not in state["available_families"]
    ]
    if missing:
        r = c.put("/api/settings/compute-device", json={"value": missing[0]})
        assert r.status_code == 400
        assert "not available" in r.json()["detail"]


def test_env_pin_is_reported_and_wins(fresh_app, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DEVICE", "cpu")
    c = _client(fresh_app)
    state = c.get("/api/settings/compute-device").json()
    assert state["env_pinned"] is True
    assert state["value"] == "cpu"

    # A PUT still persists (for after the pin is removed) but the resolved
    # value stays the env's — the UI disables the control and shows the pin.
    r = c.put("/api/settings/compute-device", json={"value": "auto"})
    assert r.status_code == 200
    assert r.json()["value"] == "cpu"
