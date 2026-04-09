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

"""Data utilities for batch inference and evaluation.

Provides ``read_test_list()`` to parse JSONL test list files used by
``omnivoice.cli.infer_batch`` and evaluation scripts.
"""

import json
import logging
from pathlib import Path


def read_test_list(path):
    """Read a JSONL test list file.

    Each line should be a JSON object with fields:
        id, text, ref_audio, ref_text, language_id, language_name, duration, speed

    language_id, language_name, duration, and speed are optional (default to None).

    Returns a list of dicts.
    """
    path = Path(path)
    samples = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                logging.warning(f"Skipping malformed JSON at line {line_no}: {line}")
                continue

            sample = {
                "id": obj.get("id"),
                "text": obj.get("text"),
                "ref_audio": obj.get("ref_audio"),
                "ref_text": obj.get("ref_text"),
                "language_id": obj.get("language_id"),
                "language_name": obj.get("language_name"),
                "duration": obj.get("duration"),
                "speed": obj.get("speed"),
                "instruct": obj.get("instruct"),
            }
            samples.append(sample)
    return samples
