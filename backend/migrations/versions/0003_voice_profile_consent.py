"""Parity program Wave 0.2: consent-locked voice profiles

Revision ID: 0003_voice_profile_consent
Revises: 0002_voice_profile_demo_fields
Create Date: 2026-06-12 00:00:00.000000

Adds four additive columns to ``voice_profiles`` backing the
``verified_own_voice`` consent lock (docs/competitive-analysis.md Action 22 /
parity program Wave 0.2). A profile becomes "verified" when its owner records
a spoken consent statement; agentic features and gallery sharing will require
the flag — plain local synthesis never does.

  * ``verified_own_voice INTEGER DEFAULT 0`` — the consent lock itself.
  * ``consent_text TEXT DEFAULT ''`` — the statement that was read aloud.
  * ``consent_audio_path TEXT DEFAULT ''`` — filename of the recorded
    statement in VOICES_DIR (kept as provenance, deletable via revoke).
  * ``consent_recorded_at REAL DEFAULT NULL`` — UNIX timestamp.

Behavior mirrors 0002: ``_has_column`` PRAGMA guards make upgrade a no-op on
fresh installs (where _BASE_SCHEMA already has the columns), satisfying the
"Backward-compatible project data" constraint; downgrade drops the columns
(SQLite >= 3.35).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003_voice_profile_consent"
down_revision: Union[str, None] = "0002_voice_profile_demo_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("verified_own_voice", sa.Column("verified_own_voice", sa.Integer(), nullable=False, server_default="0")),
    ("consent_text", sa.Column("consent_text", sa.Text(), nullable=False, server_default="")),
    ("consent_audio_path", sa.Column("consent_audio_path", sa.Text(), nullable=False, server_default="")),
    ("consent_recorded_at", sa.Column("consent_recorded_at", sa.Float(), nullable=True)),
)


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(r[1] == column for r in rows)


def upgrade() -> None:
    for name, column in _COLUMNS:
        if not _has_column("voice_profiles", name):
            op.add_column("voice_profiles", column)


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        if _has_column("voice_profiles", name):
            op.drop_column("voice_profiles", name)
