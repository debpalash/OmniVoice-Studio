#!/usr/bin/env bash
# Source this BEFORE launching OmniVoice to enable Cinematic dub translation.
#   source scripts/dub_translator_env.sh gemini    # hosted (best Hindi quality)
#   source scripts/dub_translator_env.sh openai    # hosted GPT
#   source scripts/dub_translator_env.sh gemma     # local Gemma 4 E4B (needs llama-server)
#   source scripts/dub_translator_env.sh           # show usage

mode="${1:-help}"

case "$mode" in
  gemini)
    : "${GEMINI_API_KEY:?Set GEMINI_API_KEY first: export GEMINI_API_KEY=...}"
    export TRANSLATE_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai/"
    export TRANSLATE_API_KEY="$GEMINI_API_KEY"
    export TRANSLATE_MODEL="gemini-2.0-flash"
    export OMNIVOICE_LLM_TIMEOUT=60
    echo "Cinematic dub: Gemini Flash (hosted)"
    ;;
  openai)
    : "${OPENAI_API_KEY:?Set OPENAI_API_KEY first: export OPENAI_API_KEY=sk-...}"
    export TRANSLATE_BASE_URL="https://api.openai.com/v1"
    export TRANSLATE_API_KEY="$OPENAI_API_KEY"
    export TRANSLATE_MODEL="gpt-4o-mini"
    export OMNIVOICE_LLM_TIMEOUT=60
    echo "Cinematic dub: OpenAI gpt-4o-mini (hosted)"
    ;;
  gemma)
    export TRANSLATE_BASE_URL="http://localhost:8001/v1"
    export TRANSLATE_API_KEY="local"
    export TRANSLATE_MODEL="gemma-4-E4B"
    export OMNIVOICE_LLM_TIMEOUT=120
    echo "Cinematic dub: Gemma 4 E4B (local). Start llama-server first:"
    echo "  scripts/start_gemma4_server.sh"
    ;;
  *)
    cat <<EOF
Usage: source scripts/dub_translator_env.sh <gemini|openai|gemma>

  gemini   Hosted Gemini 2.0 Flash. Set GEMINI_API_KEY first.
  openai   Hosted GPT-4o-mini.       Set OPENAI_API_KEY first.
  gemma    Local Gemma 4 E4B via llama-server on :8001.
EOF
    ;;
esac
