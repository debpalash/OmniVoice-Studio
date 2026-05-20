# OmniVoice MCP Setup, Lifecycle, Troubleshooting

## Install

```bash
# Pick any location. The scripts in this skill default to ~/OmniVoice-Studio if
# $OMNIVOICE_HOME is unset.
export OMNIVOICE_HOME="${HOME}/OmniVoice-Studio"

git clone https://github.com/debpalash/OmniVoice-Studio.git "$OMNIVOICE_HOME"
cd "$OMNIVOICE_HOME"
uv sync                                                  # ~1.6 GB venv on darwin arm64
VIRTUAL_ENV="$(pwd)/.venv" uv pip install 'mcp[cli]'     # SDK not in their lockfile yet
```

Any non-default install location works as long as `$OMNIVOICE_HOME` is set in the env that launches the MCP server.

## MCP Wiring

Drop into your MCP client config (Claude Desktop, Claude Code at `~/.claude.json`, Cursor, OpenClaw, etc.). Replace `<OMNIVOICE_HOME>` with the absolute path:

```json
{
  "mcpServers": {
    "omnivoice": {
      "type": "stdio",
      "command": "uv",
      "args": [
        "--directory", "<OMNIVOICE_HOME>",
        "run", "python", "-m", "backend.mcp_server"
      ],
      "env": { "OMNIVOICE_API_URL": "http://localhost:3900" }
    }
  }
}
```

Restart the MCP client. The server only starts at client launch — in-session edits do not hot-reload.

> **Note (mcp SDK ≥ 1.10):** If you see `TypeError: FastMCP.__init__() got an unexpected keyword argument 'version'`, your `OmniVoice-Studio` checkout is older than [debpalash/OmniVoice-Studio#112](https://github.com/debpalash/OmniVoice-Studio/pull/112). Either `git pull` once that PR lands, or apply the 3-line patch manually: replace `version="…", description=(…)` with `instructions=(…)` in `backend/mcp_server.py`.

## Backend Lifecycle

The MCP server needs the FastAPI backend running:

```bash
# Foreground (logs in terminal)
cd "$OMNIVOICE_HOME"
uv run uvicorn main:app --app-dir backend --host 127.0.0.1 --port 3900

# Detached, via the helper script in this skill
scripts/start-backend.sh                                  # idempotent
scripts/check-health.sh                                   # exit 0/1
scripts/stop-backend.sh                                   # graceful SIGTERM
```

`127.0.0.1` keeps the API local-only. The project's `package.json` defaults to `0.0.0.0` which exposes the API on all interfaces — wider than needed for personal use.

First boot runs alembic migrations on the SQLite settings DB at `<data_dir>/omnivoice.db`. Idempotent — safe to re-run.

First synthesis call lazy-downloads the `k2-fsa/OmniVoice` model (~2.4 GB) into the HuggingFace cache. Path varies by OS:

- **macOS / Linux**: `~/.cache/huggingface/hub/`
- **Windows**: `%LOCALAPPDATA%\OmniVoice\hf_cache` (OmniVoice redirects via `backend/core/config.py` to keep the cache off the system drive root)

Cached on subsequent boots.

## Idle Behavior

`GET /system/info` exposes `idle_timeout_seconds: 900`. After 15 min of no synthesis, the diffusion model is evicted from GPU memory but the FastAPI server stays up. Next call pays ~5-10 s warm-up.

## Environment Variables

| Var | Default | Purpose |
|---|---|---|
| `OMNIVOICE_HOME` | `~/OmniVoice-Studio` | Where the OmniVoice Studio repo is cloned (used by scripts in this skill) |
| `OMNIVOICE_API_URL` | `http://localhost:3900` | MCP server's target backend URL |
| `OMNIVOICE_TTS_BACKEND` | `omnivoice` | Switch engine: `cosyvoice`, `mlx-audio`, `voxcpm2`, `moss-tts-nano`, `kittentts` |
| `HF_TOKEN` | (none) | Only needed for gated pyannote diarization models — basic TTS does not require one |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| MCP tool returns connection error | Backend not running | `scripts/start-backend.sh` |
| `address already in use` | Stale uvicorn on 3900 | `lsof -nP -iTCP:3900 -sTCP:LISTEN` → `kill -TERM <pid>` |
| `FastMCP.__init__() got unexpected keyword argument 'version'` | mcp SDK ≥ 1.10 dropped `version`/`description`, checkout pre-dates [#112](https://github.com/debpalash/OmniVoice-Studio/pull/112) | Update the checkout or apply the 3-line patch manually |
| First call hangs 5-10 min | Model download from HuggingFace | Watch `~/.cache/huggingface/hub/models--k2-fsa--OmniVoice/` grow |
| `/health` returns 500 | Alembic migration failed | Inspect `<data_dir>/crash_log.txt` |
| Voice profile not found | `profile_id` invalid or profile not yet created | `list_voices` first to get valid IDs |
| `pyannote.audio` errors at startup | Missing `HF_TOKEN` for diarization | Only matters for dub pipeline; basic TTS unaffected |
| Generation slow on Apple Silicon | Diffusion fell back to CPU | `/health` should return `"device":"mps"`. Lower `steps` from 16 → 8 for drafts |

## Clean teardown

```bash
scripts/stop-backend.sh                                   # graceful shutdown
# Uninstall: rm -rf "$OMNIVOICE_HOME" ~/.cache/huggingface/hub/models--k2-fsa--OmniVoice
# Remove the `omnivoice` entry from your MCP client config
```

User profiles + history live in the platform data dir (`~/Library/Application Support/OmniVoice/` on macOS; `~/.local/share/OmniVoice/` on Linux). Preserve across reinstalls if you want to keep your saved voice profiles.
