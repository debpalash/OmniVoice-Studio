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

"""
Shared utilities for WER evaluation scripts.
"""
import logging

import numpy as np
from jiwer import compute_measures


def process_one(hypothesis: str, truth: str, post_process, lang: str = None) -> dict:
    """
    Computes WER and related metrics for a single hypothesis-truth pair.

    Args:
        hypothesis (str): The transcribed text from the ASR model.
        truth (str): The ground truth transcript.
        post_process (callable): Text normalization function defined by each script.
            Signature: post_process(text, lang) or post_process(text).
        lang (str): The language code for post_process. Pass None if post_process
            does not accept a lang argument.

    Returns:
        dict: A dict containing:
            - truth (str): Post-processed ground truth text.
            - hypothesis (str): Post-processed hypothesis text.
            - wer (float): Word Error Rate.
            - substitutions (int): Number of substitutions.
            - deletions (int): Number of deletions.
            - insertions (int): Number of insertions.
            - word_num (int): Number of words in the post-processed ground truth.
    """
    if lang is not None:
        truth_processed = post_process(truth, lang)
        hypothesis_processed = post_process(hypothesis, lang)
    else:
        truth_processed = post_process(truth)
        hypothesis_processed = post_process(hypothesis)
    measures = compute_measures(truth_processed, hypothesis_processed)
    word_num = len(truth_processed.split(" "))
    return {
        "truth": truth_processed,
        "hypo": hypothesis_processed,
        "wer": measures["wer"],
        "substitutions": measures["substitutions"],
        "deletions": measures["deletions"],
        "insertions": measures["insertions"],
        "word_num": word_num,
    }


def log_metrics(fout, prefix, i_list, d_list, s_list, w_total, ndigits=2):
    """Log weighted WER metrics for a subset of results."""
    metrics_wer = round(
        (np.sum(s_list) + np.sum(d_list) + np.sum(i_list)) / w_total * 100, ndigits
    )
    metrics_inse = np.sum(i_list)
    metrics_dele = np.sum(d_list)
    metrics_subs = np.sum(s_list)

    logging.info(f"{prefix} WER: {metrics_wer}%")
    logging.info(
        f"{prefix} Errors: {metrics_inse} ins, {metrics_dele} del, "
        f"{metrics_subs} sub / {w_total} words"
    )
    if fout:
        fout.write(f"{prefix} WER: {metrics_wer}%\n")
        fout.write(
            f"{prefix} Errors: {metrics_inse} ins, {metrics_dele} del, "
            f"{metrics_subs} sub / {w_total} words\n"
        )
    return metrics_wer
