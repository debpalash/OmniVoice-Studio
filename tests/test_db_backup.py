"""Pre-migration SQLite safety net (core.db_backup) — feat/safe-updates.

Covers the contract the data-safe update flow depends on: a WAL-safe snapshot
is written as ``omnivoice.db.backup-<version>-<n>``, only the newest
``KEEP_BACKUPS`` survive pruning, oversized DBs are skipped with a log line,
and ``latest_backup`` reports the newest snapshot for the Settings → Updates
backup line.
"""
import logging
import os
import sqlite3
import time

from core import db_backup


def _make_db(path, rows=3):
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE voices (id INTEGER PRIMARY KEY, name TEXT)")
        conn.executemany(
            "INSERT INTO voices(name) VALUES (?)", [(f"voice-{i}",) for i in range(rows)]
        )
        conn.commit()
    finally:
        conn.close()


def _rows(path):
    conn = sqlite3.connect(str(path))
    try:
        return [r[0] for r in conn.execute("SELECT name FROM voices ORDER BY id")]
    finally:
        conn.close()


def test_snapshot_creates_named_backup_with_identical_content(tmp_path):
    db = tmp_path / "omnivoice.db"
    _make_db(db, rows=4)

    backup = db_backup.snapshot_before_migration(str(db), "0.3.9")

    assert backup is not None
    assert os.path.basename(backup) == "omnivoice.db.backup-0.3.9-1"
    assert _rows(backup) == _rows(db) == [f"voice-{i}" for i in range(4)]


def test_snapshot_captures_wal_content(tmp_path):
    """The live DB runs WAL; un-checkpointed writes must land in the backup
    (a plain file copy would miss them — the reason we use the backup API)."""
    db = tmp_path / "omnivoice.db"
    _make_db(db)
    # Hold a connection open with an extra row committed to the WAL.
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("INSERT INTO voices(name) VALUES ('wal-only-row')")
        conn.commit()
        backup = db_backup.snapshot_before_migration(str(db), "0.3.9")
    finally:
        conn.close()
    assert "wal-only-row" in _rows(backup)


def test_snapshot_counter_increments_never_overwrites(tmp_path):
    db = tmp_path / "omnivoice.db"
    _make_db(db)
    first = db_backup.snapshot_before_migration(str(db), "0.3.9")
    second = db_backup.snapshot_before_migration(str(db), "0.3.9")
    assert first != second
    assert second.endswith(".backup-0.3.9-2")
    assert os.path.isfile(first) and os.path.isfile(second)


def test_rotation_keeps_only_newest_three(tmp_path):
    db = tmp_path / "omnivoice.db"
    _make_db(db)
    made = []
    base = time.time() - 100
    for i, ver in enumerate(["0.3.6", "0.3.7", "0.3.8", "0.3.9", "0.3.9"]):
        made.append(db_backup.snapshot_before_migration(str(db), ver))
        # Age each snapshot deterministically (strictly increasing, in the
        # past) so the next snapshot's prune sees an unambiguous ordering.
        os.utime(made[-1], (base + i, base + i))

    survivors = set(db_backup.list_backups(str(db)))
    assert len(survivors) == db_backup.KEEP_BACKUPS == 3
    assert survivors == set(made[2:]), "the newest three survive, the two oldest are pruned"
    assert not os.path.isfile(made[0]) and not os.path.isfile(made[1])


def test_preview_version_with_dashes_roundtrips(tmp_path):
    """Preview builds stamp X.Y.Z-N — the dash inside the version must not
    confuse the name parsing or the per-version counter."""
    db = tmp_path / "omnivoice.db"
    _make_db(db)
    b1 = db_backup.snapshot_before_migration(str(db), "0.3.9-41")
    b2 = db_backup.snapshot_before_migration(str(db), "0.3.9-41")
    assert b1.endswith(".backup-0.3.9-41-1")
    assert b2.endswith(".backup-0.3.9-41-2")
    assert db_backup.list_backups(str(db)) != []


def test_oversized_db_is_skipped_with_log_line(tmp_path, monkeypatch, caplog):
    db = tmp_path / "omnivoice.db"
    _make_db(db)
    monkeypatch.setattr(db_backup, "MAX_BACKUP_DB_BYTES", 1)  # everything is "too big"
    with caplog.at_level(logging.INFO, logger="omnivoice.db.backup"):
        assert db_backup.snapshot_before_migration(str(db), "0.3.9") is None
    assert any("Skipping pre-migration DB backup" in r.message for r in caplog.records)
    assert db_backup.list_backups(str(db)) == []


def test_missing_db_returns_none(tmp_path):
    assert db_backup.snapshot_before_migration(str(tmp_path / "nope.db"), "0.3.9") is None


def test_latest_backup_reports_newest(tmp_path):
    db = tmp_path / "omnivoice.db"
    assert db_backup.latest_backup(str(db)) is None
    _make_db(db)
    older = db_backup.snapshot_before_migration(str(db), "0.3.8")
    newer = db_backup.snapshot_before_migration(str(db), "0.3.9")
    os.utime(older, (time.time() - 100, time.time() - 100))

    latest = db_backup.latest_backup(str(db))
    assert latest is not None
    assert latest["path"] == newer
    assert latest["size_bytes"] > 0
    assert abs(latest["created_at"] - time.time()) < 300


def test_version_is_sanitized_for_filenames(tmp_path):
    db = tmp_path / "omnivoice.db"
    _make_db(db)
    backup = db_backup.snapshot_before_migration(str(db), "0.3.9/../evil")
    name = os.path.basename(backup)
    assert "/" not in name.replace(os.path.basename(str(db)), "")
    assert os.path.dirname(backup) == os.path.dirname(str(db))
