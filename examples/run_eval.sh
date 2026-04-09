#!/bin/bash

# Evaluate OmniVoice models on TTS benchmarks.

# Stage 1: Download the test sets and evaluation models.
# Stage 2: LibriSpeech-PC
# Stage 3: seedtts_en
# Stage 4: seedtts_zh
# Stage 5: fleurs
# Stage 6: minimax

set -euo pipefail

# Specify the stages to run by setting the `stage` and `stop_stage` variables. 
stage=1
stop_stage=6

# Available GPUs for evaluation. Adjust this according to your setup.
export CUDA_VISIBLE_DEVICES="0,1,2,3,4,5,6,7"

# Specify the checkpoint to evaluate.
CHECKPOINT=k2-fsa/OmniVoice
emilia_checkpoint=false

# CHECKPOINT=k2-fsa/OmniVoice
# emilia_checkpoint=true

# For the OmniVoice-Emilia checkpoint, we set denoise to False and lang_id to None
#, as the model is trained without prompt denoising or language id.

if [ "${emilia_checkpoint}" = true ]; then
    infer_options="--preprocess_prompt False \
        --postprocess_output False \
        --batch_duration 600 \
        --denoise False \
        --lang_id None \
        --audio_chunk_threshold 1000"
else
    infer_options="--preprocess_prompt False \
        --postprocess_output False \
        --batch_duration 600 \
        --audio_chunk_threshold 1000"
fi

export PYTHONPATH="$(cd "$(dirname "$0")/.." && pwd):${PYTHONPATH:-}"

download_dir="download"
TTS_EVAL_MODEL_DIR="${download_dir}/tts_eval_models/"
TTS_EVAL_DATA_DIR="${download_dir}/tts_eval_datasets/"

# Map test_name to its test.jsonl path.
get_test_list() {
    case "$1" in
        librispeech_pc) echo "${TTS_EVAL_DATA_DIR}/librispeech_pc_test_clean.jsonl" ;;
        seedtts_en)     echo "${TTS_EVAL_DATA_DIR}/seedtts_test_en.jsonl" ;;
        seedtts_zh)     echo "${TTS_EVAL_DATA_DIR}/seedtts_test_zh.jsonl" ;;
        minimax)        echo "${TTS_EVAL_DATA_DIR}/minimax_multilingual_24.jsonl" ;;
        fleurs)         echo "${TTS_EVAL_DATA_DIR}/fleurs_multilingual_102.jsonl" ;;
        *)              echo ""; return 1 ;;
    esac
}

# ============================================================
# Stage 1: Prepare the test sets and evaluation models
# ============================================================

if [ ${stage} -le 1 ] && [ ${stop_stage} -ge 1 ]; then
    echo "Stage 1: Download test sets and evaluation models"

    hf_repo=k2-fsa/TTS_eval_datasets
    mkdir -p ${TTS_EVAL_DATA_DIR}/
    for file in \
        librispeech_pc_test_clean.jsonl \
        librispeech_pc_test_clean_transcript.jsonl \
        seedtts_test_en.jsonl \
        seedtts_test_zh.jsonl \
        minimax_multilingual_24.jsonl \
        fleurs_multilingual_102.jsonl; do
        echo "Downloading ${file}..."
        huggingface-cli download \
                --repo-type dataset \
                --local-dir ${TTS_EVAL_DATA_DIR}/ \
                ${hf_repo} \
                ${file}
    done

    for file in \
        librispeech_pc_testset.tar.gz \
        seedtts_testset.tar.gz \
        minimax_multilingual_24.tar.gz \
        fleurs_multilingual_102.tar.gz; do
        echo "Downloading ${file}..."
        huggingface-cli download \
                --repo-type dataset \
                --local-dir ${TTS_EVAL_DATA_DIR}/ \
                ${hf_repo} \
                ${file}

        echo "Extracting ${file}..."
        tar -xzf ${TTS_EVAL_DATA_DIR}/${file} -C ${TTS_EVAL_DATA_DIR}/
    done

    echo "Download all evaluation models"
    hf_repo=k2-fsa/TTS_eval_models
    mkdir -p ${TTS_EVAL_MODEL_DIR}
    huggingface-cli download \
        --local-dir ${TTS_EVAL_MODEL_DIR} \
        ${hf_repo}
fi

# ============================================================
# Stage 2: Evaluation on LibriSpeech-PC
# ============================================================


