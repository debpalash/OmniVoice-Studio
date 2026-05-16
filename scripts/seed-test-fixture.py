#!/usr/bin/env python3
"""
Deterministic builder for `tests/fixtures/omnivoice_data/` — the frozen
regression fixture loaded by PR smoke tests (GATE-01).

Usage (from repo root):
    uv run python scripts/seed-test-fixture.py

What it produces (≤ 200 KB total):
    tests/fixtures/omnivoice_data/
    ├── omnivoice.db                          # all 8 tables, 1 voice_profiles row, 0 history rows
    ├── voices/test-voice/
    │   ├── profile.json                      # mirrors the voice_profiles row
    │   └── sample.wav                        # 1-sec 24 kHz mono silence (~48 KB)
    └── README.md                             # explains the fixture + rebuild path

The script is idempotent: an existing fixture directory is wiped and rebuilt.
Inputs are entirely deterministic (fixed timestamp, all-zero PCM samples) so
re-running this script produces a byte-identical fixture for git diffs.

Why this exists: every PR runs `tests/smoke/test_boot_smoke.py` against this
fixture on macOS / Windows / Linux. If the fixture drifts uncontrollably,
the smoke matrix loses its meaning. Keeping it tiny + reproducible is the
whole point of GATE-01.
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import sys
import wave
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
FIX = REPO_ROOT / "tests" / "fixtures" / "omnivoice_data"
VOICE_DIR = FIX / "voices" / "test-voice"

# Fixed timestamp so the fixture is byte-deterministic for git diffs.
# Value chosen arbitrarily; any constant works.
FIXED_CREATED_AT = 1700000000.0

SIZE_BUDGET_BYTES = 200 * 1024


def write_silence_wav(path: Path, duration_s: float = 1.0,
                       sample_rate: int = 24000, channels: int = 1) -> None:
    """Write a 16-bit PCM silent WAV. Mirrors `tests/test_api.py::make_wav_bytes`."""
    n_samples = int(duration_s * sample_rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f"<{n_samples}h", *([0] * n_samples)))


def write_profile_json(path: Path) -> dict:
    profile = {
        "id": "test-voice",
        "name": "Test Voice (silence)",
        "ref_audio_path": "voices/test-voice/sample.wav",
        "ref_text": "silence",
        "instruct": "",
        "language": "Auto",
        "created_at": FIXED_CREATED_AT,
        "locked_audio_path": "",
        "seed": None,
        "is_locked": 0,
    }
    path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8")
    return profile


def build_database(db_path: Path, profile: dict) -> None:
    """Build the SQLite DB by importing backend.core.db and calling init_db().

    `init_db()` reads `core.config.DB_PATH` at call time, so we monkey-patch
    that module-level constant after import. `OMNIVOICE_DISABLE_FILE_LOG=1`
    is set before any backend import so we don't write log files to
    nonexistent paths.
    """
    os.environ["OMNIVOICE_DISABLE_FILE_LOG"] = "1"
    # OMNIVOICE_DATA_DIR is read by backend.core.config.get_app_data_dir()
    # but DB_PATH is set at module import time. We override DB_PATH directly
    # below for full control.

    backend_dir = str(REPO_ROOT / "backend")
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)

    import core.config as cfg
    cfg.DB_PATH = str(db_path)

    from core.db import init_db, get_db  # noqa: E402
    init_db()

    # Insert exactly one voice_profiles row (deterministic content).
    conn = get_db()
    try:
        conn.execute(
            """
            INSERT INTO voice_profiles (
                id, name, ref_audio_path, ref_text, instruct, language,
                locked_audio_path, seed, is_locked, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                profile["id"],
                profile["name"],
                profile["ref_audio_path"],
                profile["ref_text"],
                profile["instruct"],
                profile["language"],
                profile["locked_audio_path"],
                profile["seed"],
                profile["is_locked"],
                profile["created_at"],
            ),
        )
        conn.commit()
        # Checkpoint the WAL into the main DB file, then switch journal mode
        # back to DELETE so the fixture is a single-file artifact with no
        # `-wal` / `-shm` siblings hanging around to confuse `git status`.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.commit()
    finally:
        conn.close()

    # Defensive cleanup — if any sidecar files survived, remove them.
    for sidecar in (db_path.with_name(db_path.name + "-wal"),
                    db_path.with_name(db_path.name + "-shm"),
                    db_path.with_name(db_path.name + "-journal")):
        if sidecar.exists():
            sidecar.unlink()


def write_readme(path: Path) -> None:
    body = (
        "# tests/fixtures/omnivoice_data/\n"
        "\n"
        "**Frozen regression fixture** loaded by `tests/smoke/test_boot_smoke.py`\n"
        "on every PR (macOS / Windows / Linux). See GATE-01 in\n"
        "`.planning/REQUIREMENTS.md`.\n"
        "\n"
        "## Do not edit by hand\n"
        "\n"
        "Regenerate via:\n"
        "\n"
        "    uv run python scripts/seed-test-fixture.py\n"
        "\n"
        "The script is deterministic (fixed `created_at` + all-zero PCM)\n"
        "so re-running produces a byte-identical fixture for clean git diffs.\n"
        "\n"
        "## Layout\n"
        "\n"
        "- `omnivoice.db` — all 8 tables created by `backend/core/db.py::init_db()`,\n"
        "  with exactly one row in `voice_profiles` and zero rows in history tables.\n"
        "- `voices/test-voice/profile.json` — JSON mirror of the voice_profiles row.\n"
        "- `voices/test-voice/sample.wav` — 1-sec, 24 kHz, mono, 16-bit PCM silence.\n"
        "\n"
        "## Why not alembic?\n"
        "\n"
        "`backend/migrations/versions/` is empty (`.gitkeep` only); the project\n"
        "uses `backend.core.db.init_db()` directly. This builder follows the same\n"
        "path for parity with production.\n"
        "\n"
        "## Size budget\n"
        "\n"
        "Total directory size MUST stay ≤ 200 KB so every contributor's\n"
        "`git clone` stays cheap. The seed script exits non-zero if it\n"
        "exceeds the budget.\n"
    )
    path.write_text(body, encoding="utf-8")


def directory_size_bytes(root: Path) -> int:
    total = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            total += os.path.getsize(os.path.join(dirpath, name))
    return total


def main() -> int:
    if FIX.exists():
        shutil.rmtree(FIX)
    VOICE_DIR.mkdir(parents=True, exist_ok=True)

    write_silence_wav(VOICE_DIR / "sample.wav")
    profile = write_profile_json(VOICE_DIR / "profile.json")
    build_database(FIX / "omnivoice.db", profile)
    write_readme(FIX / "README.md")

    total = directory_size_bytes(FIX)
    print(f"Fixture written to: {FIX}")
    print(f"Total size: {total} bytes ({total / 1024:.1f} KB)")

    if total > SIZE_BUDGET_BYTES:
        print(
            f"ERROR: fixture size {total} bytes exceeds "
            f"budget {SIZE_BUDGET_BYTES} bytes (200 KB)",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
