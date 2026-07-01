"""#710: a synth 500 'no such table: generation_history'.

The clip is already generated + saved before the history INSERT, so a DB that
missed schema init must not 500 the user's generation. `ensure_schema()` is the
runtime self-heal: idempotently (re)create the base tables + additive columns so
the write can retry, and the generation route returns the audio either way.

These tests redirect the DB by patching `core.db.get_db` (which `db_conn` and
`ensure_schema` both call) rather than the `DB_PATH` global — the global proved
flaky across the full suite when an earlier test leaves it repointed.
"""
import sqlite3

import pytest

import core.db as _db
from core.db import ensure_schema, db_conn


def _connect(path):
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """Every core.db connection goes to a throwaway file for the test."""
    path = tmp_path / "test.db"
    monkeypatch.setattr(_db, "get_db", lambda: _connect(path))
    return path


def _tables(path):
    with sqlite3.connect(str(path)) as conn:
        return {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}


def _seed_missing_history(path):
    """A DB that missed init — only voice_profiles, no generation_history."""
    with _connect(path) as conn:
        conn.execute("CREATE TABLE voice_profiles (id TEXT PRIMARY KEY, name TEXT)")
        conn.commit()


def test_ensure_schema_creates_missing_generation_history(temp_db):
    _seed_missing_history(temp_db)
    assert "generation_history" not in _tables(temp_db)

    ensure_schema()
    assert "generation_history" in _tables(temp_db)


def test_history_insert_self_heals_after_ensure_schema(temp_db):
    """Fail-before / heal / pass-after — the exact #710 recovery contract."""
    _seed_missing_history(temp_db)

    # BEFORE heal: the write raises exactly the #710 error.
    with pytest.raises(sqlite3.OperationalError, match="no such table: generation_history"):
        with db_conn() as conn:
            conn.execute("INSERT INTO generation_history (id, created_at) VALUES ('x', 1.0)")

    # AFTER heal: the same write succeeds.
    ensure_schema()
    with db_conn() as conn:
        conn.execute("INSERT INTO generation_history (id, created_at) VALUES ('x', 1.0)")
    with _connect(temp_db) as conn:
        assert conn.execute("SELECT id FROM generation_history").fetchone()[0] == "x"


def test_ensure_schema_is_idempotent(temp_db):
    ensure_schema()
    ensure_schema()  # second call must be a clean no-op
    assert "generation_history" in _tables(temp_db)
