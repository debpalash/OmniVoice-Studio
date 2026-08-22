# VoiceStudio — Sherpa-ONNX Dictation Engine

The k2-fsa/sherpa-onnx ONNX runtime as a **live dictation** engine: small
int8 models that transcribe faster than realtime on CPU, with identical
behavior on macOS (arm64 + x86_64), Windows, and Linux — no CUDA dependency.
Streaming models emit partial text frame-by-frame as you speak; offline
models re-transcribe a growing buffer on a short cadence, so you see live
partials either way.

## Selecting it

- Ensure `sherpa-onnx` is installed (`uv add sherpa-onnx` on source installs).
- Pick a dictation model in the app (Model Catalogue → Models lists the
  selectable set below), or **Model Catalogue → Engines**, ASR tab → **Use**, or
  pin `OMNIVOICE_ASR_BACKEND=sherpa-onnx-asr`.
- `OMNIVOICE_SHERPA_ASR_MODEL` selects the model — default
  `sherpa-whisper-tiny`.

## Best at

- **Live dictation on CPU** — the whole point of this engine. Fast partials,
  automatic endpointing on silence, no GPU required.
- It also honors the regular offline `transcribe` contract, so any of its
  models can transcribe a file — plain text, single segment, no word
  timestamps, which makes it a dictation/notes tool rather than a dubbing
  engine.

## The 7 selectable models

| Id | Type | Languages | Download |
| --- | --- | --- | --- |
| `sherpa-parakeet-tdt-v3` | offline | 25 European languages | 0.67 GB |
| `sherpa-parakeet-tdt-v2` | offline | English | 0.66 GB |
| `sherpa-zipformer-bilingual-zh-en` | streaming | Chinese + English | 0.20 GB |
| `sherpa-paraformer-bilingual-zh-en` | streaming | Chinese + English | 0.24 GB |
| `sherpa-zipformer-en-20m` | streaming | English | 0.044 GB |
| `sherpa-zipformer-zh-14m` | streaming | Chinese | 0.025 GB |
| `sherpa-whisper-tiny` (default, recommended) | offline | 90+ languages (auto-detect) | 0.104 GB |

Sizes are measured on-disk download sizes. Weights are int8 ONNX checkpoints
that download on first use through the same HF cache as everything else —
see [downloading-models](../downloading-models.md). Peak RAM for the 0.6B
Parakeets is noticeably higher than their download size (onnxruntime's arena
allocator holds onto freed blocks).

## Platform support

CPU on every platform, by the strict cross-platform default-parity rule. The
[upstream CPU wheels](https://k2-fsa.github.io/sherpa/onnx/python/install.html)
cover Linux, macOS, and Windows, and upstream documents Whisper as a
[supported non-streaming model family](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html).
`OMNIVOICE_SHERPA_ASR_PROVIDER` can override the ONNX provider on a verified
GPU build, but the default never diverges.

## Tuning

- `OMNIVOICE_SHERPA_ASR_THREADS` — decode threads (default 2; the 0.6B
  Parakeets automatically use up to 4 when the host has the cores, so decode
  keeps ahead of the speaker).
- `OMNIVOICE_DICTATION_ENDPOINT_R1` / `OMNIVOICE_DICTATION_ENDPOINT_R2` —
  streaming endpoint rules in seconds (defaults 1.0 / 0.6: text commits
  ~0.6 s after you stop speaking). Applied without a restart.

## Quirks

- The recognizer is **pre-warmed in the background** so the first dictation
  session doesn't pay the 1.3–2.5 s ONNX session load
  ([#888](https://github.com/debpalash/VoiceStudio/issues/888)); it's then
  shared warm across sessions.
- On Apple Silicon, installing the [parakeet-mlx](parakeet-mlx.md) model
  makes dictation prefer the GPU Parakeet automatically for the 25 covered
  languages; an explicitly selected sherpa model still wins.
- The offline `transcribe` path reports `language: auto` — per-file language
  detection is only meaningful for the Whisper Tiny model.
