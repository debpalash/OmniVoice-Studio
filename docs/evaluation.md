# Evaluation

Evaluate OmniVoice models with standard TTS metrics: WER (intelligibility), SIM-o (speaker similarity), and UTMOS (naturalness).

## Supported Test Sets

| Test Set | Languages | WER Module | Metrics |
|---|---|---|---|
| **LibriSpeech-PC** | English | HuBERT WER | WER + Speaker Sim + MOS |
| **Seed-TTS (en)** | English | Whisper WER | WER + MOS |
| **Seed-TTS (zh)** | Chinese | Paraformer WER | WER + MOS |
| **FLEURS** | 102 languages | Omnilingual-ASR WER | WER (per-language + macro-avg) |
| **MiniMax Multilingual** | 24 languages | Whisper + Paraformer | WER + MOS |

## Prerequisites

```bash
pip install omnivoice[eval]
# or
uv sync --extra eval
```


## Quick Start

```bash
cd examples
bash run_eval.sh
# run_eval.sh will
# (1) download all required test sets and test models;
# (2) inference and evaluation for each test set.
```

## Metrics Explained

### WER (Word Error Rate)
Measures how intelligible the generated speech is by transcribing it with an ASR model and comparing to the reference text. Lower is better. Note that some languages actually use CER (Character Error Rate).

- **LibriSpeech-PC**: HuBERT-based ASR
- **Seed-TTS**: Whisper (en) or Paraformer (zh)
- **MiniMax**: Whisper for non-Chinese, Paraformer for Chinese
- **FLEURS**: Omnilingual-ASR multilingual model

### Speaker Similarity
Cosine similarity between speaker embeddings (ECAPA-TDNN + WavLM) of the reference and generated audio. Higher is better.

### UTMOS (Predicted MOS)
Neural network that predicts Mean Opinion Score from audio. Higher is better.