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

"""Data collator with packing for efficient training.

Packs multiple samples into a single sequence of fixed length (``batch_tokens``)
to maximize GPU utilization, instead of padding each sample individually.
Used by ``omnivoice.training.builder`` to create the collate function.
"""

from typing import Any, Dict, List

import torch


class PackingDataCollator:
    def __init__(self, processor, batch_tokens: int):
        self.batch_tokens = batch_tokens
        self.processor = processor

    def __call__(self, processed_samples: List[Dict[str, Any]]) -> Dict[str, Any]:

        target_length = self.batch_tokens

        input_ids = torch.cat(
            [s["input_ids"] for s in processed_samples], dim=1
        )  # [C, Total_Len], C is the number of codebook layers of the audio tokenizer
        labels = torch.cat(
            [s["labels"] for s in processed_samples], dim=1
        )  # [C, Total_Len]
        audio_mask = torch.cat(
            [s["audio_mask"] for s in processed_samples], dim=0
        )  # [Total_Len]

        position_ids = torch.cat(
            [torch.arange(s["length"], dtype=torch.long) for s in processed_samples],
            dim=0,
        )  # [Total_Len]

        pad_length = target_length - input_ids.shape[1]

        input_ids = torch.nn.functional.pad(
            input_ids,
            pad=(0, pad_length),
            value=self.processor.text_tokenizer.pad_token_id,
        )

        labels = torch.nn.functional.pad(labels, pad=(0, pad_length), value=-100)

        audio_mask = torch.nn.functional.pad(
            audio_mask, pad=(0, pad_length), value=False
        )

        position_ids = torch.nn.functional.pad(
            position_ids, pad=(0, pad_length), value=0
        )

        return_list = {
            "input_ids": input_ids.unsqueeze(0),  # [1, C, L]
            "labels": labels.unsqueeze(0),  # [1, C, L]
            "audio_mask": audio_mask.unsqueeze(0),  # [1, L]
            "position_ids": position_ids.unsqueeze(0),  # [1, L]
        }

        document_ids_list = []

        for i, s in enumerate(processed_samples):
            seq_len = s["length"]
            document_ids_list.append(torch.full((seq_len,), i, dtype=torch.int32))

        document_ids = torch.cat(document_ids_list, dim=0)

        document_ids = torch.nn.functional.pad(
            document_ids, pad=(0, pad_length), value=-1
        )
        return_list["document_ids"] = document_ids.unsqueeze(0)  # [1, L]

        return return_list
