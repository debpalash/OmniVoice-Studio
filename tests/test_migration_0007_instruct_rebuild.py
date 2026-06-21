"""Migration 0007 rebuilds design-profile instructs that 0006 only blanked.

0006 clears the literal "[object Object]" sentinel (losing the designed voice);
0007 recovers the tags from vd_states so a designed female voice stays female
(#594) and prose-poisoned designs (#571 #596) stop 400-ing. Drives the real
alembic chain on a temp SQLite DB, mirroring tests/test_migration_0006_instruct.py.
"""
import importlib.util
import os
import sqlite3

# Pre-0003 voice_profiles shape the alembic chain upgrades (matches the 0006 test).
_BASE_PROFILES = """
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
        description TEXT DEFAULT '',
        is_demo INTEGER DEFAULT 0,
        created_at REAL
    );
"""


def _repo_root() -> str:
    root = os.path.abspath(os.path.dirname(__file__))
    while root and root != "/" and not os.path.isfile(os.path.join(root, "alembic.ini")):
        root = os.path.dirname(root)
    assert os.path.isfile(os.path.join(root, "alembic.ini")), "alembic.ini not found"
    return root


def _run_alembic_upgrade(db_path: str, target: str = "head") -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(_repo_root(), "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    command.upgrade(cfg, target)


def _load_migration_module():
    path = os.path.join(
        _repo_root(), "backend", "migrations", "versions",
        "0007_rebuild_poisoned_design_instruct.py",
    )
    spec = importlib.util.spec_from_file_location("_mig0007", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_frozen_whitelist_matches_canonical():
    """The migration's self-contained tag snapshot must not drift from the
    canonical whitelist — else it would heal against a stale vocabulary."""
    from omnivoice.utils.voice_design import _INSTRUCT_ALL_VALID

    mod = _load_migration_module()
    assert mod._ALL_VALID == set(_INSTRUCT_ALL_VALID)


def test_migration_0007_rebuilds_and_sanitizes(tmp_path):
    db = tmp_path / "poisoned.db"
    with sqlite3.connect(str(db)) as conn:
        conn.executescript(_BASE_PROFILES)
    conn.close()

    # Bring the schema up to where kind + vd_states exist, then seed rows.
    _run_alembic_upgrade(str(db), target="0005_unified_profiles")

    with sqlite3.connect(str(db)) as conn:
        rows = [
            # design, object-coerced: 0006 blanks it, 0007 rebuilds from vd_states.
            ("d-obj", "Obj", "design", "[object Object]",
             '{"gender":"female","age":"young adult","pitch":"high pitch"}'),
            # design, prose-poisoned (#596): 0006 leaves it, 0007 rebuilds.
            ("d-prose", "Prose", "design", "A gentle, quiet, and calm male voice",
             '{"gender":"female"}'),
            # design, already healthy: must be left untouched.
            ("d-ok", "Ok", "design", "female, high pitch",
             '{"gender":"female","pitch":"high pitch"}'),
            # clone, poisoned, no vd_states: sanitized to '' (no rebuild source).
            ("c-bad", "CloneBad", "clone", "[object Object]", None),
        ]
        conn.executemany(
            "INSERT INTO voice_profiles(id, name, kind, instruct, vd_states) "
            "VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    conn.close()

    _run_alembic_upgrade(str(db), target="head")

    with sqlite3.connect(str(db)) as conn:
        got = dict(conn.execute("SELECT id, instruct FROM voice_profiles").fetchall())
    conn.close()

    assert got["d-obj"] == "female, young adult, high pitch", \
        "0007 must recover the designed tags from vd_states after 0006 blanks the sentinel"
    assert got["d-prose"] == "female", \
        "prose poison must be dropped and the design recovered from vd_states (no 'male' leak)"
    assert got["d-ok"] == "female, high pitch", "healthy instruct must be untouched"
    assert got["c-bad"] == "", "clone poison sanitizes to empty (no vd_states to rebuild from)"
