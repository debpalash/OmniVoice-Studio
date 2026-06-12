"""Parity program Wave 2.2: per-agent MCP voice bindings

Revision ID: 0004_mcp_client_bindings
Revises: 0003_voice_profile_consent
Create Date: 2026-06-12 00:00:00.000000

Adds the ``mcp_client_bindings`` table backing per-agent voice binding
(docs/competitive-analysis.md Spec 2): each MCP client (identified by the
``X-OmniVoice-Client-Id`` header it sends) can be bound to a default voice
profile / engine, so "Claude Code speaks in Morgan, Cursor in Scarlett".

  * ``client_id``   TEXT PRIMARY KEY — the agent's stable id.
  * ``label``       TEXT — human label shown in Settings.
  * ``profile_id``  TEXT — voice profile to speak in (nullable FK-by-convention).
  * ``default_engine`` TEXT — engine override (nullable).
  * ``last_seen_at`` REAL — updated when the client calls a tool.
  * ``created_at``  REAL.

Additive + idempotent (guarded by sqlite_master), matching 0002/0003, so
re-running on a fresh-install DB where _BASE_SCHEMA already created it is a
no-op (Backward-compatible project data constraint).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0004_mcp_client_bindings"
down_revision: Union[str, None] = "0003_voice_profile_consent"
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
    if _has_table("mcp_client_bindings"):
        return
    op.create_table(
        "mcp_client_bindings",
        sa.Column("client_id", sa.Text(), primary_key=True),
        sa.Column("label", sa.Text(), nullable=False, server_default=""),
        sa.Column("profile_id", sa.Text(), nullable=True),
        sa.Column("default_engine", sa.Text(), nullable=True),
        sa.Column("last_seen_at", sa.Float(), nullable=True),
        sa.Column("created_at", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    if _has_table("mcp_client_bindings"):
        op.drop_table("mcp_client_bindings")
