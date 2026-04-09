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

"""Training configuration dataclass.

Defines ``TrainingConfig``, a dataclass that holds all hyperparameters and paths
for training. Loaded from a JSON config file via ``TrainingConfig.from_json()``
in ``omnivoice.cli.train``.
"""

import json
from dataclasses import asdict, dataclass, field
from typing import List, Optional, Tuple


@dataclass
class TrainingConfig:
    # Key Paths
    output_dir: Optional[str] = None
    data_config: Optional[str] = None

    # Model Specific
    llm_name_or_path: str = "Qwen/Qwen3-0.6B"
    audio_vocab_size: int = 1025  # valid vocab size + 1 (mask token)
    audio_mask_id: int = 1024  # 1024 is the 1025-th token
    num_audio_codebook: int = 8

    # Model Training Specific
    audio_codebook_weights: List[float | int] = field(
        default_factory=lambda: [8, 8, 6, 6, 4, 4, 2, 2]
    )
    drop_cond_ratio: float = 0.1
    prompt_ratio_range: Tuple[float, float] = field(default_factory=lambda: (0.0, 0.3))
    mask_ratio_range: Tuple[float, float] = field(default_factory=lambda: (0.0, 1.0))
    language_ratio: float = 0.8
    use_pinyin_ratio: float = 0.3
    instruct_ratio: float = 1.0
    only_instruct_ratio: float = 0.5

    # Init settings
    resume_from_checkpoint: Optional[str] = None
    init_from_checkpoint: Optional[str] = None

    # Training Hyperparams
    learning_rate: float = 1e-4
    weight_decay: float = 0.01
    max_grad_norm: float = 1.0
    steps: int = 300000
    seed: int = 42
    lr_scheduler_type: str = "cosine"
    warmup_type: str = "ratio"
    warmup_ratio: float = 0.03
    warmup_steps: int = 2000

    # Data
    batch_tokens: int = 8192
    gradient_accumulation_steps: int = 1
    num_workers: int = 8

    # System
    mixed_precision: str = "bf16"
    allow_tf32: bool = True
    use_deepspeed: bool = False
    deepspeed_config: Optional[str] = None

    # Logging
    logging_steps: int = 100
    eval_steps: int = 1000
    save_steps: int = 10000
    keep_last_n_checkpoints: int = -1

    @classmethod
    def from_json(cls, json_path: str):
        with open(json_path, "r") as f:
            cfg_dict = json.load(f)
        valid_keys = cls.__annotations__.keys()
        filtered_dict = {k: v for k, v in cfg_dict.items() if k in valid_keys}
        instance = cls(**filtered_dict)
        return instance

    def save_to_json(self, json_path: str):
        data = asdict(self)
        with open(json_path, "w") as f:
            json.dump(data, f, indent=4)
