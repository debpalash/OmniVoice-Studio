# Confucius4-TTS (opt-in engine)

> **Status: validated end-to-end (2026-07-02).** The integration (engine
> registration, dedicated-venv bootstrap, sidecar wire protocol, opt-in gating)
> is done, the sidecar's pure logic is unit-tested
> (`tests/test_confucius4_sidecar.py`), and a live synthesis run on Apple
> Silicon (CPU) produced audible cloned speech — confirming the model API and
> the true output sample rate of **22 050 Hz**. CUDA is the recommended
> hardware; CPU works but is slow (~17× realtime — roughly 100 s for 6 s of
> audio). MPS also runs but is *slower* than CPU (~64× realtime), so the
> sidecar deliberately never selects it. The engine is gated behind
> `OMNIVOICE_CONFUCIUS4_TTS_DIR`, so it's completely inert until you opt in —
> it can't affect the default install on any platform.

[Confucius4-TTS](https://github.com/netease-youdao/Confucius4-TTS) (netease-youdao)
is an LLM-based multilingual / cross-lingual zero-shot voice-cloning TTS.

- **14 languages**: Chinese, English, Japanese, Korean, German, French, Spanish,
  Indonesian, Italian, Thai, Portuguese, Russian, Malay, Vietnamese.
- **Unconstrained cloning** — no reference transcript required.
- **Cross-lingual voice transfer** — keep one voice across languages.
- **License:** Apache-2.0. **Hardware:** NVIDIA GPU (CUDA 12.6) recommended;
  CPU validated on Apple Silicon but ~17× realtime. Output: 22 050 Hz mono.

Like IndexTTS-2 / MOSS-TTS-v1.5 / dots.tts, it runs in its **own subprocess venv**
so its dependency stack never touches the default OmniVoice interpreter.

## Install

```bash
git clone https://github.com/netease-youdao/Confucius4-TTS.git
cd Confucius4-TTS
uv venv --python 3.10
uv pip install -r requirements.txt
```

> Upstream ships **no `pyproject.toml`/`setup.py`**, so there is nothing to
> `pip install -e` — don't try; it fails. The OmniVoice sidecar puts the clone
> on `sys.path` itself (the same thing upstream's `example.py` does).

**Model weights — all fetched automatically from HuggingFace on first
synthesis (~5 GB total, cached in `$HF_HUB_CACHE`):**

- `netease-youdao/Confucius4-TTS` — `t2s_model.safetensors` + `s2a_model.pt`
  (the tokenizer + `wav2vec2bert_stats.pt` already ship in the clone's
  `checkpoints/`).
- `facebook/w2v-bert-2.0` — semantic feature extractor (~2.3 GB).
- `funasr/campplus` — speaker-style encoder (small).
- `nvidia/bigvgan_v2_22khz_80band_256x` — vocoder (BigVGAN and CAMPPlus
  *code* is vendored in the clone's `external/`; no Amphion install needed).

Set your `HF_TOKEN` (Settings → Credentials) if you hit rate limits.

Then point OmniVoice at the clone and restart:

- **macOS/Linux:** `export OMNIVOICE_CONFUCIUS4_TTS_DIR=/path/to/Confucius4-TTS`
- **Windows (PowerShell):** `[Environment]::SetEnvironmentVariable("OMNIVOICE_CONFUCIUS4_TTS_DIR","C:\path\to\Confucius4-TTS","User")`

Select **Confucius4-TTS** in Settings → Engines. The first synthesize triggers
the weight downloads above, then generates.

### Optional overrides

- `OMNIVOICE_CONFUCIUS4_CONFIG` — path to `inference_config.yaml` if it isn't at
  `<clone>/config/inference_config.yaml`.

## Validation record (2026-07-02, Apple Silicon M-series, CPU)

The sidecar (`backend/engines/confucius4/main.py`) uses:

```python
from confuciustts.cli.inference import ConfuciusTTS
model = ConfuciusTTS(config_path=..., device="cuda")  # or "cpu"
audio = model.generate(text=..., lang="en", prompt_wav="ref.wav")  # → tensor
sr = model.sample_rate  # 22050
```

- ✅ **Live end-to-end run**: English zero-shot clone from a 9.5 s reference —
  6.06 s of audible speech (peak 0.85) in 102 s on CPU. `model.sample_rate`
  returned **22 050**, matching `target_sample_rate` in
  `config/inference_config.yaml`; `CONFUCIUS_SAMPLE_RATE` /
  `_DEFAULT_SAMPLE_RATE` are pinned to it (regression-tested).
- ✅ **Not pip-installable upstream** — discovered live; the bootstrap now skips
  the editable install unless upstream ships packaging, and both the import
  probe and the sidecar resolve `confuciustts` via the clone on `sys.path`.
- ✅ **MPS probed and rejected**: runs, but ~4× slower than CPU (Metal op
  fallbacks) — the sidecar selects CUDA when available, else CPU, never MPS.
- ✅ **Sidecar logic unit-tested** (`tests/test_confucius4_sidecar.py`):
  language normalization, tensor→PCM (mono/stereo/clip), config-path
  resolution, clone sys.path injection, wire framing, synthesize dispatch.
