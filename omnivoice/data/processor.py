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

"""Training sample processor for OmniVoice.

Converts raw audio/text samples into model-ready tensors: applies prompt/mask
tokenization, randomly drops conditioning, and injects language/instruct tokens.
Used by ``omnivoice.training.builder`` to build the data pipeline.

Contains two processor classes:
- ``OmniVoiceSampleProcessor``: Full processor used for training.
- ``OmniVoiceSimpleSampleProcessor``: Simplified processor (not used for training).
"""

import random
from typing import Any, Dict

import torch


class OmniVoiceSampleProcessor:
    """
    Handles the logic of processing a raw sample into tensors
    (masking, tokenization, etc.).
    """

    def __init__(
        self,
        text_tokenizer: Any,
        num_channels: int,
        audio_mask_id: int,
        prompt_ratio_range: tuple,
        mask_ratio_range: tuple,
        drop_cond_ratio: float,
        language_ratio: float,
        use_pinyin_ratio: float,
        instruct_ratio: float,
        only_instruct_ratio: float,
    ):
        self.text_tokenizer = text_tokenizer
        self.num_channels = num_channels
        self.audio_mask_id = audio_mask_id
        self.prompt_ratio_range = prompt_ratio_range
        self.mask_ratio_range = mask_ratio_range
        self.drop_cond_ratio = drop_cond_ratio

        self.language_ratio = language_ratio
        self.use_pinyin_ratio = use_pinyin_ratio
        self.instruct_ratio = instruct_ratio
        self.only_instruct_ratio = only_instruct_ratio

    def __call__(self, sample: Dict[str, Any]) -> Dict[str, Any]:

        # clean_start_token_idx is only used for prompt denoising training,
        # where the prompt region is augmented with noises and the model
        # needs to learn to recover the clean prompt.
        # clean_start_token_idx indicates the start index of the clean generated token.
        if "clean_start_token_idx" in sample["label"]:
            drop_cond = False
        else:
            drop_cond = random.uniform(0, 1) < self.drop_cond_ratio

        if drop_cond:
            prompt_ratio = 0.0
            drop_text = True
            use_language = False
            use_instruct = False
        else:
            prompt_ratio = random.uniform(*self.prompt_ratio_range)
            drop_text = False
            use_language = random.uniform(0, 1) < self.language_ratio
            use_instruct = random.uniform(0, 1) < self.instruct_ratio
            if use_instruct and random.uniform(0, 1) < self.only_instruct_ratio:
                prompt_ratio = 0.0

        mask_ratio = random.uniform(*self.mask_ratio_range)

        # --- Style ---
        style = ""
        if use_language:
            language = sample["label"].get("language_id", "None")
        else:
            language = "None"
        if use_instruct:
            instruct = sample["label"].get("instruct", "None")
        else:
            instruct = "None"

        if "clean_start_token_idx" in sample["label"]:
            style += "<|denoise|>"

        style += f"<|lang_start|>{language}<|lang_end|>"
        style += f"<|instruct_start|>{instruct}<|instruct_end|>"

        style_inputs = self.text_tokenizer(style, return_tensors="pt").input_ids.repeat(
            self.num_channels, 1
        )
        style_labels = torch.full(
            style_inputs.shape, -100
        )  # Style prompt does not compute loss

        # --- Text ---
        if (
            "text_pinyin" in sample["label"]
            and random.uniform(0, 1) < self.use_pinyin_ratio
        ):
            text = sample["label"]["text_pinyin"]
        else:
            text = sample["label"]["text"]
        text_inputs = self.text_tokenizer(
            f"<|text_start|>{text}<|text_end|>", return_tensors="pt"
        ).input_ids.repeat(self.num_channels, 1)
        text_labels = torch.full(text_inputs.shape, -100)  # Text does not compute loss

        # --- Audio ---
        audio_tokens = sample["audio_tokens"].long()

        # Masking Logic
        if "clean_start_token_idx" in sample["label"]:
            prompt_length = sample["label"]["clean_start_token_idx"]
        else:
            prompt_length = int(audio_tokens.shape[1] * prompt_ratio)

        audio_inputs = audio_tokens.clone()
        audio_labels = audio_tokens.clone()

        # Apply masking
        maskable_region = audio_tokens[:, prompt_length:]
        token_mask = torch.rand(maskable_region.shape) < mask_ratio
        audio_inputs[:, prompt_length:][token_mask] = self.audio_mask_id
        audio_labels[:, prompt_length:][
            ~token_mask
        ] = -100  # Only compute loss on masked tokens
        if not drop_cond:
            audio_labels[:, :prompt_length] = -100  # No loss on prompt region

        # --- Concatenation ---
        if drop_text:
            input_ids = audio_inputs
            labels = audio_labels
            total_length = input_ids.shape[1]
            audio_mask = torch.ones(total_length, dtype=torch.bool)
        else:
            input_ids = torch.cat([style_inputs, text_inputs, audio_inputs], dim=1)
            labels = torch.cat([style_labels, text_labels, audio_labels], dim=1)
            total_length = input_ids.shape[1]
            audio_start_idx = style_inputs.shape[1] + text_inputs.shape[1]
            audio_mask = torch.zeros(total_length, dtype=torch.bool)
            audio_mask[audio_start_idx:] = True

        return_dict = {
            "input_ids": input_ids,  # [C, L]
            "labels": labels,  # [C, L]
            "audio_mask": audio_mask,  # [L]
            "length": total_length,
        }

        return return_dict


