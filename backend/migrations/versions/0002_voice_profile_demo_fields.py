"""Phase 3: voice_profile description + is_demo columns

Revision ID: 0002_voice_profile_demo_fields
Revises: 0001_phase1_settings
Create Date: 2026-05-21 00:00:00.000000

Adds two additive nullable-with-default columns to ``voice_profiles``:

  * ``description TEXT DEFAULT ''`` — human-readable blurb shown on demo
    cards and (eventually) on user-created profiles. Empty string for
    legacy rows so nothing in the frontend has to guard against NULL.
  * ``is_demo INTEGER DEFAULT 0`` — flags bundled demo profiles so the
    UI can render a "demo" badge and prevent accidental deletion.

Behavior:
  * upgrade(): adds both columns with safe defaults. Uses the
    sqlite_master pragma to detect existing columns so re-running the
    migration on a fresh-install DB (where _BASE_SCHEMA already added
    them) is a no-op rather than a hard error. This satisfies the
    "Backward-compatible project data" constraint in CLAUDE.md.
  * downgrade(): drops both columns. SQLite ≥ 3.35 supports
    ``ALTER TABLE ... DROP COLUMN``; we target it because every shipping
    Python 3.11 bundle has sqlite3 ≥ 3.39.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0002_voice_profile_demo_fields"
down_revision: Union[str, None] = "0001_phase1_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(r[1] == column for r in rows)


def upgrade() -> None:
    if not _has_column("voice_profiles", "description"):
        op.add_column(
            "voice_profiles",
            sa.Column("description", sa.Text(), nullable=False, server_default=""),
        )
    if not _has_column("voice_profiles", "is_demo"):
        op.add_column(
            "voice_profiles",
            sa.Column("is_demo", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    # SQLite ≥ 3.35 supports DROP COLUMN. If both columns exist, drop them;
    # otherwise no-op so partial-state DBs don't blow up.
    if _has_column("voice_profiles", "is_demo"):
        op.drop_column("voice_profiles", "is_demo")
    if _has_column("voice_profiles", "description"):
        op.drop_column("voice_profiles", "description")
