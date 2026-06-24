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
        personality TEXT DEFAULT '',
        description TEXT DEFAULT '',
        is_demo INTEGER DEFAULT 0,
        verified_own_voice INTEGER DEFAULT 0,
        consent_text TEXT DEFAULT '',
        consent_audio_path TEXT DEFAULT '',
        consent_recorded_at REAL DEFAULT NULL,
        kind TEXT DEFAULT 'clone',
        vd_states TEXT DEFAULT NULL,
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
    CREATE TABLE IF NOT EXISTS glossary_terms (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        note TEXT DEFAULT '',
        auto INTEGER DEFAULT 0,
        created_at REAL
    );
    CREATE INDEX IF NOT EXISTS idx_glossary_project ON glossary_terms(project_id);

    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        finished_at REAL,
        error TEXT,
        meta_json TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

    CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at REAL NOT NULL,
        payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job_seq ON job_events(job_id, seq);

    -- Phase 1 AUTH-02: encrypted per-install key/value store. Used today
    -- for the HF token row + the per-install Fernet salt. Both fresh
    -- installs (this CREATE) and v0.2.7 upgrades (alembic
    -- 0001_phase1_settings) converge on the same schema.
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at REAL NOT NULL
    );

    -- Wave 2.2: per-agent MCP voice bindings. An MCP client (Claude Code,
    -- Cursor, …) identified by the X-OmniVoice-Client-Id header it sends is
    -- bound to a default voice profile / engine. Fresh installs create it
    -- here; v0.3.x upgrades get it via alembic 0004.
    CREATE TABLE IF NOT EXISTS mcp_client_bindings (
        client_id TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        profile_id TEXT,
        default_engine TEXT,
        last_seen_at REAL,
        created_at REAL
    );

    -- Expressive-TTS Spec 01 Phase 1: user pronunciation dictionary. A
    -- per-language word→respelling map applied as pure text substitution
    -- before synthesis (Settings → Pronunciation). Fresh installs create it
    -- here; existing DBs get it via alembic 0008_pronunciation_dictionary.
    -- Both paths converge on this identical schema (dual-path discipline).
    CREATE TABLE IF NOT EXISTS pronunciation_entries (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        replacement TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'respelling',
        language TEXT NOT NULL DEFAULT '*',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at REAL
    );
    CREATE INDEX IF NOT EXISTS idx_pron_lang ON pronunciation_entries(language);
