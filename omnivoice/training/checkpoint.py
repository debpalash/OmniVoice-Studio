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

"""Checkpoint saving, resuming, and training logging.

Provides utilities for saving/loading training checkpoints and logging metrics
to console and trackers (TensorBoard/WandB). Used by ``OmniTrainer``.

Key components:
- ``TrainLogger``: Logs training metrics to console and Accelerate trackers.
- ``save_checkpoint()``: Saves model, optimizer, and scheduler state.
- ``load_checkpoint()``: Restores training state from a checkpoint directory.
"""

import logging
import os
import shutil
import time
from typing import Any, Dict, Optional

import torch
from accelerate import Accelerator
from tqdm.auto import tqdm

logger = logging.getLogger(__name__)


class TrainLogger:
    """
    Handles logging to console and trackers (TensorBoard/WandB)
    """

    def __init__(self, accelerator: Accelerator, total_steps: int, logging_steps: int):
        self.accelerator = accelerator
        self.total_steps = total_steps
        self.logging_steps = logging_steps
        self.start_time = None
        self.progress_bar = None

    def start(self, start_step: int = 0):
        self.start_time = time.time()

        if self.accelerator.is_main_process:
            self.progress_bar = tqdm(
                total=self.total_steps,
                initial=start_step,
                desc="Training",
                dynamic_ncols=True,
                disable=not self.accelerator.is_local_main_process,
            )

    def update(
        self, step: int, loss: Optional[float] = None, lr: Optional[float] = None
    ):
        """
        Called every step to update the progress bar UI.
        """
        if self.progress_bar:
            self.progress_bar.update(1)

            # Update real-time metrics on the progress bar itself
            postfix = {}
            if loss is not None:
                postfix["loss"] = f"{loss:.4f}"
            if lr is not None:
                postfix["lr"] = f"{lr:.2e}"

            if postfix:
                self.progress_bar.set_postfix(postfix)

    def log_metrics(self, step: int, metrics: Dict[str, Any]):
        """
        Called periodically to log to TensorBoard/WandB and console.
        """
        # Log to trackers (TensorBoard, etc.)
        self.accelerator.log(metrics, step=step)

        if self.accelerator.is_main_process:
            # Format for console log (separate from tqdm)
            # Remove keys that are redundant or too verbose for one line
            formatted_metrics = []
            for k, v in metrics.items():
                if isinstance(v, float):
                    val_str = f"{v:.4f}"
                    if val_str == "0.0000" and v != 0:
                        formatted_metrics.append(f"{k}: {v:.2e}")
                    else:
                        formatted_metrics.append(f"{k}: {val_str}")
                else:
                    formatted_metrics.append(f"{k}: {v}")

            # Use external logger to write to file, tqdm.write to avoid breaking bar
            msg = f"Step {step} | " + " | ".join(formatted_metrics)
            if self.progress_bar:
                self.progress_bar.write(msg)
            else:
                logger.info(msg)

    def close(self):
        if self.progress_bar:
            self.progress_bar.close()


def save_checkpoint(
    accelerator: Accelerator,
    model: torch.nn.Module,
    tokenizer: Any,
    output_dir: str,
    step: int,
    keep_last_n: int = 3,
):
    """
    Saves model, tokenizer, and accelerator states (optimizer/scheduler).
    Manages rotation of checkpoints.
    """
    checkpoint_dir = os.path.join(output_dir, f"checkpoint-{step}")

    # 1. Save Accelerator State (Optimizer, Scheduler, RNG, Scaler)
    accelerator.save_state(checkpoint_dir)

    # 2. Save Model in HF format (config.json + pytorch_model.bin/safetensors)
    unwrap_model = accelerator.unwrap_model(model)
    unwrap_model.save_pretrained(
        checkpoint_dir,
        is_main_process=accelerator.is_main_process,
        save_function=accelerator.save,
    )

    # 3. Save Tokenizer
    if accelerator.is_main_process:
        tokenizer.save_pretrained(checkpoint_dir)

    logger.info(f"Saved checkpoint to {checkpoint_dir}")

    # 4. Rotate checkpoints (Keep last N)
    if accelerator.is_main_process and keep_last_n > 0:
        checkpoints = [
            d
            for d in os.listdir(output_dir)
            if d.startswith("checkpoint-")
            and os.path.isdir(os.path.join(output_dir, d))
        ]
        # Sort by step number
        checkpoints.sort(key=lambda x: int(x.split("-")[-1]))

        if len(checkpoints) > keep_last_n:
            to_remove = checkpoints[:-keep_last_n]
            for d in to_remove:
                shutil.rmtree(os.path.join(output_dir, d))
                logger.info(f"Removed old checkpoint {d}")


def load_checkpoint(accelerator: Accelerator, checkpoint_path: str):
    """
    Resumes training state.
    """
    logger.info(f"Resuming from {checkpoint_path}")
    accelerator.load_state(checkpoint_path)

    # Try to infer step
    try:
        clean_path = os.path.normpath(checkpoint_path)
        step = int(os.path.basename(clean_path).split("-")[-1])
        return step
    except ValueError:
        return 0
