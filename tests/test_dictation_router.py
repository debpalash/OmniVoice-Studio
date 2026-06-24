"""
Tests for the dictation router (GET /dictation/models, GET/POST /dictation/prefs)
— the exact contract the frontend dictation UI binds to.
"""
import os

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    # Import the app first (it pulls in core.prefs for real), then patch the
    # REAL core.prefs get/set_ functions with an in-memory store so the test
    # never touches the real prefs.json (and is immune to reference-swap order).
    from main import app
    store: dict = {}
    # Patch the prefs object the dictation handler actually holds (its own
    # module-level `prefs` reference), so the test is immune to any prior
    # test that swapped sys.modules["core.prefs"].
    from api.routers import dictation as dr
    monkeypatch.setattr(dr.prefs, "get", lambda k, d=None: store.get(k, d))
    monkeypatch.setattr(dr.prefs, "set_", lambda k, v: store.__setitem__(k, v))
    c = TestClient(app, client=("127.0.0.1", 50000))
    c._store = store
    return c


def test_list_models_shape(client):
    r = client.get("/dictation/models")
    assert r.status_code == 200
    body = r.json()
    assert body["default_model_id"] == "sherpa-parakeet-tdt-v3"
    assert len(body["models"]) == 7
    keys = {"id", "repo_id", "label", "tag", "recommended", "size_gb",
            "languages", "kind", "installed"}
    for m in body["models"]:
        assert keys <= set(m), f"missing keys in {m}"
        assert m["tag"] in ("offline", "streaming")
    rec = [m for m in body["models"] if m["recommended"]]
    assert [m["id"] for m in rec] == ["sherpa-parakeet-tdt-v3"]


def test_get_prefs_defaults(client):
    r = client.get("/dictation/prefs")
    assert r.status_code == 200
    body = r.json()
    assert body == {"enabled": True, "mode": "toggle",
                    "model_id": "sherpa-parakeet-tdt-v3"}


def test_set_prefs_persists_and_validates(client):
    r = client.post("/dictation/prefs", json={
        "enabled": False, "mode": "hold", "model_id": "sherpa-whisper-tiny"})
    assert r.status_code == 200
    body = r.json()
    assert body == {"enabled": False, "mode": "hold",
                    "model_id": "sherpa-whisper-tiny"}
    # Persistence: a follow-up GET sees the written values (round-trips through
    # the store the handler actually used — robust to prefs-reference swaps).
    got = client.get("/dictation/prefs").json()
    assert got == {"enabled": False, "mode": "hold",
                   "model_id": "sherpa-whisper-tiny"}

    # Bad mode rejected.
    assert client.post("/dictation/prefs", json={"mode": "nope"}).status_code == 400
    # Bad model rejected.
    assert client.post("/dictation/prefs", json={"model_id": "nope"}).status_code == 400


def test_set_prefs_accepts_repo_id_and_normalizes(client):
    r = client.post("/dictation/prefs",
                    json={"model_id": "csukuangfj/sherpa-onnx-whisper-tiny"})
    assert r.status_code == 200
    # Stored as the canonical dictation id, not the repo_id.
    assert r.json()["model_id"] == "sherpa-whisper-tiny"
