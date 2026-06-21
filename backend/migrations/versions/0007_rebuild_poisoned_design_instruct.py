"""Rebuild design-profile instructs poisoned with prose / "[object Object]".

Revision ID: 0007_rebuild_poisoned_design_instruct
Revises: 0006_strip_object_object_instruct
Create Date: 2026-06-22 00:00:00.000000

Migration 0006 *blanked* the literal ``"[object Object]"`` sentinel. That stops
the 400 on use, but it also throws away the designed voice: a row that read
``"[object Object]"`` (or freeform prose like "A gentle, quiet male voice…")
becomes ``instruct=''`` and then renders with the engine's neutral default —
which is why an Indonesian *female* designed voice came out *male* (#594), and
why prose-poisoned designs still 400 (#571 #596).

This migration heals it properly: for every design profile it recomputes a
validator-safe instruct, preferring any whitelist tags already in the stored
value and otherwise rebuilding the tags from ``vd_states`` (the authoritative
category→pick map the Voice Design picker persists). Non-design rows simply get
their instruct sanitized (poison dropped). Idempotent — a healthy row is left
byte-for-byte unchanged, so re-running is a no-op.

Self-contained by design: alembic migrations must not import evolving app code
(``omnivoice`` would also drag in torch at startup), so the tag whitelist is a
frozen snapshot of ``omnivoice.utils.voice_design._INSTRUCT_ALL_VALID``.
``tests/test_migration_0007_instruct_rebuild.py`` asserts the snapshot stays in
sync with the canonical set.
"""
import json
import re
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect

revision: str = "0007_rebuild_poisoned_design_instruct"
down_revision: Union[str, None] = "0006_strip_object_object_instruct"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Frozen snapshot of the design-instruct whitelist + mutually-exclusive
# categories (omnivoice/utils/voice_design.py). Kept self-contained so the
# migration's behaviour is pinned to the data it heals, not to future vocab
# edits. Parity is guarded by the migration test.
_CATEGORIES = [
    {"male", "女", "female", "男"},
    {"child", "teenager", "young adult", "middle-aged", "elderly",
     "儿童", "少年", "青年", "中年", "老年"},
    {"very low pitch", "low pitch", "moderate pitch", "high pitch", "very high pitch",
     "极低音调", "低音调", "中音调", "高音调", "极高音调"},
    {"whisper", "耳语"},
    {"american accent", "british accent", "australian accent", "chinese accent",
     "canadian accent", "indian accent", "korean accent", "portuguese accent",
     "russian accent", "japanese accent"},
    {"河南话", "陕西话", "四川话", "贵州话", "云南话", "桂林话",
     "济南话", "石家庄话", "甘肃话", "宁夏话", "青岛话", "东北话"},
]
_ALL_VALID = set().union(*_CATEGORIES)


def _valid_from_items(items) -> str:
    """One whitelist tag per category, first-seen order; everything else dropped."""
    seen = set()
    out = []
    for raw in items:
        tag = str(raw if raw is not None else "").strip().lower()
        if not tag or tag not in _ALL_VALID:
            continue
        ci = next((i for i, c in enumerate(_CATEGORIES) if tag in c), -1)
        if ci in seen:
            continue
        seen.add(ci)
        out.append(tag)
    return ", ".join(out)


def _heal(instruct, vd_states, is_design) -> str:
    healed = _valid_from_items(re.split(r"\s*[,，]\s*", str(instruct or "").strip()))
    if healed or not is_design:
        return healed
    # Stored instruct was all-poison — recover the design from vd_states.
    if not vd_states:
        return ""
    try:
        vd = json.loads(vd_states)
    except (ValueError, TypeError):
        return ""
    return _valid_from_items(vd.values()) if isinstance(vd, dict) else ""


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    if "voice_profiles" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("voice_profiles")}
    has_kind = "kind" in cols
    has_vd = "vd_states" in cols

    select = "SELECT id, instruct"
    select += ", kind" if has_kind else ""
    select += ", vd_states" if has_vd else ""
    select += " FROM voice_profiles"

    for row in bind.exec_driver_sql(select).mappings().all():
        instruct = row["instruct"] or ""
        is_design = (row["kind"] == "design") if has_kind else bool(instruct)
        vd = row["vd_states"] if has_vd else None
        healed = _heal(instruct, vd, is_design)
        if healed != instruct:
            bind.exec_driver_sql(
                "UPDATE voice_profiles SET instruct = ? WHERE id = ?",
                (healed, row["id"]),
            )


def downgrade() -> None:
    # Irreversible heal — the original poisoned value isn't worth restoring.
    pass
