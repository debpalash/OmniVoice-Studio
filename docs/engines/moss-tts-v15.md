# VoiceStudio — MOSS-TTS-v1.5 Engine

MOSS-TTS-v1.5 (OpenMOSS) is an **8B** flagship zero-shot TTS — a Qwen3-8B
language backbone plus a 1.6B audio codec. It covers **31 languages**, does
zero-shot voice cloning, token-level duration control and inline
`[pause Ns]` markers. Released under **Apache-2.0** (code + weights).

It runs in its own subprocess **and its own Python venv** with
`transformers==5.0.0`, isolated from the VoiceStudio parent process which
pins `transformers>=5.3`. This is the same isolation primitive used by
[IndexTTS-2](indextts.md): the two `transformers` pins cannot share one
interpreter, so MOSS runs behind
`backend/services/subprocess_backend.py::SubprocessBackend`.

> **Opt-in, and never a default.** MOSS-TTS-v1.5 is selected explicitly in
> **Model Catalogue → Engines** (or `OMNIVOICE_TTS_BACKEND=moss-tts-v15`). It is
> not part of the default install and does not change VoiceStudio's
> out-of-the-box behaviour on any platform.

## Hardware

- **VRAM/RAM:** an 8B model. The upstream llama.cpp pipeline fits the 8B on
  8 GB GPUs when quantized; the bf16 Transformers path used here is ~16 GB
  of weights, so a 16 GB+ GPU is the realistic CUDA target. It also runs on
  **CPU** (fp32) — correct but slow.
- **Device:** CUDA when present, else CPU. **There is no MPS path** —
  upstream documents only CUDA/CPU and the custom modelling code is
  untested on Apple Silicon, so VoiceStudio never routes MOSS to MPS. On a
  Mac it runs on CPU.

## Install

MOSS-TTS-v1.5 is **not** bundled (the model is large and the package pins a
conflicting `transformers`). VoiceStudio ships a sidecar runner that loads it
into an isolated venv on demand.

1. Clone the MOSS-TTS repo on disk:

   ```bash
   git clone https://github.com/OpenMOSS/MOSS-TTS.git
   ```

2. Install the editable package into a fresh venv. Use
   `uv pip install -e ".[torch-runtime]"` — **never** `uv sync --all-extras`,
   which would overwrite VoiceStudio's lock file with `transformers==5.0` and
   break the parent process. The `torch-runtime` extra is CUDA (`+cu128`):

   ```bash
   cd MOSS-TTS
   uv venv .venv
   uv pip install -e ".[torch-runtime]"
   ```

   On a **non-CUDA / CPU host** (e.g. Apple Silicon), install plain
   `torch`/`torchaudio`/`transformers==5.0.0` into the venv instead of the
   `+cu128` extra (the auto-bootstrap below only targets CUDA hosts).

3. The ~16 GB weights download from HuggingFace on first synthesize. The
   parent forwards `HF_HOME` / `HF_HUB_CACHE` to the sidecar so the cache is
   shared with the rest of VoiceStudio's downloads.

4. Set `OMNIVOICE_MOSS_TTS_V15_DIR` to the repo root (the directory that
   contains `pyproject.toml`):

   ```bash
   # macOS / Linux
   echo 'export OMNIVOICE_MOSS_TTS_V15_DIR=$HOME/code/MOSS-TTS' >> ~/.zshrc
   source ~/.zshrc
   ```

   ```powershell
   # Windows PowerShell
   [Environment]::SetEnvironmentVariable("OMNIVOICE_MOSS_TTS_V15_DIR","$env:USERPROFILE\code\MOSS-TTS","User")
   ```

5. Restart VoiceStudio. MOSS-TTS-v1.5 appears in **Model Catalogue → Engines** with
   `available: true` and `isolation_mode: subprocess`.

## Venv resolution order

VoiceStudio probes for a usable MOSS Python interpreter in this priority
order (see `backend/engines/moss_tts_v15/bootstrap.py`):

1. **`${OMNIVOICE_MOSS_TTS_V15_DIR}/.venv/`** — your existing clone's venv.
   Highest priority, so a power user who already set MOSS up gets zero
   re-install.
2. **`backend/engines/moss_tts_v15/.venv/`** — VoiceStudio's own venv,
   created on demand by step 3.
3. **Lazy bootstrap** — if neither venv exists, VoiceStudio runs `uv venv`
   then `uv pip install --python <python> -e "${DIR}[torch-runtime]"`.
   Requires `OMNIVOICE_MOSS_TTS_V15_DIR`; raises a clear error otherwise.
   On a non-CUDA host the `+cu128` extra cannot resolve — set the venv up
   manually per step 2.

## Voice cloning

Pass a reference clip as `ref_audio`. MOSS's zero-shot clone mode needs only
the audio (no transcript). Without a reference, MOSS synthesizes in its own
default voice. `duration` (seconds) maps to MOSS's `tokens` argument at
~12.5 tokens/second.

## Optional env knobs

| Variable | Default | Purpose |
|----------|---------|---------|
| `OMNIVOICE_MOSS_TTS_V15_DIR` | — | Path to the MOSS-TTS clone (required). |
| `OMNIVOICE_MOSS_TTS_V15_MODEL` | `OpenMOSS-Team/MOSS-TTS-v1.5` | Advanced HF repo override. Custom repositories execute their modelling code and are rejected unless both safeguards below are set. Configure `HF_ENDPOINT` for a mirror instead. |
| `OMNIVOICE_MOSS_TTS_V15_REVISION` | — | Immutable 40-character commit SHA required with a custom model repository. |
| `OMNIVOICE_MOSS_TTS_V15_TRUST_REMOTE_CODE` | — | Set to `1` only after auditing a custom repository's Python code. The reviewed built-in repository needs no opt-in. |
| `OMNIVOICE_MOSS_TTS_V15_ATTN` | `sdpa` | Attention impl; set `flash_attention_2` on Ampere+ CUDA with `flash-attn` installed. |

## Common errors

### `MOSS-TTS-v1.5 venv not found. Set OMNIVOICE_MOSS_TTS_V15_DIR ...`

You haven't pointed VoiceStudio at a MOSS-TTS clone yet. Follow **Install**.

### `uv pip install -e failed ... '[torch-runtime]' extra (cu128) cannot resolve`

You're on a non-CUDA host. The upstream `torch-runtime` extra is CUDA-only;
set up the venv manually with plain `torch`/`transformers==5.0.0` (step 2).

## License

Apache-2.0 (code and weights) — no acceptance gate. See the upstream
[README](https://github.com/OpenMOSS/MOSS-TTS/blob/main/README.md).

---

MOSS-TTS-v1.5 runs in a dedicated sidecar venv (it pins `transformers==5.0`,
which conflicts with the parent's `transformers>=5.3`). For why that adds
disk and how uv keeps the cost down, see
[Engine venvs & disk usage](disk-usage.md).
