"""Startup migration safety net (feat/safe-updates).

`core.db._run_alembic_upgrade` must:

- snapshot the DB *before* pending migrations run (and name the snapshot
  ``omnivoice.db.backup-<version>-<n>``),
- NOT snapshot when the DB is already at head (no churn on every launch),
- keep the pre-existing non-fatal behavior for the "nothing was applied"
  classes (#552/#547: stamped at a removed revision → warn + reconcile),
- and on a migration that fails WHILE executing: stop startup with
  ``MigrationError`` naming the backup path — never auto-restore, never
  continue on a half-migrated DB.
"""
import sqlite3

import pytest

from core import db_backup
from core.db import _BASE_SCHEMA, MigrationError, _run_alembic_upgrade, init_db


def _seed_user_db(path, stamp=None):
    """A user DB with real data (and optionally a stamped alembic revision).

    Seeds the full base schema — in the real startup order ``init_db`` lays
    ``_BASE_SCHEMA`` + reconcile *before* alembic runs, so this is what a
    pending-migration DB actually looks like."""
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript(_BASE_SCHEMA)
        conn.execute("INSERT INTO voice_profiles(id, name) VALUES ('vp-1', 'Alice')")
        if stamp is not None:
            conn.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
            conn.execute("INSERT INTO alembic_version VALUES (?)", (stamp,))
        conn.commit()
    finally:
        conn.close()


def _profile_names(path):
    conn = sqlite3.connect(str(path))
    try:
        return [r[0] for r in conn.execute("SELECT name FROM voice_profiles ORDER BY id")]
    finally:
        conn.close()


def test_pending_migrations_snapshot_first_then_upgrade(tmp_path, monkeypatch):
    """A DB behind head (here: never stamped) gets a backup, then migrates."""
    db = tmp_path / "omnivoice.db"
    _seed_user_db(db)
    monkeypatch.setattr("core.db.DB_PATH", str(db))

    _run_alembic_upgrade()

    backups = db_backup.list_backups(str(db))
    assert backups, "a pre-migration backup must exist"
    assert ".backup-" in backups[0]
    # The backup holds the PRE-migration data.
    assert _profile_names(backups[0]) == ["Alice"]
    # And the live DB migrated to head (alembic_version now stamped).
    conn = sqlite3.connect(str(db))
    try:
        stamped = [r[0] for r in conn.execute("SELECT version_num FROM alembic_version")]
    finally:
        conn.close()
    assert stamped, "upgrade must have stamped the DB at head"


def test_up_to_date_db_is_not_resnapshotted(tmp_path, monkeypatch):
    """Once at head, later launches must not churn new backups."""
    db = tmp_path / "omnivoice.db"
    _seed_user_db(db)
    monkeypatch.setattr("core.db.DB_PATH", str(db))

    _run_alembic_upgrade()
    first = db_backup.list_backups(str(db))
    _run_alembic_upgrade()  # second launch: already at head
    second = db_backup.list_backups(str(db))

    assert first == second, "no new backup when there is nothing to migrate"


def test_unknown_revision_stays_nonfatal_and_makes_no_backup(tmp_path, monkeypatch):
    """#552/#547 class: stamped at a revision this build doesn't ship
    (preview→stable). Nothing would be applied → keep the old warn+continue
    behavior, and don't churn a pointless backup every launch."""
    db = tmp_path / "omnivoice.db"
    _seed_user_db(db, stamp="9999_from_a_newer_build")
    monkeypatch.setattr("core.db.DB_PATH", str(db))

    init_db()  # must NOT raise (same contract as test_db_schema_reconcile)

    assert db_backup.list_backups(str(db)) == []
    assert _profile_names(db) == ["Alice"]


def test_midflight_failure_stops_startup_and_names_backup(tmp_path, monkeypatch):
    """The data-loss case this PR closes: a migration that fails while
    executing must raise MigrationError (startup stops), leave the original
    data reachable, and point the user at the pre-migration backup."""
    db = tmp_path / "omnivoice.db"
    _seed_user_db(db)
    monkeypatch.setattr("core.db.DB_PATH", str(db))

    import alembic.command

    def _boom(cfg, rev):
        raise RuntimeError("simulated failure inside migration 0007")

    # core.db does `from alembic import command` at call time, so patching the
    # module attribute is what its `command.upgrade(...)` call resolves.
    monkeypatch.setattr(alembic.command, "upgrade", _boom)

    with pytest.raises(MigrationError) as excinfo:
        _run_alembic_upgrade()

    msg = str(excinfo.value)
    backups = db_backup.list_backups(str(db))
    assert backups, "the pre-migration backup must exist on failure"
    assert backups[0] in msg, "the error must name the backup path"
    assert str(db) in msg, "the error must name the live DB path"
    assert "github.com/debpalash/OmniVoice-Studio/issues" in msg
    # Original data still present in BOTH the live DB and the backup —
    # and nothing was auto-restored (the backup file is separate).
    assert _profile_names(db) == ["Alice"]
    assert _profile_names(backups[0]) == ["Alice"]


def test_midflight_failure_without_backup_says_so(tmp_path, monkeypatch):
    """If the snapshot was skipped (oversized DB), the failure message must
    say a backup wasn't written instead of naming a phantom path."""
    db = tmp_path / "omnivoice.db"
    _seed_user_db(db)
    monkeypatch.setattr("core.db.DB_PATH", str(db))
    monkeypatch.setattr(db_backup, "MAX_BACKUP_DB_BYTES", 1)

    import alembic.command

    monkeypatch.setattr(
        alembic.command, "upgrade",
        lambda cfg, rev: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    with pytest.raises(MigrationError) as excinfo:
        _run_alembic_upgrade()

    assert "No pre-migration backup was written" in str(excinfo.value)
    assert db_backup.list_backups(str(db)) == []
    assert _profile_names(db) == ["Alice"]
