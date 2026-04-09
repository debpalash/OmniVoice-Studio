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
