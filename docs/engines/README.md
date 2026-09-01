# Engine guides

One page per engine: what it's for, what it needs, how to enable it, and its
quirks. Select engines in **Model Catalogue → Engines** (or quick-switch with
<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>E</kbd>), or pin one with
`OMNIVOICE_TTS_BACKEND` / `OMNIVOICE_ASR_BACKEND`.

The compute device (CUDA/ROCm/MPS/CPU) is auto-detected; pin it under
**Settings → Performance & Device** (or `OMNIVOICE_DEVICE`) if auto-detect
picks wrong — see [performance](../performance.md).

Measured speed/VRAM numbers live in [benchmarks](../benchmarks.md); what each
engine can do expressively in [expressive-speech](../expressive-speech.md);
sidecar disk footprints in [disk-usage](disk-usage.md); the bar a new engine
must clear in [engine-acceptance](../engine-acceptance.md).

New to VoiceStudio? Install the app first — [macOS](../install/macos.md)
(first launch needs the one-time right-click → **Open** Gatekeeper
approval), [Windows](../install/windows.md), [Linux](../install/linux.md),
[Docker](../install/docker.md).

## Text-to-speech

| Engine | Guide | Runs on | Cloning | Enabled by |
|---|---|---|---|---|
| VoiceStudio (OmniVoice) — **default** | [omnivoice](omnivoice.md) | CUDA · MPS · CPU | ✅ | installed by default |
| VoxCPM2 | [voxcpm2](voxcpm2.md) | CUDA · MPS · CPU | ✅ + voice design | `pip install "voxcpm>=2.0.3"` |
| MOSS-TTS-Nano | [moss-tts-nano](moss-tts-nano.md) | CUDA · CPU | ✅ (ref only) | clone + `uv pip install -e .` |
| KittenTTS | [kittentts](kittentts.md) | CPU | — (8 preset voices) | `pip install kittentts` |
| MLX-Audio (Kokoro, CSM, Dia, …) | [mlx-audio](mlx-audio.md) | Apple Silicon | model-dependent | `pip install mlx-audio` |
| CosyVoice 3 | [cosyvoice](cosyvoice.md) | CUDA · CPU | ✅ | clone + requirements |
| GPT-SoVITS | [gpt-sovits](gpt-sovits.md) | external server | ✅ | its own API server |
| Sherpa-ONNX | [sherpa-onnx](sherpa-onnx.md) | CUDA · CPU | — | `pip install sherpa-onnx` + model dir |
| IndexTTS 2.5 | [indextts](indextts.md) | CUDA · CPU | ✅ + emotion | one-click sidecar install |
| OmniVoice GGUF | [omnivoice-gguf](omnivoice-gguf.md) | CUDA · MPS · CPU | ✅ | bundled binary |
| Supertonic-3 | [supertonic3](supertonic3.md) | CPU | — (7 preset voices) | `uv sync --extra supertonic` + license |
| MOSS-TTS-v1.5 (8B) | [moss-tts-v15](moss-tts-v15.md) | CUDA · CPU | ✅ | clone + env var |
| dots.tts (2B) | [dots-tts](dots-tts.md) | CUDA · CPU (not Windows) | ✅ | clone + env var |
| OmniVoice (subprocess) | [omnivoice-subprocess](omnivoice-subprocess.md) | CUDA · MPS · CPU | ✅ | opt-in pick, no install |
| PocketTTS (Kyutai) | [pockettts](pockettts.md) | CPU (not Intel Mac) | ✅ | `uv sync --extra pockettts` + license |
| Confucius4-TTS | [confucius4-tts](confucius4-tts.md) | CUDA · CPU | ✅ | clone + env var |

## Speech-to-text

| Engine | Guide | Runs on | Best at | Enabled by |
|---|---|---|---|---|
| WhisperX | [whisperx](whisperx.md) | CUDA · CPU | dubbing (word timestamps + diarization) | installed by default |
| Faster-Whisper | [faster-whisper](faster-whisper.md) | CUDA · CPU | general transcription | installed by default |
| Faster-Whisper (isolated) | [faster-whisper-isolated](faster-whisper-isolated.md) | CUDA · CPU | unattended batches | opt-in pick |
| MLX Whisper | [mlx-whisper](mlx-whisper.md) | Apple Silicon | Mac default | `pip install mlx-whisper` |
| PyTorch Whisper | [pytorch-whisper](pytorch-whisper.md) | CUDA · MPS · CPU | ROCm hosts | installed by default |
| Parakeet TDT (NeMo) | [nemo-parakeet](nemo-parakeet.md) | CUDA · CPU | 25 languages, fast CPU | separate venv (never the app's) |
| Parakeet TDT (MLX) | [parakeet-mlx](parakeet-mlx.md) | Apple Silicon | dictation, 25 EU languages | default on mac-ARM source installs |
| Moonshine | [moonshine](moonshine.md) | CPU | edge/low-power, no timestamps | `pip install` (see guide) |
| FunASR (SenseVoice) | [funasr](funasr.md) | CUDA · CPU | 50+ languages, inline diarization | `pip install funasr` |
| Sherpa-ONNX dictation | [sherpa-onnx-asr](sherpa-onnx-asr.md) | CPU | live streaming dictation | curated model download |
| OpenAI-compatible (local or remote) | [openai-compatible-asr](openai-compatible-asr.md) | network | a configured endpoint; loopback stays local | Model Catalogue |

Speaker diarization is not an engine registry of its own — the dub pipeline
uses pyannote (HF-gated; see [diarization](../features/diarization.md)) and
FunASR can diarize inline with its `cam++` speaker model.
