"""Generation takes: starred flag on generation_history

Revision ID: 0009_generation_history_starred
Revises: 0008_pronunciation_dictionary
Create Date: 2026-07-10 00:00:00.000000

Adds ``generation_history.starred INTEGER DEFAULT 0`` — the "keep this
take" flag behind the Studio takes rail. Starred takes are exempt from the
retention cap that prunes old generations, and star/unstar round-trips through
``PUT /history/{id}/starred``.

Additive + idempotent (guarded by PRAGMA table_info, matching 0002/0003), so
re-running on a fresh-install DB where ``_BASE_SCHEMA`` already declares the
column is a no-op (Backward-compatible project data constraint). The same
column is mirrored into ``core/db.py::_BASE_SCHEMA`` so fresh installs and
migrated DBs converge on an identical end-state — and DBs where alembic can't
run at all pick it up via ``_reconcile_additive_columns`` (the #552/#547
self-heal), the dual-path discipline.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0009_generation_history_starred"
down_revision: Union[str, None] = "0008_pronunciation_dictionary"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(r[1] == column for r in rows)


def _has_table(name: str) -> bool:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
        {"n": name},
    ).fetchone()
    return row is not None


def upgrade() -> None:
    # A DB that somehow missed init has no generation_history at all — the
    # startup self-heal (#710) creates it with the column already present, so
    # ALTERing here would be both impossible and unnecessary.
    if not _has_table("generation_history"):
        return
    if not _has_column("generation_history", "starred"):
        # nullable + DEFAULT 0 to byte-match _BASE_SCHEMA's declaration
        # (`starred INTEGER DEFAULT 0`) — the dual-path convergence test
        # compares table shape between a migrated DB and a fresh install.
        op.add_column(
            "generation_history",
            sa.Column("starred", sa.Integer(), nullable=True, server_default="0"),
        )


def downgrade() -> None:
    if _has_table("generation_history") and _has_column("generation_history", "starred"):
        op.drop_column("generation_history", "starred")
