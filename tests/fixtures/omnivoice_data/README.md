# tests/fixtures/omnivoice_data/

**Frozen regression fixture** loaded by `tests/smoke/test_boot_smoke.py`
on every PR (macOS / Windows / Linux). See GATE-01 in
`.planning/REQUIREMENTS.md`.

## Do not edit by hand

Regenerate via:

    uv run python scripts/seed-test-fixture.py

The script is deterministic (fixed `created_at` + all-zero PCM)
so re-running produces a byte-identical fixture for clean git diffs.

## Layout

- `omnivoice.db` — all 8 tables created by `backend/core/db.py::init_db()`,
  with exactly one row in `voice_profiles` and zero rows in history tables.
- `voices/test-voice/profile.json` — JSON mirror of the voice_profiles row.
- `voices/test-voice/sample.wav` — 1-sec, 24 kHz, mono, 16-bit PCM silence.

## Why not alembic?

`backend/migrations/versions/` is empty (`.gitkeep` only); the project
uses `backend.core.db.init_db()` directly. This builder follows the same
path for parity with production.

## Size budget

Total directory size MUST stay ≤ 200 KB so every contributor's
`git clone` stays cheap. The seed script exits non-zero if it
exceeds the budget.
