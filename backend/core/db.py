import re
import sqlite3
import logging
from contextlib import contextmanager
from core.config import DB_PATH

logger = logging.getLogger("omnivoice.db")

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_TYPE_RE = re.compile(r"^[A-Za-z0-9_ '\"\(\)\-\.]+$")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db_conn():
    """Context-managed SQLite connection that commits on clean exit and always closes."""
    conn = get_db()
    try:
        yield conn
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


_BASE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS voice_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ref_audio_path TEXT,
        ref_text TEXT DEFAULT '',
        instruct TEXT DEFAULT '',
        language TEXT DEFAULT 'Auto',
        locked_audio_path TEXT DEFAULT '',
        seed INTEGER DEFAULT NULL,
        is_locked INTEGER DEFAULT 0,
        created_at REAL
    );
    CREATE TABLE IF NOT EXISTS generation_history (
        id TEXT PRIMARY KEY,
        text TEXT,
        mode TEXT,
        language TEXT,
        instruct TEXT,
        profile_id TEXT,
        audio_path TEXT,
        duration_seconds REAL,
        generation_time REAL,
        seed INTEGER DEFAULT NULL,
        created_at REAL,
        FOREIGN KEY (profile_id) REFERENCES voice_profiles(id)
    );
    CREATE TABLE IF NOT EXISTS dub_history (
        id TEXT PRIMARY KEY,
        filename TEXT,
        duration REAL,
        segments_count INTEGER,
        language TEXT,
        language_code TEXT,
        tracks TEXT DEFAULT '[]',
        job_data TEXT,
        content_hash TEXT DEFAULT '',
        created_at REAL
    );
    CREATE TABLE IF NOT EXISTS studio_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        video_path TEXT,
        audio_path TEXT,
        duration REAL,
        state_json TEXT,
        created_at REAL,
        updated_at REAL
    );
    CREATE TABLE IF NOT EXISTS export_history (
        id TEXT PRIMARY KEY,
        filename TEXT,
        destination_path TEXT,
        mode TEXT,
        created_at REAL
    );
"""

# Only tables/columns this module is allowed to ALTER. Prevents SQL injection via
# the f-string ALTER below if these helpers ever get exposed to user input.
_ALLOWED_MIGRATIONS = {
    ("voice_profiles", "locked_audio_path"),
    ("voice_profiles", "seed"),
    ("voice_profiles", "is_locked"),
    ("generation_history", "seed"),
    ("dub_history", "content_hash"),
}


def _add_column_if_missing(conn, table: str, column: str, typedef: str):
    if (table, column) not in _ALLOWED_MIGRATIONS:
        raise ValueError(f"Migration not allowed: {table}.{column}")
    if not _IDENT_RE.match(table) or not _IDENT_RE.match(column):
        raise ValueError(f"Invalid identifier: {table}.{column}")
    if not _TYPE_RE.match(typedef):
        raise ValueError(f"Invalid typedef: {typedef!r}")
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {typedef}")
    except sqlite3.OperationalError as e:
        if "duplicate column" not in str(e).lower():
            logger.warning("ALTER %s.%s failed: %s", table, column, e)


def _migrate(conn, current: int) -> int:
    """Apply migrations sequentially. Return new version."""
    if current < 1:
        _add_column_if_missing(conn, "voice_profiles", "locked_audio_path", "TEXT DEFAULT ''")
        _add_column_if_missing(conn, "voice_profiles", "seed", "INTEGER DEFAULT NULL")
        _add_column_if_missing(conn, "voice_profiles", "is_locked", "INTEGER DEFAULT 0")
        _add_column_if_missing(conn, "generation_history", "seed", "INTEGER DEFAULT NULL")
        current = 1
    if current < 2:
        _add_column_if_missing(conn, "dub_history", "content_hash", "TEXT DEFAULT ''")
        current = 2
    # Future migrations: if current < 3: ...; current = 3
    return current


def init_db():
    conn = get_db()
    try:
        conn.executescript(_BASE_SCHEMA)
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        new_version = _migrate(conn, version)
        if new_version != version:
            conn.execute(f"PRAGMA user_version = {new_version}")
        conn.commit()
    finally:
        conn.close()
