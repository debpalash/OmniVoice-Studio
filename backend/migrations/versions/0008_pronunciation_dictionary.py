"""Expressive-TTS Spec 01 Phase 1: user pronunciation dictionary

Revision ID: 0008_pronunciation_dictionary
Revises: 0007_rebuild_poisoned_design_instruct
Create Date: 2026-06-25 00:00:00.000000

Adds the ``pronunciation_entries`` table backing the user-editable, per-language
pronunciation dictionary (Settings → Pronunciation). Each row maps a ``term`` to
a ``replacement`` the engine pronounces correctly, scoped global (``language='*'``)
or to a 2-letter language. Applied as pure text substitution before synthesis, so
every engine honors it.

  * ``id``          TEXT PRIMARY KEY — stable row id.
  * ``term``        TEXT — the word/phrase to match (whole-word, case-insensitive).
  * ``replacement`` TEXT — the respelling (or, for phoneme rows, the markup).
  * ``type``        TEXT — 'respelling' | 'ipa' | 'cmu'.
  * ``language``    TEXT — '*' = global, else a language code (e.g. 'en', 'de').
  * ``enabled``     INTEGER — 1 = applied, 0 = parked.
  * ``created_at``  REAL.

Additive + idempotent (guarded by sqlite_master), matching 0002/0003/0004, so
re-running on a fresh-install DB where ``_BASE_SCHEMA`` already created the table
is a no-op (Backward-compatible project data constraint). The same table is
mirrored into ``core/db.py::_BASE_SCHEMA`` so fresh installs and migrated DBs
converge on an identical end-state (the dual-path discipline).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0008_pronunciation_dictionary"
down_revision: Union[str, None] = "0007_rebuild_poisoned_design_instruct"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(name: str) -> bool:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
        {"n": name},
    ).fetchone()
    return row is not None


def upgrade() -> None:
    if _has_table("pronunciation_entries"):
        return
    op.create_table(
        "pronunciation_entries",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("term", sa.Text(), nullable=False),
        sa.Column("replacement", sa.Text(), nullable=False, server_default=""),
        sa.Column("type", sa.Text(), nullable=False, server_default="respelling"),
        sa.Column("language", sa.Text(), nullable=False, server_default="*"),
        sa.Column("enabled", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.Float(), nullable=True),
    )
    op.create_index("idx_pron_lang", "pronunciation_entries", ["language"])


def downgrade() -> None:
    if _has_table("pronunciation_entries"):
        op.drop_index("idx_pron_lang", table_name="pronunciation_entries")
        op.drop_table("pronunciation_entries")
