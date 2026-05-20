"""Phase 1: settings table for encrypted HF token persistence

Revision ID: 0001_phase1_settings
Revises:
Create Date: 2026-05-20 00:00:00.000000

This is the first hand-written alembic migration in OmniVoice. Before
v0.3.0 the schema lived entirely in `backend/core/db.py::_BASE_SCHEMA`
with `CREATE TABLE IF NOT EXISTS`. We keep that pattern for fresh
installs (both paths converge on the same schema) and use this migration
for explicit v0.2.7 → v0.3.0 upgrades that can be inspected, downgraded,
and tested in CI.

Behavior:
  - upgrade(): adds `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at REAL NOT NULL)`. Uses checkfirst=True so re-running on a
    DB that already has the table (because _BASE_SCHEMA created it on a
    previous boot) is a no-op rather than an error — this is the
    backward-compat contract for v0.2.7 users (per CLAUDE.md
    "Backward-compatible project data" constraint).
  - downgrade(): drops the settings table cleanly. Used by tests; not
    expected to run in production.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0001_phase1_settings"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table: str) -> bool:
    """SQLite-specific existence check via sqlite_master."""
    bind = op.get_bind()
    row = bind.execute(
        sa.text(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=:n"
        ),
        {"n": table},
    ).first()
    return row is not None


def upgrade() -> None:
    # Idempotent: a fresh install already ran _BASE_SCHEMA which created
    # `settings`. Only call create_table when it really is absent so we
    # don't trip on "table already exists" on second-boot upgrade paths.
    if not _has_table("settings"):
        op.create_table(
            "settings",
            sa.Column("key", sa.Text(), primary_key=True),
            sa.Column("value", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.REAL(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("settings")
