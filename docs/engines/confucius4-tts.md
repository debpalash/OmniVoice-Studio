# Confucius4-TTS (opt-in engine)

> **Status: implementation complete — GPU inference run pending.** The
> integration (engine registration, dedicated-venv bootstrap, sidecar wire
> protocol, opt-in gating) is done, and the sidecar's synthesis API
> (`confuciustts.cli.inference.ConfuciusTTS(config_path, device)` →
> `generate(text, lang, prompt_wav)` → tensor, `model.sample_rate`) is
> **validated against the upstream repo** and the sidecar's pure logic
> (language normalization, tensor→PCM, config resolution, wire framing,
> synthesize dispatch with the model mocked) is **unit-tested**
> (`tests/test_confucius4_sidecar.py`). What remains is a one-time **end-to-end
> run on a CUDA 12.6 GPU** to confirm the live model call and the true output
> sample rate — no maintainer GPU box is available yet. The engine is gated
> behind `OMNIVOICE_CONFUCIUS4_TTS_DIR`, so it's completely inert until you opt
> in — it can't affect the default install on any platform.

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

**External dependencies (per upstream) — needed before first synthesis:**

- **MaskGCT codec** from the [Amphion](https://github.com/open-mmlab/Amphion)
  repo — Confucius4's semantic-to-acoustic stage uses it. Follow upstream's
  README for the exact vendor/install step.
- **`facebook/w2v-bert-2.0`** (Wav2Vec2-BERT) — pulled from HuggingFace on first
  use; make sure your `HF_TOKEN` (Settings → Credentials) is set if rate-limited.
- **Checkpoint** `netease-youdao/Confucius4-TTS` (~2–4 GB: `t2s_model.safetensors`,
  `s2a_model.pt`, `wav2vec2bert_stats.pt`, tokenizer files) into `checkpoints/`.

These are large and CUDA-only; budget disk + a first-run download.

Then point OmniVoice at the clone and restart:

- **macOS/Linux:** `export OMNIVOICE_CONFUCIUS4_TTS_DIR=/path/to/Confucius4-TTS`
- **Windows (PowerShell):** `[Environment]::SetEnvironmentVariable("OMNIVOICE_CONFUCIUS4_TTS_DIR","C:\path\to\Confucius4-TTS","User")`

Select **Confucius4-TTS** in Settings → Engines. First synthesize downloads the
checkpoint from `netease-youdao/Confucius4-TTS` (HuggingFace).

### Optional overrides

- `OMNIVOICE_CONFUCIUS4_CONFIG` — path to `inference_config.yaml` if it isn't at
  `<clone>/config/inference_config.yaml`.

## Validation status (for the maintainer)

The sidecar (`backend/engines/confucius4/main.py`) uses:

```python
from confuciustts.cli.inference import ConfuciusTTS
model = ConfuciusTTS(config_path=..., device="cuda")
audio = model.generate(text=..., lang="en", prompt_wav="ref.wav")  # → tensor
sr = model.sample_rate
```

- ✅ **Validated against upstream** — import path/package (`confuciustts`), the
  `ConfuciusTTS(config_path, device)` constructor, and `generate(text, lang,
  prompt_wav)` → tensor all match the repo.
- ✅ **Sidecar logic unit-tested** (`tests/test_confucius4_sidecar.py`, 22 cases):
  language normalization, tensor→PCM (mono/stereo/clip), config-path resolution,
  wire framing, and synthesize dispatch with the model mocked.
- ⏳ **Pending a CUDA 12.6 GPU run:** confirm the live `generate()` call end-to-end
  and the **true output sample rate** — if it isn't 24 kHz, update
  `CONFUCIUS_SAMPLE_RATE` in `main.py` / `_DEFAULT_SAMPLE_RATE` in `__init__.py`.
  To validate: set `OMNIVOICE_CONFUCIUS4_TTS_DIR`, select the engine, synthesize
  one clip on an NVIDIA box, and confirm audible output.
