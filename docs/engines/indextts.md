# OmniVoice Studio — IndexTTS-2 Engine

IndexTTS-2 (Bilibili) is OmniVoice's emotion-controlled zero-shot TTS
engine. It runs in its own subprocess + dedicated Python venv with
`transformers<5`, isolated from the OmniVoice parent process which
pins `transformers>=5.3`. This isolation is the resolution of
[#42](https://github.com/voice-design/OmniVoice/issues/42) — the
canonical `OffloadedCache` ImportError that resulted from loading
both libraries inside one Python interpreter.

## Install (one-click, recommended)

IndexTTS-2 is **not** bundled with OmniVoice — the model weights are
~6 GB and the package itself pins a conflicting transformers
version. OmniVoice ships with a sidecar runner that loads IndexTTS
into an isolated venv on demand, plus a guided installer that
provisions everything for you:

1. Open **Settings → Engines**, expand the IndexTTS2 row
   ("Why unavailable?"), and click **Install**.
2. Watch the step-by-step progress: preflight (uv + disk space),
   source fetch, isolated venv creation, dependency install,
   verification, model-weight download (~6 GB, resumable), and
   configuration save.
3. Done — the engine flips to `available: true` immediately, **no
   restart needed**.

What the installer does under the hood (all cross-platform —
macOS / Windows / Linux):

* Fetches the IndexTTS source with `git clone --depth 1` (or, when
  git isn't installed, downloads the GitHub source tarball over
  HTTPS) into OmniVoice's data directory
  (`<data-dir>/engines/indextts2/index-tts`).
* Creates a dedicated venv inside the checkout with `uv venv` and
  runs `uv pip install -e .` against it — the `transformers<5`
  isolation is preserved; the parent app's environment is never
  touched. uv is resolved from `OMNIVOICE_BUNDLED_UV`, then `PATH`.
* Downloads the `IndexTeam/IndexTTS-2` weights into
  `checkpoints/` (where the sidecar loads them from), honouring your
  configured/auto-selected Hugging Face endpoint and HF token.
* Persists `OMNIVOICE_INDEXTTS_DIR` for you (in-process for
  immediate use + `prefs.json` for the next launch).

Preflight requires roughly **12 GB free disk space** (source + venv +
weights, checked before anything is written); the install fails early
with an actionable message otherwise. Re-running the installer is
always safe: it repairs partial installs and resumes interrupted
downloads instead of starting over. An app-managed install can be
removed again with `DELETE /engines/sidecar/indextts2/install` (a
user-managed clone is never touched).

If you already installed IndexTTS manually (any OmniVoice version),
the installer detects it via `OMNIVOICE_INDEXTTS_DIR` and reports
`already_installed` — nothing is re-downloaded or moved.

## Manual install (fallback)

The manual flow still works and is what the installer automates. Use
it if you want the clone somewhere specific, share one clone across
tools, or can't use the in-app installer:

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

3. Download the model weights (~6 GB):

   ```bash
   hf download IndexTeam/IndexTTS-2 --local-dir=checkpoints
   ```

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

1. **`${OMNIVOICE_INDEXTTS_DIR}/.venv/`** — the install dir's own
   venv. This is what BOTH the one-click installer (which sets
   `OMNIVOICE_INDEXTTS_DIR` to its managed checkout) and a manual
   clone resolve to. Highest priority, so v0.2.7 users who already
   ran `uv pip install -e .` get zero migration cost on the upgrade
   to v0.3.x.
2. **`backend/engines/indextts/.venv/`** — OmniVoice's own venv,
   created on demand by the lazy bootstrap below.
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

You haven't installed IndexTTS yet. Click **Install** on the
IndexTTS2 row in **Settings → Engines** (recommended), or follow the
**Manual install** steps above.

### `uv was not found` / `uv is required to bootstrap the IndexTTS-2 venv but was not found on PATH`

Both the one-click installer and the bootstrap path need a working
`uv` binary (resolved from `OMNIVOICE_BUNDLED_UV`, then `PATH`).
Either install `uv` into your `PATH` (https://docs.astral.sh/uv/) or
pre-create the venv manually with `uv venv` and `uv pip install -e`
as in the manual steps.

### `Not enough disk space to install IndexTTS-2 ...`

The installer's preflight found less free space than the estimated
source + venv + weights footprint (plus headroom). The message names
the exact numbers; free up space (or move OmniVoice's data directory
to a larger volume) and click Install again — it resumes where it
stopped.

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
