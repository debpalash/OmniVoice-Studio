#!/bin/bash

# This script demonstrates how to run the full training pipeline on the Emilia dataset.

set -euo pipefail

stage=0
stop_stage=2

# ====== Modify as needed ======
# GPUs to use
GPU_IDS="0,1,2,3,4,5,6,7"
NUM_GPUS=8

# Download directory for raw Emilia data
dl_dir="download"

# Directory containing JSONL manifests for train/dev splits
# Stage 0 will check for the presence of the following files:
#   data/emilia/manifests/emilia_en_train.jsonl
#   data/emilia/manifests/emilia_en_dev.jsonl
#   data/emilia/manifests/emilia_zh_train.jsonl
#   data/emilia/manifests/emilia_zh_dev.jsonl
MANIFEST_DIR="data/emilia/manifests"

# Directory to write tokenized WebDataset shards
TOKEN_DIR="data/emilia/tokens"

# Audio tokenizer model (HuggingFace repo or local path)
TOKENIZER_PATH="eustlb/higgs-audio-v2-tokenizer"

# Training config file
TRAIN_CONFIG="config/train_config_emilia.json"

# Data config file
data_config="config/data_config_emilia.json"

# Output directory for checkpoints
OUTPUT_DIR="exp/omnivoice_emilia"
# =================================

export PYTHONPATH="$(cd "$(dirname "$0")/.." && pwd):${PYTHONPATH:-}"


# Stage 0: Download data
if [ $stage -le 0 ] && [ $stop_stage -ge 0 ]; then
    echo "Stage 0: Download data"

    # You should manually download the Emilia dataset from
    # https://openxlab.org.cn/datasets/Amphion/Emilia
    # or https://huggingface.co/datasets/amphion/Emilia-Dataset/tree/fc71e07
    # and place it in the download directory.
    # Your download directory should at least contain the following structure:
    #
    #    download/Amphion___Emilia
    #    ├── raw
    #    │   ├── EN
    #    │   └── ZH

    if [ ! -d "$dl_dir"/Amphion___Emilia/raw ]; then
        echo "Please refer https://openxlab.org.cn/datasets/Amphion/Emilia to download the dataset."
        exit 1
    fi

    # We require JSONL manifests for the training and dev splits. You can
    # either generate them yourself using the raw data and the provided
    # metadata, or download our processed JSONL manifests from HuggingFace.
    # https://huggingface.co/datasets/zhu-han/Emilia-Manifests
    #
    # Place them as data/emilia/manifests/{emilia_en_train,emilia_en_dev,emilia_zh_train,emilia_zh_dev}.jsonl

    for split in emilia_en_dev emilia_zh_dev emilia_en_train emilia_zh_train; do
        if [ ! -f "${MANIFEST_DIR}/${split}.jsonl" ]; then
            echo "Please download the manifest for ${split} and place it in ${MANIFEST_DIR}/${split}.jsonl"
            exit 1
        fi
    done

    echo "  Done. All manifests and data are in place."
fi


# Stage 1: Tokenize splits into directories matching data_config_emilia.json
if [ $stage -le 1 ] && [ $stop_stage -ge 1 ]; then
    echo "Stage 1: Tokenizing audio"

    for split in emilia_en_dev emilia_zh_dev emilia_en_train emilia_zh_train; do
        echo "  Tokenizing ${split} from ${MANIFEST_DIR}/${split}.jsonl"

        CUDA_VISIBLE_DEVICES=${GPU_IDS} \
            python -m omnivoice.scripts.extract_audio_tokens \
            --input_jsonl "${MANIFEST_DIR}/${split}.jsonl" \
            --tar_output_pattern "${TOKEN_DIR}/${split}/audios/shard-%06d.tar" \
            --jsonl_output_pattern "${TOKEN_DIR}/${split}/txts/shard-%06d.jsonl" \
            --tokenizer_path "${TOKENIZER_PATH}" \
            --nj_per_gpu 3 \
            --shuffle True

        echo "  Done. Tokens written to ${TOKEN_DIR}/${split}"
    done
fi


# Stage 2: Train
if [ $stage -le 2 ] && [ $stop_stage -ge 2 ]; then
    echo "Stage 2: Training"

    accelerate launch \
        --gpu_ids "${GPU_IDS}" \
        --num_processes ${NUM_GPUS} \
        -m omnivoice.cli.train \
        --train_config ${TRAIN_CONFIG} \
        --data_config ${data_config} \
        --output_dir ${OUTPUT_DIR}
fi