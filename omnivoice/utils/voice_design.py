#!/usr/bin/env python3
# Copyright    2026  Xiaomi Corp.        (authors:  Han Zhu)
#
# See ../../LICENSE for clarification regarding multiple authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Voice-design instruct constants for TTS inference.

Defines speaker attribute tags (gender, age, pitch, accent, dialect) and
translation/validation utilities between English and Chinese. Used by
``OmniVoice.generate()`` for voice design mode.
"""

import re

_ZH_RE = re.compile(r'[\u4e00-\u9fff]')

# Category = set of {english: chinese, ...} items that are mutually exclusive.
# Accent (EN-only) and dialect (ZH-only) are stored as flat sets below.
_INSTRUCT_CATEGORIES = [
    {"male": "男", "female": "女"},
    {"child": "儿童", "teenager": "少年", "young adult": "青年",
     "middle-aged": "中年", "elderly": "老年"},
    {"very low pitch": "极低音调", "low pitch": "低音调",
     "moderate pitch": "中音调", "high pitch": "高音调",
     "very high pitch": "极高音调"},
    {"whisper": "耳语"},
    # Accent (English-only, no Chinese counterpart)
    {"american accent", "british accent", "australian accent",
     "chinese accent", "canadian accent", "indian accent",
     "korean accent", "portuguese accent", "russian accent", "japanese accent"},
    # Dialect (Chinese-only, no English counterpart)
    {"河南话", "陕西话", "四川话", "贵州话", "云南话", "桂林话",
     "济南话", "石家庄话", "甘肃话", "宁夏话", "青岛话", "东北话"},
]

_INSTRUCT_EN_TO_ZH = {}
_INSTRUCT_ZH_TO_EN = {}
_INSTRUCT_MUTUALLY_EXCLUSIVE = []
for _cat in _INSTRUCT_CATEGORIES:
    if isinstance(_cat, dict):
        _INSTRUCT_EN_TO_ZH.update(_cat)
        _INSTRUCT_ZH_TO_EN.update({v: k for k, v in _cat.items()})
        _INSTRUCT_MUTUALLY_EXCLUSIVE.append(set(_cat) | set(_cat.values()))
    else:
        _INSTRUCT_MUTUALLY_EXCLUSIVE.append(set(_cat))

_INSTRUCT_ALL_VALID = (
    set(_INSTRUCT_EN_TO_ZH) | set(_INSTRUCT_ZH_TO_EN)
    | _INSTRUCT_MUTUALLY_EXCLUSIVE[-2]  # accents
    | _INSTRUCT_MUTUALLY_EXCLUSIVE[-1]  # dialects
)

_INSTRUCT_VALID_EN = frozenset(i for i in _INSTRUCT_ALL_VALID if not _ZH_RE.search(i))
_INSTRUCT_VALID_ZH = frozenset(i for i in _INSTRUCT_ALL_VALID if _ZH_RE.search(i))


def _instruct_category_index(tag):
    """Index of the mutually-exclusive category ``tag`` belongs to, else -1."""
    for i, cat in enumerate(_INSTRUCT_MUTUALLY_EXCLUSIVE):
        if tag in cat:
            return i
    return -1


def _valid_instruct_from_items(items):
    """Keep only known design tags, one per category, in first-seen order.

    Drops the ``"[object Object]"`` sentinel, freeform prose, ``"Auto"``, and any
    token outside the whitelist. Lowercases and de-duplicates by category so a
    pair like ``male, female`` collapses to the first pick. Returns ``""`` when
    nothing valid remains.
    """
    seen = set()
    out = []
    for raw in items:
        tag = str(raw if raw is not None else "").strip().lower()
        if not tag or tag not in _INSTRUCT_ALL_VALID:
            continue
        ci = _instruct_category_index(tag)
        if ci in seen:
            continue
        seen.add(ci)
        out.append(tag)
    return ", ".join(out)


def sanitize_instruct(raw):
    """Return a validator-safe instruct from a possibly-poisoned stored value.

    Unlike :func:`_resolve_instruct` (which *raises* on unknown items so the
    Generate tab can surface typos), this is the forgiving path for *stored*
    design-profile instructs: it silently drops the ``"[object Object]"``
    sentinel and freeform prose, keeping only whitelist tags. This stops a
    poisoned/legacy profile from 400-ing every generation that uses it
    (#550 #571 #594 #596).
    """
    if not raw:
        return ""
    return _valid_instruct_from_items(re.split(r"\s*[,，]\s*", str(raw).strip()))


def instruct_from_vd_states(vd_states):
    """Rebuild a validator-safe instruct from a design profile's ``vd_states``.

    ``vd_states`` is the authoritative category→pick map the Voice Design picker
    persists (``"Auto"`` means a category was left unset). It's the source of
    truth used to *recover* a designed voice's tags when the stored instruct was
    poisoned (object-coerced or replaced by prose) — so the designed gender/age/
    pitch/accent survive instead of silently defaulting (#594).

    Accepts a dict or a JSON string. Returns ``""`` when unparseable/empty.
    """
    if not vd_states:
        return ""
    if isinstance(vd_states, str):
        import json
        try:
            vd_states = json.loads(vd_states)
        except (ValueError, TypeError):
            return ""
    if not isinstance(vd_states, dict):
        return ""
    return _valid_instruct_from_items(vd_states.values())


def heal_design_instruct(instruct, vd_states=None):
    """Best-effort validator-safe instruct for a stored profile.

    Prefers the sanitized stored value (so any hand-typed valid tags survive);
    falls back to rebuilding from ``vd_states`` when the stored value sanitizes
    to nothing — the #594 case where ``"[object Object]"`` (or prose) must still
    yield the designed attributes, not a silent default. A clone profile (no
    ``vd_states``) simply gets its instruct sanitized.
    """
    healed = sanitize_instruct(instruct)
    if healed:
        return healed
    return instruct_from_vd_states(vd_states)
