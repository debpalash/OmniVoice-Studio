"""First-run onboarding seeds the demo voice profile (#621).

The demo clip `backend/assets/samples/demo_voice.wav` is a build artifact that
was never committed, so it shipped absent from installs — onboarding then logged
"Demo audio not found" and seeded nothing, leaving an empty Launchpad. The fix
commits the clip (it's un-ignored in .gitignore and bundled via the Tauri
`backend` resource). These tests pin that the asset is present + valid and that
onboarding actually seeds the demo profile from it.
"""
import os
import sqlite3
import sys
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import core.onboarding as onboarding  # noqa: E402

_WAV = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "backend", "assets", "samples", "demo_voice.wav",
)


def test_demo_clip_is_committed_and_valid():
    """The clip must ship with the app — guards against it silently going
    missing again (the whole #621 regression)."""
    assert os.path.isfile(_WAV), (
        f"{_WAV} is missing — regenerate with scripts/build_demos.sh and commit "
        "it (it must ship for first-run onboarding)."
    )
    with wave.open(_WAV, "rb") as w:
        assert w.getnframes() > 0, "demo_voice.wav has no audio frames"
        assert w.getframerate() > 0


def _table_sql():
    return (
        "CREATE TABLE voice_profiles (id TEXT PRIMARY KEY, name TEXT, "
        "ref_audio_path TEXT, ref_text TEXT DEFAULT '', instruct TEXT DEFAULT '', "
        "language TEXT DEFAULT 'Auto', personality TEXT DEFAULT '', "
        "description TEXT DEFAULT '', is_demo INTEGER DEFAULT 0, created_at REAL)"
    )


def test_seed_creates_demo_profile_on_empty_db(tmp_path, monkeypatch):
    # File-backed DB so the row survives the conn.close() inside onboarding;
    # each get_db() call returns a fresh connection to it.
    db_path = str(tmp_path / "ob.db")
    setup = sqlite3.connect(db_path)
    setup.execute(_table_sql())
    setup.commit()
    setup.close()
    monkeypatch.setattr(onboarding, "get_db", lambda: sqlite3.connect(db_path))
    monkeypatch.setattr(onboarding, "VOICES_DIR", str(tmp_path / "voices"))

    onboarding.seed_sample_project()

    check = sqlite3.connect(db_path)
    rows = check.execute(
        "SELECT id, ref_audio_path, is_demo FROM voice_profiles"
    ).fetchall()
    check.close()
    assert len(rows) == 1
    assert rows[0][0] == onboarding.DEMO_PROFILE_ID
    assert rows[0][1] == f"{onboarding.DEMO_PROFILE_ID}.wav"   # audio copied in
    assert rows[0][2] == 1                                      # flagged demo
    assert os.path.isfile(os.path.join(str(tmp_path / "voices"), f"{onboarding.DEMO_PROFILE_ID}.wav"))


def test_seed_is_noop_when_profiles_exist(tmp_path, monkeypatch):
    _db_path = str(tmp_path / "ob.db")
    c = sqlite3.connect(_db_path)
    c.execute(_table_sql())
    c.execute("INSERT INTO voice_profiles (id, name) VALUES ('existing', 'X')")
    c.commit()
    c.close()
    monkeypatch.setattr(onboarding, "get_db", lambda: sqlite3.connect(_db_path))
    monkeypatch.setattr(onboarding, "VOICES_DIR", str(tmp_path / "voices"))

    onboarding.seed_sample_project()

    c = sqlite3.connect(_db_path)
    n = c.execute("SELECT COUNT(*) FROM voice_profiles").fetchone()[0]
    c.close()
    assert n == 1  # unchanged — no demo seeded on a non-empty DB
