# VoiceStudio — PyTorch Whisper Engine

Whisper through the plain `transformers` pipeline, riding torch itself. No
extra install — transformers ships with the app — and because it runs on
torch's own stack (including torch's bundled cuDNN 9), it works on machines
where the CTranslate2 engines can't load. It is also the engine that
genuinely uses **AMD ROCm** GPUs, so auto-detect picks it on ROCm hosts
([#1529](https://github.com/debpalash/VoiceStudio/issues/1529)).

## Selecting it

- **Model Catalogue → Engines**, ASR tab → **Use** on the PyTorch Whisper
  row, or `OMNIVOICE_ASR_BACKEND=pytorch-whisper`.
- `OMNIVOICE_ASR_BACKEND=omnivoice` is accepted as a compatibility alias and
  selects this same PyTorch-native ASR path on ROCm hosts.
- Auto-detect picks it on ROCm, and as the last resort everywhere else.

## Best at

- **ROCm dubbing/transcription** — the only Whisper engine that uses the HIP
  GPU (CTranslate2 has no HIP build, MLX is Apple-only).
- **Rescue engine** when whisperx/faster-whisper can't load — e.g. the
  missing-cuDNN-8 case
  ([#255](https://github.com/debpalash/VoiceStudio/issues/255)) — since it
  needs neither CTranslate2 nor cuDNN 8.

For lip-sync-grade word timing prefer [whisperx](whisperx.md) or
[mlx-whisper](mlx-whisper.md); this engine returns the pipeline's own word
timestamps.

## Platform support

CUDA, Apple Silicon (MPS), ROCm (HIP), and CPU — wherever torch runs, on
macOS, Windows, and Linux.

## Model selection

`OMNIVOICE_PYTORCH_ASR_MODEL` — default `openai/whisper-large-v3-turbo`. Any
transformers-format Whisper repo works. Weights download on first load — see
[downloading-models](../downloading-models.md).

## VRAM preflight

whisper-large-v3-turbo needs roughly 3.2 GiB before generation adds its
workspace; loading it onto a nearly-full card "succeeds" and then the first
transcribe OOMs with zero segments. So on CUDA the engine checks free VRAM
against a 5 GB budget before loading and uses the CPU instead when the card
is too full (flush the TTS model to restore GPU-speed ASR). Disable with
`OMNIVOICE_ASR_VRAM_PREFLIGHT=0`.

## Quirks

- If the pipeline fails to import (`AutoFeatureExtractor` errors), the cause
  is either an incomplete transformers install or a torch/torchvision
  version mismatch — the error message names the exact reinstall command;
  the trio has to move together at the pinned versions
  ([#549](https://github.com/debpalash/VoiceStudio/issues/549),
  [#1376](https://github.com/debpalash/VoiceStudio/issues/1376)).
- Transcribes are time-bounded like every local engine:
  `OMNIVOICE_TRANSCRIBE_CHUNK_TIMEOUT_S` (default 120 s per dub chunk),
  `OMNIVOICE_ASR_TRANSCRIBE_TIMEOUT_S` (default 300 s whole-file).

Speed comparisons across engines live in [performance](../performance.md).
