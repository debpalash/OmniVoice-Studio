"""Per-agent MCP voice bindings (Wave 2.2) — service + resolution + migration.

The service layer is pure (db_conn over an isolated tmp DB), so these run
without importing `main`. The REST CRUD test uses a TestClient and is
validated in CI (local torch/Triton segfault on main-importing tests).
"""
import os
import sqlite3
import sys

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DATA_DIR", str(tmp_path))
    import importlib
    import core.config as _cfg
    importlib.reload(_cfg)
    import core.db as _db
    importlib.reload(_db)
    _db.init_db()
    import services.mcp_bindings as mb
    importlib.reload(mb)
    return mb


def test_upsert_creates_then_updates(db):
    b = db.upsert_binding("claude-code", label="Claude Code", profile_id="morgan")
    assert b["client_id"] == "claude-code"
    assert b["profile_id"] == "morgan"
    assert b["created_at"] is not None

    # Update only the profile; label preserved.
    b2 = db.upsert_binding("claude-code", profile_id="scarlett")
    assert b2["profile_id"] == "scarlett"
    assert b2["label"] == "Claude Code"


def test_empty_client_id_rejected(db):
    with pytest.raises(ValueError):
        db.upsert_binding("   ", profile_id="x")


def test_list_and_delete(db):
    db.upsert_binding("a", profile_id="p1")
    db.upsert_binding("b", profile_id="p2")
    assert {x["client_id"] for x in db.list_bindings()} == {"a", "b"}
    assert db.delete_binding("a") is True
    assert db.delete_binding("a") is False
    assert {x["client_id"] for x in db.list_bindings()} == {"b"}


def test_resolution_precedence(db):
    db.upsert_binding("cursor", profile_id="bound-voice")

    # Explicit arg wins over everything.
    r = db.resolve_voice("cursor", "explicit-voice")
    assert r == {"profile_id": "explicit-voice", "default_engine": None, "source": "explicit"}

    # No explicit → the client's binding.
    r = db.resolve_voice("cursor", None)
    assert r["profile_id"] == "bound-voice" and r["source"] == "binding"

    # Unknown client, no global default → none.
    r = db.resolve_voice("unknown", None)
    assert r["source"] == "none" and r["profile_id"] is None


def test_resolution_global_default(db, monkeypatch):
    from core import prefs
    monkeypatch.setattr(prefs, "get", lambda k, default=None: "global-voice" if k == "mcp_default_profile_id" else default)
    r = db.resolve_voice("no-binding-client", None)
    assert r == {"profile_id": "global-voice", "default_engine": None, "source": "global"}


def test_touch_last_seen_is_best_effort(db):
    db.upsert_binding("agent", profile_id="v")
    before = db.get_binding("agent")["last_seen_at"]
    assert before is None
    db.touch_last_seen("agent")
    assert db.get_binding("agent")["last_seen_at"] is not None
    # Never raises for an unknown client.
    db.touch_last_seen("ghost")


# ── Migration ───────────────────────────────────────────────────────────────

# Migrations 0002/0003 ALTER voice_profiles, so a realistic pre-0004 DB must
# carry it (plus settings, created by 0001). Mirrors the post-0001/pre-0002
# shape so the whole chain upgrades cleanly.
_PRE_0004 = """
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL);
    CREATE TABLE voice_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ref_audio_path TEXT,
        ref_text TEXT DEFAULT '',
        instruct TEXT DEFAULT '',
        language TEXT DEFAULT 'Auto',
        locked_audio_path TEXT DEFAULT '',
        seed INTEGER DEFAULT NULL,
        is_locked INTEGER DEFAULT 0,
        personality TEXT DEFAULT '',
        created_at REAL
    );
"""


def _run_alembic(direction, db_path, target="head"):
    from alembic import command
    from alembic.config import Config

    here = os.path.abspath(os.path.dirname(__file__))
    root = here
    while root and root != "/" and not os.path.isfile(os.path.join(root, "alembic.ini")):
        root = os.path.dirname(root)
    cfg = Config(os.path.join(root, "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    (command.upgrade if direction == "upgrade" else command.downgrade)(cfg, target)


def _tables(db_path):
    with sqlite3.connect(str(db_path)) as conn:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def test_migration_0004_adds_table(tmp_path):
    dbf = tmp_path / "pre.db"
    with sqlite3.connect(str(dbf)) as conn:
        conn.executescript(_PRE_0004)
        conn.commit()
    _run_alembic("upgrade", str(dbf))
    assert "mcp_client_bindings" in _tables(dbf)


def test_migration_0004_downgrade_drops_table(tmp_path):
    dbf = tmp_path / "pre.db"
    with sqlite3.connect(str(dbf)) as conn:
        conn.executescript(_PRE_0004)
        conn.commit()
    _run_alembic("upgrade", str(dbf))
    _run_alembic("downgrade", str(dbf), target="0003_voice_profile_consent")
    assert "mcp_client_bindings" not in _tables(dbf)


# ── REST CRUD (main-importing — CI only) ─────────────────────────────────────

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DATA_DIR", str(tmp_path))
    import importlib
    for m in ("core.config", "core.db", "services.mcp_bindings"):
        if m in sys.modules:
            importlib.reload(importlib.import_module(m))
    import core.db as _db
    _db.init_db()
    import main as _main
    importlib.reload(_main)
    from fastapi.testclient import TestClient
    # No `with` — running the lifespan rebinds module-level event-bus queues
    # to this loop and contaminates later lifespan tests (Wave 0.2 footgun).
    try:
        yield TestClient(_main.app, client=("127.0.0.1", 50000))
    finally:
        # Reloading main above poisons the global module for any later test
        # that does `from main import …`. Reload once more with the default
        # (project) data dir restored so the shared module is clean again.
        monkeypatch.undo()
        importlib.reload(importlib.import_module("core.config"))
        importlib.reload(importlib.import_module("core.db"))
        importlib.reload(_main)


def test_rest_crud_roundtrip(client):
    assert client.get("/api/mcp/bindings").json() == []
    r = client.put("/api/mcp/bindings", json={"client_id": "claude-code", "label": "CC", "profile_id": "morgan"})
    assert r.status_code == 200 and r.json()["profile_id"] == "morgan"
    assert len(client.get("/api/mcp/bindings").json()) == 1
    assert client.delete("/api/mcp/bindings/claude-code").status_code == 200
    assert client.delete("/api/mcp/bindings/claude-code").status_code == 404


def test_rest_rejects_empty_client_id(client):
    r = client.put("/api/mcp/bindings", json={"client_id": ""})
    assert r.status_code == 422  # pydantic min_length