class OmniVoiceSimpleSampleProcessor:
    """
    Handles the logic of processing a raw sample into tensors
    (masking, tokenization, etc.).
    This is a simpler version that does not include language, instructions,
        or denoising prompts.
    We do not use it for training as OmniVoiceSampleProcessor can cover this case.
    We keep it as a reference implementation for users to understand the basic logics.
    """

    def __init__(
        self,
        text_tokenizer: Any,
        num_channels: int,
        audio_mask_id: int,
        prompt_ratio_range: tuple,
        mask_ratio_range: tuple,
        drop_cond_ratio: float,
    ):
        self.text_tokenizer = text_tokenizer
        self.num_channels = num_channels
        self.audio_mask_id = audio_mask_id
        self.prompt_ratio_range = prompt_ratio_range
        self.mask_ratio_range = mask_ratio_range
        self.drop_cond_ratio = drop_cond_ratio

    def __call__(self, sample: Dict[str, Any]) -> Dict[str, Any]:
        drop_cond = random.uniform(0, 1) < self.drop_cond_ratio
        mask_ratio = random.uniform(*self.mask_ratio_range)

        if drop_cond:
            prompt_ratio = 0.0
        else:
            prompt_ratio = random.uniform(*self.prompt_ratio_range)

        # --- Text ---
        text = sample["label"]["text"]
        text_inputs = self.text_tokenizer(
            f"<|text_start|>{text}<|text_end|>", return_tensors="pt"
        ).input_ids.repeat(self.num_channels, 1)
        text_labels = torch.full(text_inputs.shape, -100)  # Text does not compute loss

        # --- Audio ---
        audio_tokens = sample["audio_tokens"].long()

        # Masking Logic
        prompt_length = int(audio_tokens.shape[1] * prompt_ratio)
        audio_inputs = audio_tokens.clone()
        audio_labels = audio_tokens.clone()

        # Apply masking
        maskable_region = audio_tokens[:, prompt_length:]
        token_mask = torch.rand(maskable_region.shape) < mask_ratio
        audio_inputs[:, prompt_length:][token_mask] = self.audio_mask_id
        audio_labels[:, prompt_length:][
            ~token_mask
        ] = -100  # Only compute loss on masked tokens

        if not drop_cond:
            # No loss on prompt region
            audio_labels[:, :prompt_length] = -100

        # --- Concatenation ---
        if drop_cond:
            input_ids = audio_inputs
            labels = audio_labels
            total_length = input_ids.shape[1]
            audio_mask = torch.ones(total_length, dtype=torch.bool)
        else:
            input_ids = torch.cat([text_inputs, audio_inputs], dim=1)
            labels = torch.cat([text_labels, audio_labels], dim=1)
            total_length = input_ids.shape[1]
            audio_start_idx = text_inputs.shape[1]
            audio_mask = torch.zeros(total_length, dtype=torch.bool)
            audio_mask[audio_start_idx:] = True

        return_dict = {
            "input_ids": input_ids,  # [C, L]
            "labels": labels,  # [C, L]
            "audio_mask": audio_mask,  # [L]
            "length": total_length,
        }

        return return_dict