if [ ${stage} -le 2 ] && [ ${stop_stage} -ge 2 ]; then
    echo "Stage 2: Evaluation on LibriSpeech-PC"
    wav_path="results/librispeech_pc"
    test_jsonl="$(get_test_list librispeech_pc)"
    transcript_jsonl="${TTS_EVAL_DATA_DIR}/librispeech_pc_test_clean_transcript.jsonl"

    python -m omnivoice.cli.infer_batch \
        --model "${CHECKPOINT}" \
        --test_list "${test_jsonl}" \
        --res_dir "${wav_path}" ${infer_options}

    python -m omnivoice.eval.speaker_similarity.sim \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.sim.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"

    python -m omnivoice.eval.wer.hubert \
        --wav-path "${wav_path}" \
        --test-list "${transcript_jsonl}" \
        --decode-path "${wav_path}.wer.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"

    python -m omnivoice.eval.mos.utmos \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.mos.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"
fi


# ============================================================
# Stage 3: Evaluation on Seed-TTS en
# ============================================================

if [ ${stage} -le 3 ] && [ ${stop_stage} -ge 3 ]; then
    echo "Stage 3: Evaluation on Seed-TTS en"
    wav_path="results/seedtts_en"
    test_jsonl="$(get_test_list seedtts_en)"

    python -m omnivoice.cli.infer_batch \
        --model "${CHECKPOINT}" \
        --test_list "${test_jsonl}" \
        --res_dir "${wav_path}"  ${infer_options}


    python -m omnivoice.eval.speaker_similarity.sim \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.sim.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"

    python -m omnivoice.eval.wer.seedtts \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.wer.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}" \
        --lang en

    python -m omnivoice.eval.mos.utmos \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.mos.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"
fi


# ============================================================
# Stage 4: Evaluation on Seed-TTS zh
# ============================================================

if [ ${stage} -le 4 ] && [ ${stop_stage} -ge 4 ]; then
    echo "Stage 4: Evaluation on Seed-TTS zh"
    wav_path="results/seedtts_zh"
    test_jsonl="$(get_test_list seedtts_zh)"

    python -m omnivoice.cli.infer_batch \
        --model "${CHECKPOINT}" \
        --test_list "${test_jsonl}" \
        --res_dir "${wav_path}"  ${infer_options}


    python -m omnivoice.eval.speaker_similarity.sim \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.sim.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"

    python -m omnivoice.eval.wer.seedtts \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.wer.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}" \
        --lang zh

    python -m omnivoice.eval.mos.utmos \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.mos.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"
fi



# ============================================================
# Stage 5: Evaluation on MiniMax multilingual
# ============================================================

if [ ${stage} -le 5 ] && [ ${stop_stage} -ge 5 ]; then
    echo "Stage 5: Evaluation on MiniMax multilingual"
    wav_path="results/minimax"
    test_jsonl="$(get_test_list minimax)"

    python -m omnivoice.cli.infer_batch \
        --model "${CHECKPOINT}" \
        --test_list "${test_jsonl}" \
        --res_dir "${wav_path}"  ${infer_options}

    python -m omnivoice.eval.speaker_similarity.sim \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.sim.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"

    python -m omnivoice.eval.wer.minimax \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.wer.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"
fi


# ============================================================
# Stage 6: Evaluation on FLEURS multilingual
# ============================================================

if [ ${stage} -le 6 ] && [ ${stop_stage} -ge 6 ]; then
    echo "Stage 6: Evaluation on FLEURS multilingual"
    wav_path="results/fleurs"
    test_jsonl="$(get_test_list fleurs)"

    python -m omnivoice.cli.infer_batch \
        --model "${CHECKPOINT}" \
        --test_list "${test_jsonl}" \
        --res_dir "${wav_path}"  ${infer_options}


    python -m omnivoice.eval.speaker_similarity.sim \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.sim.log" \
        --model-dir "${TTS_EVAL_MODEL_DIR}"

    # Evaluation on FLEURS requires omnilingual-asr, which has dependencies that
    # conflict with other packages (at least the transformers package) in our project.

    # To evaluate on FLEURS, we suggest users to set up a separate virtual
    # environment to install omnilingual-asr. Install instructions can be found in
    # https://github.com/facebookresearch/omnilingual-asr

    python ${PWD}/../omnivoice/eval/wer/fleurs.py \
        --wav-path "${wav_path}" \
        --test-list "${test_jsonl}" \
        --decode-path "${wav_path}.wer.log" \
        --model-card omniASR_LLM_Unlimited_7B_v2 \
        --chunk-size 100 \
        --batch-size 50
fi