"""

# Only tables/columns this module is allowed to ALTER. Prevents SQL injection via
# the f-string ALTER below if these helpers ever get exposed to user input.
_ALLOWED_MIGRATIONS = {
    ("voice_profiles", "locked_audio_path"),
    ("voice_profiles", "seed"),
    ("voice_profiles", "is_locked"),
    ("voice_profiles", "personality"),
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
    # v3: glossary_terms table lives in _BASE_SCHEMA (IF NOT EXISTS), so an old
    # DB simply picks it up on the next init — no ALTER needed.
    if current < 3:
        current = 3
    if current < 4:
        _add_column_if_missing(conn, "voice_profiles", "personality", "TEXT DEFAULT ''")
        current = 4
    return current


def _reconcile_additive_columns(conn) -> None:
    """Make the live schema converge to ``_BASE_SCHEMA`` by ADDing any column the
    canonical schema declares but an existing table is missing — the belt for
    when alembic can't run on an upgraded DB.

    ``CREATE TABLE IF NOT EXISTS`` (init_db) never adds columns to a table that
    already exists, the legacy ``_migrate`` only knows pre-0.3 columns, and
    ``_run_alembic_upgrade`` swallows failures. So a DB whose ``alembic_version``
    is stamped at a removed revision (e.g. after running a preview build), or
    where alembic isn't importable in the bundled interpreter, would otherwise
    lose every alembic-era additive column forever — the ``no such column:
    consent_audio_path`` 500 (#552/#547), and the same class for
    ``kind``/``vd_states``/``is_demo``/.... Additive only: never drops or retypes
    a column, so it is safe and backward-compatible with existing user data. The
    canonical names/types/defaults come solely from ``_BASE_SCHEMA`` (developer
    controlled), so the ALTER is injection-safe.
    """
    canon = sqlite3.connect(":memory:")
    try:
        canon.executescript(_BASE_SCHEMA)
        _tables_sql = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        live_tables = {r[0] for r in conn.execute(_tables_sql)}
        for table in (r[0] for r in canon.execute(_tables_sql)):
            if table not in live_tables:
                continue  # whole table missing → init_db's CREATE already made it
            have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            # (cid, name, type, notnull, dflt_value, pk)
            for _cid, name, ctype, notnull, dflt, _pk in canon.execute(f"PRAGMA table_info({table})"):
                if name in have or not _IDENT_RE.match(name):
                    continue
                ddl = f'ALTER TABLE "{table}" ADD COLUMN "{name}" {ctype or "TEXT"}'
                if dflt is not None:
                    ddl += f" DEFAULT {dflt}"
                elif notnull:
                    ddl += " DEFAULT ''"  # SQLite requires a default to ADD a NOT NULL column
                try:
                    conn.execute(ddl)
                    logger.info("schema reconcile: added missing column %s.%s", table, name)
                except sqlite3.OperationalError as exc:
                    if "duplicate column" not in str(exc).lower():
                        logger.warning("schema reconcile ALTER %s.%s failed: %s", table, name, exc)
        conn.commit()
    finally:
        canon.close()


def init_db():
    conn = get_db()
    try:
        conn.executescript(_BASE_SCHEMA)
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        new_version = _migrate(conn, version)
        if new_version != version:
            conn.execute(f"PRAGMA user_version = {new_version}")
        # Converge any alembic-era additive columns that CREATE TABLE IF NOT
        # EXISTS + the legacy _migrate don't add to a pre-existing table
        # (consent_audio_path, kind, ...). Runs regardless of whether alembic
        # below succeeds, so an unrunnable alembic can't leave a 500-ing schema.
        _reconcile_additive_columns(conn)
        conn.commit()
    finally:
        conn.close()
    # Phase 1: also run any pending alembic migrations. Fresh installs land
    # the schema via _BASE_SCHEMA above; v0.2.7 → v0.3.0 upgrades pick up
    # the same end-state via the alembic versions/ chain. Both paths
    # converge because every migration uses `CREATE TABLE IF NOT EXISTS`
    # or explicit existence checks.
    _run_alembic_upgrade()


def _run_alembic_upgrade() -> None:
    """Best-effort `alembic upgrade head` on startup. Non-fatal: if alembic
    isn't reachable (e.g. a stripped-down install) or its version is stamped at
    a revision no longer in versions/ (e.g. after running a preview build), log
    a warning and move on. The schema is still kept correct by
    _reconcile_additive_columns (run in init_db above and again here on failure)
    — CREATE TABLE IF NOT EXISTS alone does NOT add columns to a pre-existing
    table, so the reconcile is what actually guarantees additive columns land."""
    try:
        import os
        from alembic import command
        from alembic.config import Config

        # Walk up from backend/core/db.py to find the alembic.ini at the
        # project root.
        here = os.path.dirname(os.path.abspath(__file__))
        root = os.path.dirname(os.path.dirname(here))
        ini = os.path.join(root, "alembic.ini")
        if not os.path.isfile(ini):
            logger.debug("alembic.ini not found at %s; skipping migrations", ini)
            return
        cfg = Config(ini)
        cfg.set_main_option("sqlalchemy.url", f"sqlite:///{DB_PATH}")
        command.upgrade(cfg, "head")
    except Exception as exc:
        # Don't block startup on a migration tooling problem. Converge the schema
        # directly so a swallowed failure (alembic not importable, or
        # alembic_version stamped at a removed revision) still lands the additive
        # columns instead of 500-ing on `no such column` (#552/#547).
        logger.warning("alembic upgrade head skipped: %s", exc)
        try:
            conn = get_db()
            try:
                _reconcile_additive_columns(conn)
            finally:
                conn.close()
        except Exception as exc2:  # noqa: BLE001
            logger.warning("schema reconcile after alembic failure also failed: %s", exc2)
