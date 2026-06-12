# OmniVoice Studio — IndexTTS-2 Engine

IndexTTS-2 (Bilibili) is OmniVoice's emotion-controlled zero-shot TTS
engine. It runs in its own subprocess + dedicated Python venv with
`transformers<5`, isolated from the OmniVoice parent process which
pins `transformers>=5.3`. This isolation is the resolution of
[#42](https://github.com/voice-design/OmniVoice/issues/42) — the
canonical `OffloadedCache` ImportError that resulted from loading
both libraries inside one Python interpreter.

## Install

IndexTTS-2 is **not** bundled with OmniVoice — the model weights are
~6 GB and the package itself pins a conflicting transformers
version. OmniVoice ships with a sidecar runner that loads IndexTTS
into an isolated venv on demand.

1. Clone the IndexTTS repo on disk:

   ```bash
   git clone https://github.com/index-tts/index-tts.git
   ```

2. Install the editable package into a fresh venv. Use
   `uv pip install -e .` — **never** `uv sync --all-extras`, which
   would overwrite OmniVoice's lock file with `transformers<5` and
   break the parent process:

   ```bash
   cd index-tts
   uv venv .venv
   uv pip install -e .
   ```

3. Download the model weights (~6 GB). Either:

   ```bash
   hf download IndexTeam/IndexTTS-2 --local-dir=checkpoints
   ```

   or let HuggingFace cache them on first synthesize call (the parent
   forwards `HF_HOME` / `HF_HUB_CACHE` to the sidecar so the cache is
   shared with the rest of OmniVoice's downloads).

4. Set the `OMNIVOICE_INDEXTTS_DIR` environment variable to the repo
   root (the directory that contains `checkpoints/` and
   `pyproject.toml`):

   ```bash
   # macOS / Linux
   echo 'export OMNIVOICE_INDEXTTS_DIR=$HOME/code/index-tts' >> ~/.zshrc
   source ~/.zshrc
   ```

   ```powershell
   # Windows PowerShell
   [Environment]::SetEnvironmentVariable("OMNIVOICE_INDEXTTS_DIR","$env:USERPROFILE\code\index-tts","User")
   ```

5. Restart OmniVoice. IndexTTS-2 will appear in **Settings → Engines**
   with `available: true` and `isolation_mode: subprocess`.

## Venv resolution order

OmniVoice probes for a usable IndexTTS Python interpreter in this
priority order (see `backend/engines/indextts/bootstrap.py`):

1. **`${OMNIVOICE_INDEXTTS_DIR}/.venv/`** — your existing clone's
   venv. Highest priority, so v0.2.7 users who already ran
   `uv pip install -e .` get zero migration cost on the upgrade to
   v0.3.x.
2. **`backend/engines/indextts/.venv/`** — OmniVoice's own venv,
   created on demand by step 3.
3. **Lazy bootstrap** — if neither venv exists, OmniVoice runs
   `uv venv backend/engines/indextts/.venv` and
   `uv pip install --python <python> -e ${OMNIVOICE_INDEXTTS_DIR}`
   on first launch. Requires `OMNIVOICE_INDEXTTS_DIR` to be set;
   raises a clear error otherwise.

The cache marker test
(`tests/backend/services/test_indextts_backward_compat.py::test_hf_home_marker_present_after_bootstrap`)
proves that the bootstrap path **never** mutates
`$HF_HOME/hub/models--IndexTeam--IndexTTS-2/` — so the 6 GB model
weights survive the upgrade byte-for-byte.

## Common errors

### `IndexTTS-2 venv not found. Set OMNIVOICE_INDEXTTS_DIR ...`

You haven't pointed OmniVoice at an IndexTTS clone yet. Follow the
**Install** steps above.

### `uv is required to bootstrap the IndexTTS-2 venv but was not found on PATH`

The bootstrap path needs a working `uv` binary. Either install `uv`
into your `PATH` (https://docs.astral.sh/uv/) or pre-create the venv
manually with `uv venv` and `uv pip install -e` as in step 2.

### `IndexTTS bootstrap completed but `import indextts.infer_v2` still fails`

The clone at `OMNIVOICE_INDEXTTS_DIR` is missing the indextts
package. Verify with:

```bash
ls "$OMNIVOICE_INDEXTTS_DIR/pyproject.toml"   # should exist
ls "$OMNIVOICE_INDEXTTS_DIR/indextts/"        # should exist
```

If the directory is correct but the import still fails, delete
`backend/engines/indextts/.venv/` and re-launch — OmniVoice will
re-bootstrap from scratch.

## Why a subprocess?

IndexTTS-2 pins `transformers<5`. OmniVoice pins `transformers>=5.3`.
The two cannot share a Python interpreter — at import time, one of
them blows up trying to find a class the other moved or removed (the
canonical failure is `OffloadedCache` from `transformers.cache_utils`,
which v5 renamed). Running IndexTTS in its own subprocess + its own
venv lets both libraries coexist in the same OmniVoice session.

This is the structural fix for issue #42; the previous
graceful-degradation wrap (which simply detected the conflict and
disabled IndexTTS) is replaced by a real isolation primitive
(`backend/services/subprocess_backend.py::SubprocessBackend`, shipped
in Plan 02-01).

## License

IndexTTS-2 ships under a custom Bilibili research license — free for
research / non-commercial use. Commercial use requires contacting
`indexspeech@bilibili.com`. See the upstream
[README](https://github.com/index-tts/index-tts/blob/main/README.md)
for the full terms.

---

IndexTTS2 runs in a dedicated sidecar venv (it pins `transformers<5`, which
conflicts with the parent's `transformers>=5.3`). For why that adds disk and
how uv keeps the cost down, see [Engine venvs & disk usage](disk-usage.md).
