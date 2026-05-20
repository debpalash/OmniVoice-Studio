---
name: omnivoice
description: "Local TTS, voice cloning, voice design, and video dubbing via the OmniVoice Studio MCP server bundled in this repository. Open-source ElevenLabs alternative — nothing leaves the machine, 646 languages, runs on MPS/CUDA/ROCm/CPU. Use when: (1) generating speech from text in any of 646 languages, (2) cloning a voice from a 3-second reference clip, (3) designing a voice by gender/age/accent/pitch/style, (4) dubbing a video into another language, (5) listing voice profiles or personalities, (6) producing narration where privacy, cost, or absent API keys matter, (7) batch audio for blog posts or content pipelines. Triggers: 'omnivoice', 'voice clone', 'clone this voice', 'tts', 'narrate', 'generate speech', 'voice synthesis', 'dub video', 'voice design', 'local tts', 'multilingual voice', 'elevenlabs alternative'."
---

# OmniVoice — Agent Skill (Bundled)

This skill ships in `<repo>/.claude/skills/omnivoice/` so any agent (Claude Code, Cursor, etc.) cloning the repo gets immediate access to the MCP integration with zero further configuration.

## Prerequisites

```bash
# From repo root
uv sync                                              # ~1.6 GB venv on darwin arm64
VIRTUAL_ENV="$(pwd)/.venv" uv pip install 'mcp[cli]' # MCP SDK not in lockfile yet
```

Then wire the MCP server into your client (Claude Desktop / Claude Code / Cursor). For Claude Code at `~/.claude.json`:

```json
{
  "mcpServers": {
    "omnivoice": {
      "type": "stdio",
      "command": "uv",
      "args": ["--directory", "<absolute path to this repo>",
               "run", "python", "-m", "backend.mcp_server"],
      "env": { "OMNIVOICE_API_URL": "http://localhost:3900" }
    }
  }
}
```

The MCP server is a thin wrapper around the FastAPI backend on `127.0.0.1:3900`. **Backend must be running** for every MCP tool call. See [references/mcp-setup.md](references/mcp-setup.md) for lifecycle, env vars, and troubleshooting.

## Tools

| Tool | What it does |
|---|---|
| `check_health` | `GET /health` — verifies backend is up and reports active device (mps/cuda/cpu) |
| `list_voices` | `GET /profiles` — saved voice profiles (id, name, type, personality) |
| `list_personalities` | `GET /personalities` — pre-made `instruct` presets (narrator, casual, news-anchor, …) |
| `list_languages` | Static list — 20 popular ISO codes + count (646 total) |
| `generate_speech(text, language, profile_id, instruct, speed, steps)` | `POST /generate` — returns base64 WAV (16-bit, 24 kHz, mono) plus `audio_id`, `generation_time_s`, `audio_duration_s` |

Resources: `voice://{profile_id}` (profile detail), `history://recent` (last 20 generations).

## Quick Decisions

- **Want a saved voice?** Pass `profile_id`. List with `list_voices`. `demo0001` is the bundled demo.
- **No reference clip — describe the voice in words?** Skip `profile_id`, pass `instruct` (e.g. `"warm middle-aged female narrator, calm pace"`). Copy an `instruct` from `list_personalities`.
- **Non-English?** Pass `language="es"` (any ISO 639) or `language="Auto"` for detection. All 646 supported langs handled by the same call.
- **Quality vs speed?** `steps=8` fast/draft · `steps=16` balanced (default) · `steps=32` quality.

## Workflows

### One-shot synthesis (returned WAV)

```python
result = generate_speech(
    text="Welcome to OmniVoice Studio.",
    profile_id="demo0001",
    language="English",
    steps=16,
)
# Decode the base64 wav from result["wav_base64"] and write to disk.
```

### Voice clone

Profile creation happens **outside** the MCP server — either via:

- the Tauri desktop UI (`bun run desktop` in repo root), or
- `POST /profiles` to the FastAPI backend with the 3-sec reference WAV (multipart form). Schema at `http://127.0.0.1:3900/docs`.

Once the profile exists, pass its `id` as `profile_id` to `generate_speech`.

### Voice design

Pass `instruct` describing the desired voice + omit `profile_id`. `list_personalities` returns canned `instruct` strings for common briefs.

### Video dubbing

The dub pipeline (transcribe → translate → re-voice → mux) is NOT exposed via MCP. Use the desktop UI or call the `/dub/*` REST routes directly. The MCP surface intentionally covers the synthesis primitives only.

## When NOT to use this skill

- **Fast English narration on weak hardware** → kokoro-tts is ~30 MB vs OmniVoice's 2.4 GB; 2× realtime on CPU
- **One-off TTS with no install** → Edge TTS is one `pip install` away
- **Highest English polish** → ElevenLabs still tops the polish leaderboard for English
- **Real-time streaming dictation** → use the OmniVoice desktop dictation widget (`⌘+⇧+Space`); the MCP server is request/response

## Resources

- [references/mcp-setup.md](references/mcp-setup.md) — Backend lifecycle, env vars, troubleshooting
- [scripts/check-health.sh](scripts/check-health.sh) — Curl `/health`, exit 0/1
- [scripts/start-backend.sh](scripts/start-backend.sh) — Boot uvicorn on 127.0.0.1:3900 with health probe
- [scripts/stop-backend.sh](scripts/stop-backend.sh) — Graceful SIGTERM on the bound PID
