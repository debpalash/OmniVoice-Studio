#!/usr/bin/env bash
# Launches llama-server hosting Gemma 4 E4B (Q4_K_XL) on port 8001
# with OpenAI-compatible API. Pair with `source scripts/dub_translator_env.sh gemma`.

set -euo pipefail

MODEL_DIR="${LLAMA_CACHE:-$HOME/.cache/llama.cpp}/gemma-4-E4B"
MODEL_FILE="$(ls "$MODEL_DIR"/*UD-Q4_K_XL*.gguf 2>/dev/null | head -1)"

if [[ -z "$MODEL_FILE" ]]; then
  echo "Model GGUF missing in $MODEL_DIR. Pulling..."
  hf download unsloth/gemma-4-E4B-it-GGUF \
    --include "*UD-Q4_K_XL*" \
    --local-dir "$MODEL_DIR"
  MODEL_FILE="$(ls "$MODEL_DIR"/*UD-Q4_K_XL*.gguf | head -1)"
fi

echo "Serving $MODEL_FILE on http://localhost:8001/v1"

exec llama-server \
  --model "$MODEL_FILE" \
  --alias "gemma-4-E4B" \
  --port 8001 \
  --ctx-size 16384 \
  --temp 1.0 --top-p 0.95 --top-k 64 \
  --chat-template-kwargs '{"enable_thinking":false}'
