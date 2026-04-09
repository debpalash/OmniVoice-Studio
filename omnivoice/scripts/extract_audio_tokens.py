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
Extract audio tokens from audio data and pack them into WebDataset shards.

Supports two input modes:

1. WebDataset manifest (data.lst):
    python extract_audio_tokens.py \
        --input_manifest data.lst \
        --tar_output_pattern output/audios/shard-%06d.tar \
        --jsonl_output_pattern output/txts/shard-%06d.jsonl

2. Raw JSONL (each line: {"id": "...", "audio_path": "...", "text": "...", ...}):
    python extract_audio_tokens.py \
        --input_jsonl data.jsonl \
        --tar_output_pattern output/audios/shard-%06d.tar \
        --jsonl_output_pattern output/txts/shard-%06d.jsonl

Output structure:
    output_dir/
    ├── audios/           # WebDataset tar shards (.npy audio tokens + .json metadata)
    │   ├── shard_000000.tar
    │   └── ...
    ├── txts/             # Per-shard JSONL metadata
    │   ├── shard_000000.jsonl
    │   └── ...
    ├── data.lst          # Manifest: <tar_path> <jsonl_path> <sample_count> <total_duration>
    └── errors.jsonl      # Failed samples with error details
"""

import argparse
import io
import json
import logging
import multiprocessing as mp
import os
import warnings
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from pathlib import Path
from typing import Any

import numpy as np
import torch
import webdataset as wds
from torch.utils.data import DataLoader, IterableDataset
from tqdm.auto import tqdm
from transformers import AutoFeatureExtractor, HiggsAudioV2TokenizerModel

from omnivoice.data.dataset import JsonlDatasetReader, WebDatasetReader
from omnivoice.utils.common import str2bool

warnings.filterwarnings(
    "ignore", category=FutureWarning, module="torch.nn.utils.weight_norm"
)

HIGGS_INPUT_SAMPLE_RATE = 24_000


# Global variables: Store tokenizer and device for each worker process
worker_tokenizer = None
worker_feature_extractor = None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input_manifest",
        default=None,
        help="Path to input dataset manifest (data.lst).",
    )
    parser.add_argument(
        "--input_jsonl",
        default=None,
        help="Path to raw JSONL file (alternative to --input_manifest).",
    )
    parser.add_argument(
        "--tar_output_pattern",
        required=True,
        help="Tar shard pattern passed to WebDataset",
    )
    parser.add_argument(
        "--jsonl_output_pattern",
        required=True,
        help="Jsonl shard pattern passed to WebDataset",
    )
    parser.add_argument(
        "--samples_per_shard",
        type=int,
        default=1000,
        help="Maximum records per shard",
    )
    parser.add_argument(
        "--min_num_shards",
        type=int,
        default=32,
        help="Minimum number of output shards (use to ensure "
        "shard count >= num_gpu * num_workers)",
    )
    parser.add_argument(
        "--tokenizer_path",
        type=str,
        default="eustlb/higgs-audio-v2-tokenizer",
        help="Path to audio tokenizer.",
    )
    parser.add_argument(
        "--skip_errors", action="store_true", help="Skip items that fail to process"
    )
    parser.add_argument(
        "--min_length",
        type=float,
        default=0.0,
        help="Minimum audio duration in seconds (e.g. 2.0)",
    )
    parser.add_argument(
        "--max_length",
        type=float,
        default=float("inf"),
        help="Maximum audio duration in seconds (e.g. 15.0)",
    )
    parser.add_argument(
        "--num_machines",
        type=int,
        default=1,
        help="Total number of machines for distributed runs",
    )
    parser.add_argument(
        "--machine_index",
        type=int,
        default=0,
        help="Zero-based machine index when distributing across multiple "
        "machines (e.g. 0, 1, ... num_machines-1)",
    )
    parser.add_argument(
        "--nj_per_gpu",
        type=int,
        default=3,
        help="Number of worker processes to spawn per GPU.",
    )
    parser.add_argument(
        "--loader_workers",
        type=int,
        default=24,
        help="Number of DataLoader workers for streaming IterableDataset.",
    )
    parser.add_argument(
        "--shuffle",
        type=str2bool,
        default=True,
        help="Shuffle data by default.",
    )
    parser.add_argument(
        "--shuffle-seed",
        type=int,
        default=42,
        help="Random seed for shuffle (default: 42).",
    )
    return parser


def count_lines(path):
    with open(path, "rb") as f:
        return sum(buf.count(b"\n") for buf in iter(lambda: f.read(1 << 20), b""))


def serialise_numpy(key: str, tokens: np.ndarray) -> dict:
    buffer = io.BytesIO()
    np.save(buffer, tokens)
    return {"__key__": key, "npy": buffer.getvalue()}


def process_init(rank_queue, tokenizer_path):
    """
    Initialization function for each worker process.
    Assigns a specific GPU to the process and loads the tokenizer.
    """
    global worker_tokenizer, worker_feature_extractor

    # Configure worker process logging
    formatter = (
        "%(asctime)s %(levelname)s [%(filename)s:%(lineno)d]"
        " [Worker %(process)d] %(message)s"
    )
    logging.basicConfig(format=formatter, level=logging.INFO, force=True)

    # Get assigned GPU rank
    rank = rank_queue.get()
    # Determine device
    if rank != -1 and torch.cuda.is_available():
        worker_device = torch.device(f"cuda:{rank}")
    else:
        worker_device = torch.device("cpu")

    logging.debug(f"Worker process initialized with device: {worker_device}")
    # Load tokenizer onto the specified device
    worker_feature_extractor = AutoFeatureExtractor.from_pretrained(tokenizer_path)
    worker_tokenizer = HiggsAudioV2TokenizerModel.from_pretrained(
        tokenizer_path, device_map=worker_device
    )
    logging.debug(f"Tokenizer loaded successfully on device {worker_device}")


def process_single_sample(sample: dict[str, Any]) -> dict[str, Any]:
    """
    Single-sample processing function executed in worker processes.
    Skips invalid samples during streaming processing.
    """
    try:
        audio_tensor = sample.get("audio", None)  # shape (1, T)
        if audio_tensor is None:
            raise ValueError("Sample missing 'audio' field")

        with torch.inference_mode():
            key = sample["label"]["id"]
            inputs = worker_feature_extractor(
                raw_audio=audio_tensor.squeeze(0).numpy(),
                sampling_rate=HIGGS_INPUT_SAMPLE_RATE,
                return_tensors="pt",
            ).to(worker_tokenizer.device)
            audio_tokens = worker_tokenizer.encode(
                inputs["input_values"],
            ).audio_codes.squeeze(0)

            assert len(audio_tokens.shape) == 2
            assert audio_tokens.size(0) == 8

            num_tokens = audio_tokens.size(1)
            metadata = sample["label"]
            metadata["num_tokens"] = num_tokens

            # Convert to numpy format for subsequent serialization (int16 to save space)
            audio_tokens_np = audio_tokens.to(torch.int16).cpu().numpy()

            return {
                "status": "success",
                "key": key,
                "audio_tokens": audio_tokens_np,
                "metadata": metadata,
                "error_msg": None,
            }
    except Exception as e:
        sample_id = sample.get("label", {}).get("id", "unknown")
        logging.error(f"Failed to process sample {sample_id}: {e}")
        return {
            "status": "error",
            "key": sample_id,
            "audio_tokens": None,
            "metadata": None,
            "error_msg": str(e),
        }


def _normalise_value(value: Any) -> Any:
    """Convert tensors and NumPy scalars to serialisable Python objects."""
    if isinstance(value, torch.Tensor):
        if value.ndim == 0:
            return value.item()
        return value.cpu().tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    return value


def _encode_metadata(metadata: dict[str, Any]) -> bytes:
    cleaned: dict[str, Any] = {}
    for key, value in metadata.items():
        if value is None:
            continue
        cleaned[key] = _normalise_value(value)
    return json.dumps(cleaned, ensure_ascii=False).encode("utf-8")


class StreamingLengthFilteredDataset(IterableDataset):
    def __init__(
        self,
        base_iterable,
        min_len: float,
        max_len: float,
        sr: int,
    ):
        self.base_iterable = base_iterable
        self.min_len = min_len
        self.max_len = max_len
        self.sr = sr
        self.filtered_count = 0

    def __iter__(self):
        """Stream samples one by one and filter on the fly."""
        for sample in self.base_iterable:
            try:
                duration = sample["audio"].size(-1) / self.sr
                if self.min_len <= duration <= self.max_len:
                    yield sample
                else:
                    self.filtered_count += 1
                    logging.warning(
                        f"Filtered sample (duration out of range): "
                        f"{sample['label']['id']} ({duration:.2f}s)"
                    )
            except Exception as e:
                logging.warning(f"Skipped invalid sample during streaming: {e}")
                continue


def main() -> None:
    formatter = "%(asctime)s %(levelname)s [%(filename)s:%(lineno)d] %(message)s"
    logging.basicConfig(format=formatter, level=logging.INFO, force=True)
    parser = build_parser()
    args = parser.parse_args()
    mp.set_start_method("spawn", force=True)

    # Validate input arguments
    assert bool(args.input_manifest) != bool(
        args.input_jsonl
    ), "Exactly one of --input_manifest or --input_jsonl must be provided."

    if args.num_machines > 1:
        assert (
            0 <= args.machine_index < args.num_machines
        ), f"machine_index {args.machine_index} must be in [0, {args.num_machines})"

    # Build base dataset and count total samples based on input mode
    if args.input_jsonl:
        logging.info(f"Input mode: raw JSONL ({args.input_jsonl})")
        total_samples = count_lines(args.input_jsonl)
        base_dataset = JsonlDatasetReader(
            args.input_jsonl,
            sample_rate=HIGGS_INPUT_SAMPLE_RATE,
            shuffle=args.shuffle,
            shuffle_seed=args.shuffle_seed,
        )
        loader_workers = args.loader_workers
    else:
        logging.info(f"Input mode: WebDataset manifest ({args.input_manifest})")
        manifest_num_lines = count_lines(args.input_manifest)
        loader_workers = min(args.loader_workers, manifest_num_lines)
        total_samples = 0
        manifests = []
        with open(args.input_manifest, "r", encoding="utf-8") as f:
            for line_id, line in tqdm(
                enumerate(f),
                total=manifest_num_lines,
                desc="Calculating dataset length",
            ):
                items = line.strip().split(" ")
                tar_path, jsonl_path, num_items, duration = (
                    items[0],
                    items[1],
                    int(items[2]),
                    float(items[3]),
                )
                assert os.path.exists(tar_path), f"File {tar_path} does not exist."
                assert os.path.exists(jsonl_path), f"File {jsonl_path} does not exist."
                assert jsonl_path.endswith(
                    ".jsonl"
                ), f"File {jsonl_path} is not a .jsonl file."
                if (
                    args.num_machines > 1
                    and line_id % args.num_machines != args.machine_index
                ):
                    continue
                total_samples += num_items
                manifests.append((tar_path, jsonl_path, num_items, duration))
        logging.info(
            f"Total shards: {manifest_num_lines}, "
            f"Shards for current index: {len(manifests)}"
        )
        base_dataset = WebDatasetReader(
            manifests=manifests,
            sample_rate=HIGGS_INPUT_SAMPLE_RATE,
            evaluation=True,
        )

    # Adjust samples_per_shard if min_num_shards would be violated
    samples_per_shard = args.samples_per_shard
    if total_samples > 0:
        estimated_shards = max(
            1, (total_samples + samples_per_shard - 1) // samples_per_shard
        )
        if estimated_shards < args.min_num_shards:
            samples_per_shard = max(1, total_samples // args.min_num_shards)
            logging.info(
                f"Adjusted samples_per_shard from {args.samples_per_shard} to "
                f"{samples_per_shard} to meet min_num_shards={args.min_num_shards} "
                f"(total_samples={total_samples})"
            )

    # Apply length filter and create DataLoader
    filtered_dataset = StreamingLengthFilteredDataset(
        base_iterable=base_dataset,
        min_len=args.min_length,
        max_len=args.max_length,
        sr=HIGGS_INPUT_SAMPLE_RATE,
    )
    dataloader = DataLoader(
        dataset=filtered_dataset,
        batch_size=None,
        num_workers=loader_workers,
        persistent_workers=loader_workers > 0,
        pin_memory=False,
    )

    # Configure multi-GPU multi-process setup
    num_devices = torch.cuda.device_count()
    if num_devices == 0:
        logging.warning("No GPUs detected - using CPU for processing")
        num_processes = args.nj_per_gpu
    else:
        num_processes = num_devices * args.nj_per_gpu
    logging.info(
        f"GPU count: {num_devices}, Processes per GPU: {args.nj_per_gpu}, "
        f"Total processes: {num_processes}"
    )

    # Shared GPU rank queue for process assignment
    manager = mp.Manager()
    rank_queue = manager.Queue()
    for rank in list(range(num_devices)) * args.nj_per_gpu:
        rank_queue.put(rank)
    if num_devices == 0:
        for _ in range(num_processes):
            rank_queue.put(-1)

    # Prepare output paths
    tar_output_pattern = str(Path(args.tar_output_pattern).expanduser())
    jsonl_output_pattern = str(Path(args.jsonl_output_pattern).expanduser())
    Path(tar_output_pattern).parent.mkdir(parents=True, exist_ok=True)
    Path(jsonl_output_pattern).parent.mkdir(parents=True, exist_ok=True)

    # Determine output directory from tar_output_pattern
    output_dir = Path(tar_output_pattern).parent.parent
    error_log_path = str(output_dir / "errors.jsonl")
    manifest_path = str(output_dir / "data.lst")

    # Setup error logger (writes to errors.jsonl)
    error_logger = logging.getLogger("error_log")
    error_logger.setLevel(logging.ERROR)
    error_logger.handlers.clear()
    error_fh = logging.FileHandler(error_log_path, mode="w", encoding="utf-8")
    error_fh.setFormatter(logging.Formatter("%(message)s"))
    error_logger.addHandler(error_fh)

    # Progress and error tracking
    processed_count = 0
    error_count = 0
    write_error_count = 0
    failed_ids = []
    shard_idx = 0
    shard_sample_count = 0
    shard_duration = 0.0
    shard_manifest = {}  # shard_idx -> (tar_path, jsonl_path, count, duration)

    tar_writer = None
    jsonl_file = None

    def open_new_shard():
        nonlocal tar_writer, jsonl_file, shard_idx, shard_sample_count, shard_duration
        if tar_writer is not None:
            tar_writer.close()
        if jsonl_file is not None:
            jsonl_file.close()
        # Record manifest for the previous shard
        if shard_idx > 0 and shard_sample_count > 0:
            prev_idx = shard_idx - 1
            shard_manifest[prev_idx] = (
                os.path.abspath(tar_output_pattern % prev_idx),
                os.path.abspath(jsonl_output_pattern % prev_idx),
                shard_sample_count,
                shard_duration,
            )
        tar_fname = tar_output_pattern % shard_idx
        jsonl_fname = jsonl_output_pattern % shard_idx
        tar_writer = wds.TarWriter(tar_fname)
        jsonl_file = open(jsonl_fname, "w", encoding="utf-8")
        shard_idx += 1
        shard_sample_count = 0
        shard_duration = 0.0

    def write_sample(key, audio_tokens_np, metadata):
        nonlocal shard_sample_count, write_error_count, shard_duration
        assert tar_writer is not None and jsonl_file is not None
        try:
            token_record = serialise_numpy(key, audio_tokens_np)
            json_record = _encode_metadata(metadata)
            tar_writer.write(token_record)
            jsonl_file.write(json_record.decode("utf-8") + "\n")
            shard_sample_count += 1
            shard_duration += metadata.get("audio_duration", 0.0)
        except Exception as exc:
            write_error_count += 1
            failed_ids.append(key)
            error_logger.error(
                json.dumps({"id": key, "reason": str(exc)}, ensure_ascii=False)
            )
            logging.error(f"Write failed for sample {key}: {exc}")

    def handle_result(result):
        nonlocal processed_count, error_count
        if result["status"] == "success":
            # Rotate shard if needed
            if tar_writer is None or shard_sample_count >= samples_per_shard:
                open_new_shard()
            write_sample(result["key"], result["audio_tokens"], result["metadata"])
            processed_count += 1
        else:
            error_count += 1
            failed_ids.append(result["key"])
            error_logger.error(
                json.dumps(
                    {"id": result["key"], "reason": result["error_msg"]},
                    ensure_ascii=False,
                )
            )
            if not args.skip_errors:
                raise RuntimeError(
                    f"Sample {result['key']} processing failed due "
                    f"to {result['error_msg']} - terminating"
                )
            logging.warning(
                f"Skipping failed sample {result['key']}: {result['error_msg']}"
            )

    main_progress = tqdm(total=total_samples, desc="Extracting Audio Tokens")

    try:
        with ProcessPoolExecutor(
            max_workers=num_processes,
            initializer=process_init,
            initargs=(rank_queue, args.tokenizer_path),
        ) as executor:
            logging.info(f"Submitting tasks... ({num_processes} workers)")
            futures = set()
            max_pending = num_processes * 10

            def drain_completed():
                """Wait for at least one future to complete, process all done."""
                nonlocal futures
                done, _ = wait(futures, return_when=FIRST_COMPLETED)
                for f in done:
                    futures.discard(f)
                    result = f.result()
                    main_progress.update(1)
                    handle_result(result)
                    main_progress.set_postfix(
                        Samples=processed_count,
                        Errors=error_count,
                    )

            # Stream samples from DataLoader
            for sample in dataloader:
                if len(futures) >= max_pending:
                    drain_completed()

                future = executor.submit(process_single_sample, sample)
                futures.add(future)

            # Process remaining futures
            logging.info("Processing remaining pending samples...")
            while futures:
                drain_completed()

    except Exception:
        logging.error("Critical error during processing", exc_info=True)
        raise
    finally:
        main_progress.close()
        if tar_writer is not None:
            tar_writer.close()
        if jsonl_file is not None:
            jsonl_file.close()
        # Record the last shard in the manifest
        if shard_idx > 0 and shard_sample_count > 0:
            last_idx = shard_idx - 1
            shard_manifest[last_idx] = (
                os.path.abspath(tar_output_pattern % last_idx),
                os.path.abspath(jsonl_output_pattern % last_idx),
                shard_sample_count,
                shard_duration,
            )

    # Write manifest file (data.lst)
    with open(manifest_path, "w", encoding="utf-8") as mf:
        for idx in sorted(shard_manifest.keys()):
            tar_path, jsonl_path, count, duration = shard_manifest[idx]
            mf.write(f"{tar_path} {jsonl_path} {count} {duration:.3f}\n")

    # Output final statistics
    total_failed = error_count + write_error_count
    filtered_and_skipped = total_samples - processed_count - total_failed
    logging.info(
        f"Processing Complete - Successful: {processed_count}, Failed: {total_failed}, "
        f"Filtered/Skipped: {filtered_and_skipped}, Shards written: {shard_idx}"
    )
    logging.info(f"Manifest written to: {manifest_path} ({len(shard_manifest)} shards)")
    if total_failed > 0:
        logging.info(f"Error details: {error_log_path}")
    if failed_ids and args.skip_errors:
        logging.warning(
            f"Failed sample IDs (count: {len(failed_ids)}): {failed_ids[:100]}..."
        )
    if write_error_count > 0 and not args.skip_errors:
        raise RuntimeError(
            f"{write_error_count} samples failed to write - check logs for details"
        )


if __name__ == "__main__":
    main()
