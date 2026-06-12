"""Voice Studio unification: profile `kind` discriminator + design params

Revision ID: 0005_unified_profiles
Revises: 0004_mcp_client_bindings
Create Date: 2026-06-13 00:00:00.000000

Adds two additive columns to ``voice_profiles`` so a *designed* voice
(category sliders + instruct, no user reference audio) is a first-class
profile rather than a transient UI state
(docs/specs/voice-studio-unification.md §3):

  * ``kind TEXT DEFAULT 'clone'`` — ``'clone'`` (user reference audio) or
    ``'design'`` (rendered sample + stored design params). Replaces the
    brittle is_locked/instruct inference in /generate.
  * ``vd_states TEXT DEFAULT NULL`` — JSON of the design category picks
    (Gender/Age/Pitch/Style/accent/dialect) so selecting a design profile
    can restore the sliders for re-editing.

Backfill: every existing row becomes ``kind='clone'`` — all of them carry a
real or rendered ``ref_audio_path`` today (archetype materialization
included), so the default is semantically true and no audio is re-rendered.

Behavior mirrors 0002/0003: ``_has_column`` PRAGMA guards make upgrade a
no-op on fresh installs (where _BASE_SCHEMA already has the columns),
satisfying the "Backward-compatible project data" constraint; downgrade
drops the columns (SQLite >= 3.35).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0005_unified_profiles"
down_revision: Union[str, None] = "0004_mcp_client_bindings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(r[1] == column for r in rows)


def upgrade() -> None:
    if not _has_column("voice_profiles", "kind"):
        op.add_column(
            "voice_profiles",
            sa.Column("kind", sa.Text(), nullable=False, server_default="clone"),
        )
        # server_default covers new rows; make existing rows explicit too.
        op.execute("UPDATE voice_profiles SET kind='clone' WHERE kind IS NULL OR kind=''")
    if not _has_column("voice_profiles", "vd_states"):
        op.add_column(
            "voice_profiles",
            sa.Column("vd_states", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    if _has_column("voice_profiles", "vd_states"):
        op.drop_column("voice_profiles", "vd_states")
    if _has_column("voice_profiles", "kind"):
        op.drop_column("voice_profiles", "kind")
