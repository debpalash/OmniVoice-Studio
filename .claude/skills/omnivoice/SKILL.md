---
name: omnivoice
description: "Local TTS, voice cloning, voice design, and video dubbing via the OmniVoice Studio MCP server (open-source ElevenLabs alternative; nothing leaves the machine, runs on MPS/CUDA/CPU). Use when: (1) generating speech from text in any of 646 languages, (2) cloning a voice from a 3-second reference clip, (3) designing a voice by gender/age/accent/pitch/style, (4) dubbing a video into another language, (5) listing voice profiles or personality presets, (6) producing narration where privacy, cost, or absent API keys matter, (7) non-English narration where Edge TTS/kokoro fall short, (8) batch audio for blog posts or content pipelines. Triggers: 'omnivoice', 'voice clone', 'clone this voice', 'tts', 'narrate', 'generate speech', 'voice synthesis', 'dub video', 'voice design', 'local tts', 'multilingual voice', 'narrate this post', 'elevenlabs alternative'."
---

# OmniVoice

## Overview

Generate audio locally via the OmniVoice Studio MCP server. Tools: `generate_speech`, `list_voices`, `list_personalities`, `list_languages`, `check_health`. Resources: `voice://{id}`, `history://recent`.

## Prerequisites — Backend Must Be Running

The MCP tools all hit `$OMNIVOICE_API_URL` (default `http://localhost:3900`). If the backend is down, every tool returns a connection error. Install + boot:

```bash
git clone https://github.com/debpalash/OmniVoice-Studio.git "$OMNIVOICE_HOME"
cd "$OMNIVOICE_HOME"
uv sync
VIRTUAL_ENV="$(pwd)/.venv" uv pip install 'mcp[cli]'
```

Then:

```bash
scripts/check-health.sh        # exit 0 if up
scripts/start-backend.sh       # boot in background (MPS/CUDA auto-detected)
```

First synthesis call lazy-downloads the `k2-fsa/OmniVoice` model (~2.4 GB) from HuggingFace — cached on subsequent boots.

## Task Index — Pick the Right Tool

| Task | Tool | Notes |
|---|---|---|
| Verify backend is up | `check_health` | Returns `{"status":"ok","device":"mps|cuda|cpu"}` |
| Text → audio with a saved voice | `generate_speech(text, profile_id)` | Returns base64 WAV. `profile_id="demo0001"` is the bundled demo voice |
| Text → audio without a clone (voice design) | `generate_speech(text, instruct="…")` | Omit `profile_id`; pass an `instruct` like `"warm middle-aged female narrator, calm pace"` |
| Multilingual narration | `generate_speech(text, language="es")` | Any ISO 639 code or `"Auto"` |
| List existing voices | `list_voices` | Returns id, name, type, personality |
| List personality presets | `list_personalities` | Returns narrator / casual / news-anchor / etc. with their `instruct` strings |
| List supported languages | `list_languages` | 646 total; returns 20 popular + the full count |

For non-trivial decisions (which engine to use, when to pick OmniVoice over kokoro / Edge TTS / ElevenLabs), see [references/engines-comparison.md](references/engines-comparison.md).

For MCP wiring details, backend lifecycle, troubleshooting, and a clean teardown, see [references/mcp-setup.md](references/mcp-setup.md).

## Common Workflows

### 1. One-shot narration with the demo voice

```python
# As called through the MCP client (your agent will do this for you):
result = generate_speech(
    text="Hello — this is OmniVoice generating speech locally.",
    profile_id="demo0001",
    language="English",
    steps=16,                   # 8 = fast/draft · 16 = balanced · 32 = quality
)
# result is JSON with audio_id, generation_time_s, audio_duration_s, format, wav_base64
```

Benchmark: 4.2 s of audio in ~24 s server-side on Apple Silicon MPS at 16 diffusion steps.

### 2. Save the WAV to disk and play

Tool returns base64 PCM WAV (16-bit, mono, 24 kHz). Decode + write:

```python
import base64, json
payload = json.loads(result_text)            # parse JSON the tool returns
open("out.wav","wb").write(base64.b64decode(payload["wav_base64"]))
```

On macOS: `afplay out.wav`. Convert to MP3 with `ffmpeg -i out.wav -codec:a libmp3lame -b:a 128k out.mp3`.

### 3. Voice clone — end-to-end recipe

Cloning needs a 3-10 second reference clip the model will use as a speaker embedding. The MCP server does NOT expose profile creation — it only reads existing profiles. Two paths to create one:

**Path A — bundled helper (macOS, recommended for fresh clones):**

```bash
scripts/record-reference.sh ~/Downloads/my-ref.wav 12 1
# args: output_path raw_duration_sec mic_index
# Default mic_index=1 (MacBook built-in); list devices via:
#   ffmpeg -f avfoundation -list_devices true -i ""
```

