# VoiceStudio — IndexTTS 2.5

IndexTTS 2.5 is an optional, multilingual voice-cloning engine for dubbing
and expressive speech. It supports Chinese, English, Japanese, Spanish, and
Arabic, with reference-audio cloning, emotion references, emotion vectors,
and text-directed emotion.

VoiceStudio runs IndexTTS in a dedicated subprocess and Python environment.
This keeps its `transformers<5` dependency isolated from VoiceStudio's
runtime. Existing user-managed IndexTTS-2 environments remain supported.

## Install

IndexTTS 2.5 is not bundled because its source environment and model weights
require substantial disk space.

1. Open **Settings → Engines**.
2. Expand **IndexTTS 2.5** and select **Install**.
3. Keep VoiceStudio open while source, dependencies, and weights download.

The installer:

- checks for `uv` and at least 12 GB of free space;
- installs the reviewed `indextts-2.5` source revision in an isolated venv;
- downloads the reviewed `IndexTeam/IndexTTS-2.5` model revision;
- resumes partial model downloads;
- saves `OMNIVOICE_INDEXTTS_DIR` and activates the engine without a restart.

App-managed IndexTTS-2 source is replaced by 2.5 when its installer is run.
User-managed clones are never modified or removed; their legacy
`indextts.infer_v2` entry point remains supported.

## Manual install

Use a separate checkout and venv. Do not install IndexTTS into VoiceStudio's
root environment.

```bash
git clone --branch indextts-2.5 https://github.com/index-tts/index-tts.git
cd index-tts
uv venv .venv
uv pip install --python .venv/bin/python -e .
hf download IndexTeam/IndexTTS-2.5 --local-dir=checkpoints
```

On Windows, replace `.venv/bin/python` with `.venv\Scripts\python.exe`.
Then set `OMNIVOICE_INDEXTTS_DIR` to the checkout root:

```bash
export OMNIVOICE_INDEXTTS_DIR=/path/to/index-tts
```

```powershell
[Environment]::SetEnvironmentVariable(
  "OMNIVOICE_INDEXTTS_DIR",
  "$env:USERPROFILE\code\index-tts",
  "User"
)
```

Restart VoiceStudio after setting a persistent environment variable outside
the app.

## Compatibility

VoiceStudio probes these locations in order:

1. `${OMNIVOICE_INDEXTTS_DIR}/.venv/`;
2. `backend/engines/indextts/.venv/`;
3. a venv bootstrapped from `OMNIVOICE_INDEXTTS_DIR`.

The probe prefers `indextts.infer_v2_5` and falls back to
`indextts.infer_v2`. A timed-out import is treated as unproven rather than
missing, preventing slow disks or antivirus scans from hiding a valid venv.
Set `OMNIVOICE_INDEXTTS_IMPORT_PROBE_TIMEOUT_S` to raise the default 60-second
probe limit.

IndexTTS 2.5 requires a language token. VoiceStudio maps locale codes and
language names to the five supported languages and detects Chinese, Japanese,
or Arabic script for Auto requests. Ambiguous Latin text defaults to English.

IndexTTS 2.5 uses `duration_factor` for native duration guidance. VoiceStudio's
dubbing fit stage remains responsible for exact segment timing. Legacy
IndexTTS-2 installations continue receiving their `target_tokens` control.

## Troubleshooting

### Engine unavailable

Use **Settings → Engines → IndexTTS 2.5 → Install**. For a manual install,
confirm that the configured directory contains:

```text
pyproject.toml
indextts/infer_v2_5.py
checkpoints/config_v2_5.yaml
```

### `uv` not found

Install `uv` from <https://docs.astral.sh/uv/> or configure the bundled binary
through `OMNIVOICE_BUNDLED_UV`.

### Import fails after installation

For an app-managed install, retry **Install** to repair the source and venv.
For a manual install, run:

```bash
uv pip install --python .venv/bin/python -e .
```

### Insufficient disk space

Free the amount reported by the installer, then retry. Completed model files
are reused.

## License

IndexTTS 2.5 uses the upstream Bilibili model license. It permits academic
research, education, and non-commercial use subject to its terms. Commercial
use requires permission from the upstream authors. Review the license on the
[IndexTTS 2.5 model page](https://huggingface.co/IndexTeam/IndexTTS-2.5)
before use.

See [Engine venvs and disk usage](disk-usage.md) for storage details.
