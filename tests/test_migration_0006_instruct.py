"""Migration 0006 heals voice_profiles.instruct poisoned with the
"[object Object]" sentinel (#550 #545 #542 #537 #530 #525). Drives alembic on a
temp SQLite DB, mirroring tests/test_profile_consent.py's migration harness."""
import os
import sqlite3

# A pre-0003 voice_profiles — the shape the alembic chain expects to upgrade
# (matches tests/test_profile_consent.py::_PRE_CONSENT_PROFILES).
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


def _run_alembic_upgrade(db_path: str, target: str = "head") -> None:
    from alembic import command
    from alembic.config import Config

    root = os.path.abspath(os.path.dirname(__file__))
    while root and root != "/" and not os.path.isfile(os.path.join(root, "alembic.ini")):
        root = os.path.dirname(root)
    assert os.path.isfile(os.path.join(root, "alembic.ini")), "alembic.ini not found"
    cfg = Config(os.path.join(root, "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    command.upgrade(cfg, target)


def test_migration_0006_heals_object_object_instruct(tmp_path):
    db = tmp_path / "poisoned.db"
    with sqlite3.connect(str(db)) as conn:
        conn.executescript(_BASE_PROFILES)
        # a poisoned row (the #550 bug) + a healthy row that must be untouched
        conn.execute(
            "INSERT INTO voice_profiles(id, name, instruct) VALUES ('vp-bad', 'Bad', '[object Object]')"
        )
        conn.execute(
            "INSERT INTO voice_profiles(id, name, instruct) VALUES ('vp-ok', 'Ok', 'male, high pitch')"
        )
        conn.commit()

    _run_alembic_upgrade(str(db))

    with sqlite3.connect(str(db)) as conn:
        rows = dict(conn.execute("SELECT id, instruct FROM voice_profiles").fetchall())
    assert rows["vp-bad"] == "", "0006 must clear the [object Object] sentinel"
    assert rows["vp-ok"] == "male, high pitch", "0006 must not touch healthy instruct values"
