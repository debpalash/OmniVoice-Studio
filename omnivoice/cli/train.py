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

"""Training CLI for OmniVoice.

Launches distributed training via HuggingFace Accelerate.
Supports pre-training on Emilia data and finetuning on custom data.

Usage:
    accelerate launch --gpu_ids 0,1,2,3 --num_processes 4 \\
        -m omnivoice.cli.train \\
        --train_config train_config.json \\
        --data_config data_config.json \\
        --output_dir output/

See examples/run_emilia.sh and examples/run_finetune.sh for full pipelines.
"""

import argparse

from omnivoice.training.builder import build_dataloaders, build_model_and_tokenizer
from omnivoice.training.config import TrainingConfig
from omnivoice.training.trainer import OmniTrainer


def main():
    parser = argparse.ArgumentParser(description="OmniVoice Training Entry Point")
    parser.add_argument(
        "--train_config", type=str, required=True, help="Path to config JSON"
    )
    parser.add_argument(
        "--output_dir", type=str, required=True, help="Where to save checkpoints"
    )
    parser.add_argument(
        "--data_config", type=str, required=True, help="Path to data config JSON"
    )
    args = parser.parse_args()

    # 1. Load Configuration
    config = TrainingConfig.from_json(args.train_config)
    config.output_dir = args.output_dir
    config.data_config = args.data_config

    # 2. Build Components
    model, tokenizer = build_model_and_tokenizer(config)
    train_loader, eval_loader = build_dataloaders(config, tokenizer)

    # 3. Initialize Trainer and Start
    trainer = OmniTrainer(
        model=model,
        config=config,
        train_dataloader=train_loader,
        eval_dataloader=eval_loader,
        tokenizer=tokenizer,
    )
    trainer.train()


if __name__ == "__main__":
    main()
