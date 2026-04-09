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

import logging
from typing import Optional

import librosa
import soundfile as sf
import torch


def load_waveform(
    fname: str,
    sample_rate: int,
    dtype: str = "float32",
    device: torch.device = torch.device("cpu"),
    return_numpy: bool = False,
    max_seconds: Optional[float] = None,
) -> torch.Tensor:
    """
    Load an audio file, preprocess it, and convert to a PyTorch tensor.

    Args:
        fname (str): Path to the audio file.
        sample_rate (int): Target sample rate for resampling.
        dtype (str, optional): Data type to load audio as (default: "float32").
        device (torch.device, optional): Device to place the resulting tensor
            on (default: CPU).
        return_numpy (bool): If True, returns a NumPy array instead of a
            PyTorch tensor.
        max_seconds (float): Maximum length (seconds) of the audio tensor.
            If the audio is longer than this, it will be truncated.

    Returns:
        torch.Tensor: Processed audio waveform as a PyTorch tensor,
            with shape (num_samples,).

    Notes:
        - If the audio is stereo, it will be converted to mono by averaging channels.
        - If the audio's sample rate differs from the target, it will be resampled.
    """
    # Load audio file with specified data type
    wav_data, sr = sf.read(fname, dtype=dtype)

    # Convert stereo to mono if necessary
    if len(wav_data.shape) == 2:
        wav_data = wav_data.mean(1)

    # Resample to target sample rate if needed
    if sr != sample_rate:
        wav_data = librosa.resample(wav_data, orig_sr=sr, target_sr=sample_rate)

    if max_seconds is not None:
        # Trim to max length
        max_length = int(sample_rate * max_seconds)
        if len(wav_data) > max_length:
            wav_data = wav_data[:max_length]
            logging.warning(
                f"Wav file {fname} is longer than {max_seconds}s, "
                f"truncated to {max_seconds}s to avoid OOM."
            )
    if return_numpy:
        return wav_data
    else:
        wav_data = torch.from_numpy(wav_data)
        return wav_data.to(device)
