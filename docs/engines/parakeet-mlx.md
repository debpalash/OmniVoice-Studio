# VoiceStudio — Parakeet TDT v3 (MLX) Engine

NVIDIA's Parakeet TDT v3 on the Apple Silicon GPU, via the small pure-Python
`parakeet-mlx` package. It gives Macs the Parakeet tier CUDA/CPU users get
through NeMo or sherpa-onnx: **25 European languages**, word timestamps from
the TDT decoder itself (no wav2vec2 alignment pass needed), ~1.2 GB download,
~2 GB unified memory, dictation-grade speed on the GPU.

Unlike [nemo-parakeet](nemo-parakeet.md) it needs no `nemo_toolkit` (whose
transformers pin conflicts with the app's) — it is **installed by default on
Apple Silicon source installs since 0.3.22**.

## Selecting it

- **Model Catalogue → Engines**, ASR tab → **Use** on the Parakeet TDT v3
  (MLX) row, or `OMNIVOICE_ASR_BACKEND=parakeet-mlx`.
- **Dictation prefers it automatically**: once the model weights are
  installed (Model Catalogue → Models — the auto-pick never triggers a
  download), live dictation/capture uses it whenever your system language is
  one of the 25 covered European languages. Other languages keep the
  multilingual Whisper engine, so dictation coverage never regresses.

## Best at

- **Live dictation on a Mac** — TDT decoding is fast enough for the capture
  path, at Parakeet's better-than-Whisper English WER.
- **European-language transcription** with word timestamps at a fraction of
  whisper-large-v3's memory and compute.

For languages outside the 25 (CJK, Arabic, ...), use
[mlx-whisper](mlx-whisper.md) instead.

## Platform support

**Apple Silicon only** — the same shared MLX platform gate as mlx-whisper
refuses Linux, Windows, and Intel Macs before any import
([#390](https://github.com/debpalash/VoiceStudio/issues/390)). It runs on the
unified-memory GPU; there is no CPU tier.

## Model selection

`ASR_MODEL_PARAKEET_MLX` — default `mlx-community/parakeet-tdt-0.6b-v3`.
Weights download on first load — see
[downloading-models](../downloading-models.md).

## Quirks

- Long files are processed in 120 s chunks internally to bound unified-memory
  use; short dictation buffers and dub chunks are unaffected.
- Parakeet v3 auto-detects among its 25 languages but doesn't expose the
  pick, so the reported language is the one you requested (or none) — it is
  never hardcoded to English.
- Word timestamps are merged from the decoder's subword tokens — good for
  subtitles and dictation; for lip-sync-critical dubbing the wav2vec2-aligned
  engines ([mlx-whisper](mlx-whisper.md), [whisperx](whisperx.md)) remain the
  accuracy tier.

Speed comparisons across engines live in [performance](../performance.md).