The script gives **audible** countdown + start/stop cues via macOS `say` + `/System/Library/Sounds/Ping.aiff` so the user knows when to speak (terminal stdout is buffered — text "speak now" prompts arrive too late). It records a longer raw window, then trims to ~10 seconds of speech via `silenceremove + atrim`, plays back for verification, and prints the next-step `curl` command.

**Path B — manual:**

```bash
# 1. Record (mono, 24 kHz native — matches model's internal rate)
ffmpeg -f avfoundation -i ":1" -t 12 -ac 1 -ar 24000 raw.wav

# 2. Trim leading silence + take first 10 sec of speech
ffmpeg -i raw.wav \
  -af "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-40dB,atrim=end=10" \
  -ac 1 -ar 24000 ref.wav

# 3. Verify
ffmpeg -i ref.wav -af volumedetect -f null - 2>&1 | grep volume   # max should be > -20 dB
afplay ref.wav
```

**POST to /profiles** (multipart/form-data — required fields: `name`, `ref_audio`):

```bash
curl -X POST http://127.0.0.1:3900/profiles \
  -F "name=carlos-clone" \
  -F "ref_audio=@ref.wav" \
  -F "ref_text=The exact text spoken in the clip" \
  -F "language=English" \
  | python3 -m json.tool
# returns { "id": "abc12345", "name": "carlos-clone" }
```

Once created, pass `profile_id` to `generate_speech` (via MCP) or directly via `POST /generate`. Profiles persist in SQLite + reference-audio files at `~/Library/Application Support/OmniVoice/voices/<id>.<ext>` (the backend preserves the uploaded extension — `.wav` if you uploaded a WAV, `.mp3` if MP3, etc.). State persists across backend restarts.

**Reference clip tips that materially affect quality:**

| Factor | Why it matters |
|---|---|
| Single speaker | Mixed speakers blur the embedding |
| Clean speech, no music/noise | Model embeds the noise too |
| Natural prosody (avoid pangrams) | Diffusion samples replicate prosody, not just timbre |
| 3-10 sec is the sweet spot | < 3 s lacks information; > 10 s adds compute without quality gain |
| Match `ref_text` to what's spoken | Improves alignment, especially on noisy refs |
| `language` correct | Wrong language → cross-lingual transfer artifacts |
| Loudness peak ≥ -15 dB | Quiet refs work but normalize poorly |

### 4. Voice design (no reference clip)

Skip `profile_id`; provide an `instruct` string describing the desired voice:

```python
generate_speech(
    text="Welcome to the future of agentic systems.",
    instruct="warm middle-aged female narrator, calm authoritative pace, documentary style",
)
```

Get pre-made instructs via `list_personalities` and copy the one matching the brief (narrator, casual, news-anchor, etc.).

### 5. Video dubbing (web UI only)

The MCP server does not expose the dubbing endpoint. The full transcribe → translate → re-voice → mux pipeline lives behind the desktop UI (`bun run desktop` in `$OMNIVOICE_HOME`) and the `/dub/*` REST routes. When the user asks to dub a video, point them to the UI; surface this skill only for the synthesis primitives above.

## When NOT to use OmniVoice

- **Fast English-only narration on weak hardware** → `kokoro-tts` is ~10× smaller and 2× realtime on CPU (see [references/engines-comparison.md](references/engines-comparison.md))
- **Lowest-friction one-off TTS** → Edge TTS needs no install or backend
- **Highest possible quality regardless of cost** → ElevenLabs still wins on English narration polish; OmniVoice ties or wins on multilingual + cloning
- **Real-time streaming dictation** → use the OmniVoice desktop widget (`⌘+⇧+Space`), not the MCP server

## Resources

- [references/engines-comparison.md](references/engines-comparison.md) — Decision tree across OmniVoice / kokoro / Voicebox / Edge TTS / ElevenLabs / cloud APIs
- [references/mcp-setup.md](references/mcp-setup.md) — MCP wiring, backend lifecycle, env vars, troubleshooting
- [scripts/check-health.sh](scripts/check-health.sh) — `curl /health`, exit 0/1
- [scripts/start-backend.sh](scripts/start-backend.sh) — Start uvicorn on 127.0.0.1:3900 with health probe
- [scripts/stop-backend.sh](scripts/stop-backend.sh) — Clean shutdown via `kill -TERM` on the bound PID
- [scripts/record-reference.sh](scripts/record-reference.sh) — macOS-only: record + trim + verify a reference clip for cloning, with audible cues (`say` + system beeps) that bypass terminal output buffering

Backend Swagger / OpenAPI: `http://127.0.0.1:3900/docs` (when backend is up).

Upstream: github.com/debpalash/OmniVoice-Studio — FSL-1.1-ALv2 (free for personal/internal/non-commercial; auto-converts to Apache-2.0 two years after each release).
