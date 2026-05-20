# OmniVoice Studio — CosyVoice Engine

CosyVoice is one of the multilingual TTS engines OmniVoice can drive. It does
zero-shot voice cloning across 9+ languages with separate models for "base",
"instruct", and "SFT" use cases.

## Install

CosyVoice is installed *per-engine* from the in-app **Settings → Engines** tab:

1. Open **Settings → Engines**.
2. Click **Install** next to "CosyVoice".
3. The app fetches the engine source, creates a dedicated venv, syncs deps,
   and downloads model weights (~2 GB).
4. Once installed, the engine appears in the **Voice Cloning** and
   **Voice Design** engine picker dropdowns.

The dedicated venv keeps CosyVoice's transformer pins from clashing with
IndexTTS / ChatterboxTTS / SonicTranslate (see
[troubleshooting.md](../install/troubleshooting.md#10-indextts--cosyvoice--chatterboxtts-clash)).

## Common errors

### `Model not found: CosyVoice-300M-Instruct`

The first synthesis call downloads the weights from HuggingFace. If the
download was interrupted, the manifest can be inconsistent. **Fix:** delete
`~/.cache/huggingface/hub/models--FunAudioLLM--CosyVoice-300M*` and retry —
the engine re-downloads cleanly.

### `HfHubHTTPError: 401 Client Error`

CosyVoice models are not gated as of `v1.x`, but the underlying download
goes through `huggingface_hub` which still wants a token for rate-limit
buckets. Set one — see
[docs/setup/huggingface-token.md](../setup/huggingface-token.md).

### `RuntimeError: CUDA out of memory` on first synthesise

The CosyVoice-300M-Instruct path peaks at ~4.5 GB VRAM. If you're on an 8 GB
GPU and also have a browser open, that's tight. **Fix:** close other CUDA
apps, or pick a smaller variant (CosyVoice-300M without instruct).

## Troubleshooting

- **Issue [#55](https://github.com/debpalash/OmniVoice-Studio/issues/55):**
  CosyVoice install clashing with IndexTTS — fixed in v0.3+ via per-engine
  venvs.
- For other errors, capture the splash-screen log (Settings → Logs → Backend)
  and open a bug report with **Settings → Help → Report a bug** (Phase 5
  ships the auto-report path).
