# MCP Setup, Lifecycle, Troubleshooting

## Install (one-time, from repo root)

```bash
uv sync                                                # ~1.6 GB venv on darwin arm64
VIRTUAL_ENV="$(pwd)/.venv" uv pip install 'mcp[cli]'   # SDK not in lockfile yet (see Issue: pyproject mcp dep)
bun install                                            # optional — only if running the frontend
```

First synthesis call lazy-downloads the `k2-fsa/OmniVoice` model (~2.4 GB) into the HuggingFace cache (`~/.cache/huggingface/hub/`). Subsequent boots reuse it.

## MCP Wiring

Drop into your MCP client config (Claude Desktop, Claude Code at `~/.claude.json`, Cursor, etc.). Replace `<REPO>` with the absolute path:

```json
{
  "mcpServers": {
    "omnivoice": {
      "type": "stdio",
      "command": "uv",
      "args": ["--directory", "<REPO>", "run", "python", "-m", "backend.mcp_server"],
      "env": { "OMNIVOICE_API_URL": "http://localhost:3900" }
    }
  }
}
```

Restart the MCP client. The server only starts at client launch — in-session edits do not hot-reload.

## Backend Lifecycle

The MCP server needs the FastAPI backend running:

```bash
# Foreground (logs in terminal)
uv run uvicorn main:app --app-dir backend --host 127.0.0.1 --port 3900

# Detached
nohup uv run uvicorn main:app --app-dir backend --host 127.0.0.1 --port 3900 \
  > backend.log 2>&1 &
```

`127.0.0.1` keeps the API local-only (the project's `package.json` defaults to `0.0.0.0` which is wider than needed for personal use).

First boot runs alembic migrations on the SQLite settings DB at `<data_dir>/omnivoice.db`. Idempotent.

## Idle Behavior

`GET /system/info` exposes `idle_timeout_seconds: 900`. After 15 min of no synthesis, the diffusion model is evicted from GPU memory but the FastAPI server stays up. Next call pays ~5-10 s warm-up.

## Environment Variables

| Var | Default | Purpose |
|---|---|---|
| `OMNIVOICE_API_URL` | `http://localhost:3900` | MCP server's target backend URL |
| `OMNIVOICE_TTS_BACKEND` | `omnivoice` | Switch engine: `cosyvoice`, `mlx-audio`, `voxcpm2`, `moss-tts-nano`, `kittentts` |
| `HF_TOKEN` | (none) | Only needed for gated pyannote diarization models — basic TTS does not require one |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| MCP tool returns connection error | Backend not running | `scripts/start-backend.sh` |
| `address already in use` | Stale uvicorn on 3900 | `lsof -nP -iTCP:3900 -sTCP:LISTEN` → `kill -TERM <pid>` |
| `FastMCP.__init__() got unexpected keyword argument 'version'` | mcp SDK ≥ 1.10 dropped `version`/`description` | Already fixed: `instructions=` replaces `description=`; `version=` removed |
| First call hangs 5-10 min | Model download from HuggingFace | Watch `~/.cache/huggingface/hub/models--k2-fsa--OmniVoice/` grow |
| `/health` returns 500 | Alembic migration failed | Inspect `<data_dir>/crash_log.txt` |
| Voice profile not found | `profile_id` invalid or profile not yet created | `list_voices` first to get valid IDs |
| Generation slow on Apple Silicon | Diffusion fell back to CPU | `/health` should return `"device":"mps"`. Lower `steps` from 16 → 8 for drafts |

## Clean shutdown

```bash
scripts/stop-backend.sh
```

User profiles + history live in the platform data dir (`~/Library/Application Support/OmniVoice/` on macOS). Preserve across reinstalls.
