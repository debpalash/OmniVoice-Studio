# VoiceStudio — dots.tts Engine

dots.tts (rednote-hilab) is a **2B** fully-continuous autoregressive TTS,
widely cited as one of the strongest open zero-shot voice-cloning models. It
covers **24 languages**, emits **48 kHz** audio, and is released under
**Apache-2.0** (code + checkpoints).

It runs in its own subprocess **and its own Python venv** with
`transformers==4.57.0`, isolated from the VoiceStudio parent process which
pins `transformers>=5.3` — the same isolation primitive used by
[IndexTTS-2](indextts.md) and [MOSS-TTS-v1.5](moss-tts-v15.md).

> **Opt-in, and never a default.** dots.tts is selected explicitly in
> **Model Catalogue → Engines** (or `OMNIVOICE_TTS_BACKEND=dots-tts`). It is not
> part of the default install.

## Platform support

- **Linux / macOS only.** dots.tts's upstream package declares Linux and
  macOS classifiers and has **no Windows install path**. On Windows the
  engine reports itself unavailable in **Model Catalogue → Engines** with a clear
  reason — run VoiceStudio under WSL2 or use a Linux/macOS host.
- **No MPS.** Upstream device selection is CUDA-or-CPU with no Metal branch,
  so on Apple Silicon the official package runs on **CPU** (slow but
  correct). A faster Apple-Silicon path exists only via community MLX ports,
  which VoiceStudio does not auto-wire.
- **VRAM:** ~9 GB checkpoint; a 12–16 GB CUDA GPU is the realistic target.

## Install

dots.tts is **not** bundled (large checkpoint + conflicting `transformers`).

1. Clone the dots.tts repo on disk:

   ```bash
   git clone https://github.com/rednote-hilab/dots.tts.git
   ```

2. Install the editable package into a fresh venv with the upstream
   constraints. Use `uv pip install -e . -c constraints/recommended.txt` —
   **never** `uv sync --all-extras`, which would overwrite VoiceStudio's lock
   file with `transformers==4.57` and break the parent process:

   ```bash
   cd dots.tts
   uv venv .venv
   uv pip install -e . -c constraints/recommended.txt
   ```

3. The ~9 GB checkpoint downloads from HuggingFace on first synthesize. The
   parent forwards `HF_HOME` / `HF_HUB_CACHE` to the sidecar so the cache is
   shared with the rest of VoiceStudio's downloads.

4. Set `OMNIVOICE_DOTS_TTS_DIR` to the repo root (the directory that
   contains `pyproject.toml` and `constraints/`):

   ```bash
   # macOS / Linux
   echo 'export OMNIVOICE_DOTS_TTS_DIR=$HOME/code/dots.tts' >> ~/.zshrc
   source ~/.zshrc
   ```

5. Restart VoiceStudio. dots.tts appears in **Model Catalogue → Engines** with
   `available: true` and `isolation_mode: subprocess`.

## Venv resolution order

VoiceStudio probes for a usable dots.tts Python interpreter in this priority
order (see `backend/engines/dots_tts/bootstrap.py`):

1. **`${OMNIVOICE_DOTS_TTS_DIR}/.venv/`** — your existing clone's venv.
2. **`backend/engines/dots_tts/.venv/`** — VoiceStudio's own venv, created on
   demand by step 3.
3. **Lazy bootstrap** — `uv venv` then `uv pip install -e <clone> -c
   <clone>/constraints/recommended.txt`. Requires `OMNIVOICE_DOTS_TTS_DIR`.

## Voice cloning

For best fidelity ("continuation cloning"), pass **both** a reference clip
(`ref_audio`) and its exact transcript (`ref_text`). A reference clip alone
does x-vector-only cloning. Keep the reference ~10 s. Upstream requires the
reference audio whenever a transcript is given, so VoiceStudio drops a stray
`ref_text` that arrives without `ref_audio`.

## Optional env knobs

| Variable | Default | Purpose |
|----------|---------|---------|
| `OMNIVOICE_DOTS_TTS_DIR` | — | Path to the dots.tts clone (required). |
| `OMNIVOICE_DOTS_TTS_MODEL` | `rednote-hilab/dots.tts-soar` | Checkpoint override (`-base`, `-soar`, `-mf`). |
| `OMNIVOICE_DOTS_TTS_PRECISION` | `bfloat16` (CUDA) / `float32` (CPU) | Inference precision. |
| `OMNIVOICE_DOTS_TTS_OPTIMIZE` | `0` | `1` enables `torch.compile` (slower first call, faster after). |

> Using the `dots.tts-mf` (MeanFlow-distilled) checkpoint? It's tuned for
> **4** flow-matching steps — pass `num_step=4`.

## Common errors

### `dots.tts is not supported on Windows ...`

Upstream is Linux/macOS only. Use WSL2 or a Linux/macOS host.

### `dots.tts venv not found. Set OMNIVOICE_DOTS_TTS_DIR ...`

You haven't pointed VoiceStudio at a dots.tts clone yet. Follow **Install**.

## License

Apache-2.0 (code and checkpoints). See the upstream
[README](https://github.com/rednote-hilab/dots.tts/blob/main/README.md).

---

dots.tts runs in a dedicated sidecar venv (it pins `transformers==4.57`,
which conflicts with the parent's `transformers>=5.3`). For why that adds
disk and how uv keeps the cost down, see
[Engine venvs & disk usage](disk-usage.md).
