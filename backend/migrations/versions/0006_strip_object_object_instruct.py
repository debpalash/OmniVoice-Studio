"""Heal voice_profiles.instruct poisoned with the "[object Object]" sentinel.

Revision ID: 0006_strip_object_object_instruct
Revises: 0005_unified_profiles
Create Date: 2026-06-20 00:00:00.000000

A pre-fix Voice Studio build ("Save design as profile") passed the
``buildDesignInstruct()`` *object* straight to FormData, which string-coerced it
to the literal ``"[object Object]"`` and persisted that into
``voice_profiles.instruct`` (#550 #545 #542 #537 #530 #525). On first
preview/use that value fails the engine instruct validator with a 400. The
frontend + backend fixes stop any NEW poisoned rows; this migration heals the
ones already saved on the buggy build (the local-first backward-compat rule —
existing project data must keep working without manual migration).
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect

revision: str = "0006_strip_object_object_instruct"
down_revision: Union[str, None] = "0005_unified_profiles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if "voice_profiles" in inspect(bind).get_table_names():
        # Idempotent: only touches rows whose instruct is literally the sentinel.
        op.execute("UPDATE voice_profiles SET instruct='' WHERE instruct='[object Object]'")


def downgrade() -> None:
    # Irreversible heal — the original garbage sentinel is not worth restoring.
    pass
