# Confucius4-TTS (opt-in engine)

> **Status: scaffold (#590) — needs hardware validation.** The integration
> plumbing (engine registration, dedicated-venv bootstrap, sidecar wire
> protocol, opt-in gating) is in place, but the sidecar's synthesis calls are
> derived from the upstream README and have **not yet been run on a CUDA box**.
> The engine is gated behind `OMNIVOICE_CONFUCIUS4_TTS_DIR`, so it's completely
> inert until you opt in — it can't affect the default install on any platform.

[Confucius4-TTS](https://github.com/netease-youdao/Confucius4-TTS) (netease-youdao)
is an LLM-based multilingual / cross-lingual zero-shot voice-cloning TTS.

- **14 languages**: Chinese, English, Japanese, Korean, German, French, Spanish,
  Indonesian, Italian, Thai, Portuguese, Russian, Malay, Vietnamese.
- **Unconstrained cloning** — no reference transcript required.
- **Cross-lingual voice transfer** — keep one voice across languages.
- **License:** Apache-2.0. **Hardware:** NVIDIA GPU, CUDA 12.6, Python 3.10.
  No CPU/MPS path documented; not advertised on Apple Silicon.

Like IndexTTS-2 / MOSS-TTS-v1.5 / dots.tts, it runs in its **own subprocess venv**
so its dependency stack never touches the default OmniVoice interpreter.

## Install

```bash
git clone https://github.com/netease-youdao/Confucius4-TTS.git
cd Confucius4-TTS
uv venv --python 3.10
uv pip install -r requirements.txt
uv pip install -e .
```

Then point OmniVoice at the clone and restart:

- **macOS/Linux:** `export OMNIVOICE_CONFUCIUS4_TTS_DIR=/path/to/Confucius4-TTS`
- **Windows (PowerShell):** `[Environment]::SetEnvironmentVariable("OMNIVOICE_CONFUCIUS4_TTS_DIR","C:\path\to\Confucius4-TTS","User")`

Select **Confucius4-TTS** in Settings → Engines. First synthesize downloads the
checkpoint from `netease-youdao/Confucius4-TTS` (HuggingFace).

### Optional overrides

- `OMNIVOICE_CONFUCIUS4_CONFIG` — path to `inference_config.yaml` if it isn't at
  `<clone>/config/inference_config.yaml`.

## Before relying on it (validation checklist for the maintainer)

The sidecar (`backend/engines/confucius4/main.py`) currently assumes:

```python
from confuciustts.cli.inference import ConfuciusTTS
model = ConfuciusTTS(config_path=..., device="cuda")
audio = model.generate(text=..., lang="en", prompt_wav="ref.wav")  # → tensor
sr = model.sample_rate
```

Confirm on a CUDA box: (1) the import path/package name (`confuciustts`),
(2) the constructor signature, (3) `generate()`'s parameter names and return
type, and (4) the actual output sample rate (update `_DEFAULT_SAMPLE_RATE` in
`backend/engines/confucius4/__init__.py`). Then remove the scaffold warnings.
