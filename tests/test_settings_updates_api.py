"""Settings → Updates API surface: /api/settings/changelog + /db-backup.

Direct handler calls (house convention — same as test_llm_providers_router:
the loopback guard is router-level and not under test here).
"""
import importlib
import os
import sqlite3

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


@pytest.fixture
def settings_mod():
    return importlib.import_module("api.routers.settings")


def test_changelog_endpoint_returns_structured_releases(settings_mod, tmp_path, monkeypatch):
    f = tmp_path / "CHANGELOG.md"
    f.write_text(
        "## [0.4.0] — 2027-01-01\n\nHeadline.\n\n### Added\n\n- **New.** Thing. (#1)\n\n"
        "## [0.3.9] — 2026-07-02\n\n### Fixed\n\n- **Old.** Fix. (#2)\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("OMNIVOICE_CHANGELOG", str(f))

    out = settings_mod.get_changelog(limit_versions=1)
    assert out["available"] is True
    assert len(out["releases"]) == 1
    r = out["releases"][0]
    assert r["version"] == "0.4.0"
    assert r["date"] == "2027-01-01"
    assert r["intro"] == "Headline."
    assert r["sections"] == [{"title": "Added", "bullets": ["**New.** Thing. (#1)"]}]


def test_changelog_endpoint_degrades_when_missing(settings_mod, tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_CHANGELOG", str(tmp_path / "absent.md"))
    out = settings_mod.get_changelog(limit_versions=5)
    assert out == {"available": False, "releases": []}


def test_db_backup_state_none_then_latest(settings_mod, tmp_path, monkeypatch):
    db = tmp_path / "omnivoice.db"
    monkeypatch.setattr("core.config.DB_PATH", str(db))

    out = settings_mod.get_db_backup_state()
    assert out["available"] is False and out["latest"] is None and out["count"] == 0

    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE t (x)")
    conn.commit()
    conn.close()
    from core import db_backup

    made = db_backup.snapshot_before_migration(str(db), "0.3.9")

    out = settings_mod.get_db_backup_state()
    assert out["available"] is True
    assert out["latest"]["path"] == made
    assert out["latest"]["created_at"] > 0
    assert out["count"] == 1
    assert out["keep"] == db_backup.KEEP_BACKUPS
