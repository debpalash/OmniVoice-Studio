# OmniVoice Studio — OpenAI-Compatible Remote ASR

Point transcription at **any** server exposing an OpenAI-compatible
`POST /v1/audio/transcriptions` endpoint — LM Studio or a llama.cpp-style
local server, a self-hosted Qwen3-ASR/FunASR/SenseVoice box on your network,
Groq, or OpenAI's own Whisper API. Unlike every other ASR engine, this one
runs no model locally: it's a pure network client, so it needs no install
and claims no GPU.

## Setup

Everything lives on one screen — **Settings → Engines**, **ASR** tab:

1. The **OpenAI-compatible (remote server)** row shows as unavailable until
   a server is configured. The config panel appears **below the engine
   list** while the ASR tab is selected.
2. Set **Server URL** to your server's base URL (see the examples below).
3. Set **Model** to whatever your server expects (`whisper-1` for OpenAI's
   API; check your server's docs or its `/v1/models` listing otherwise).
4. **API key** is optional — many self-hosted servers accept requests
   without one. Set it if your server requires auth. The key is stored
   encrypted on your machine and is never displayed or sent anywhere except
   the server you configured.
5. Click **Test connection**. This saves the fields, then sends one tiny
   `GET /models` request to the server — no audio is uploaded, nothing is
   transcribed. You'll see the round-trip latency on success (plus whether
   your configured model is in the server's list), or the exact failure
   (unreachable / timeout / rejected key / HTTP status) if not.
6. Click **Use** on the engine's row to make it the active ASR engine — the
   same picker every engine family has. Power users can pin it instead with
   `OMNIVOICE_ASR_BACKEND=openai-compat-asr` before launching; the env var
   always wins over the Settings pick.

Config changes apply on the next transcription — no restart needed. The
engine is never active by default: OmniVoice's ASR auto-detect only ever
picks local engines, and the app works fully with this engine unconfigured.

## Examples

| Server | Server URL | Model | API key |
| --- | --- | --- | --- |
| LM Studio (local) | `http://localhost:1234/v1` | the model name shown in LM Studio | none |
| llama.cpp / whisper.cpp server (local) | `http://localhost:8080/v1` | whatever the server loads (often ignored) | none |
| speaches / faster-whisper-server (local) | `http://localhost:8000/v1` | e.g. `Systran/faster-whisper-large-v3` | none |
| Self-hosted Qwen3-ASR / FunASR (LAN box) | `http://<host>:8000/v1` | your deployment's model id | if you enabled auth |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3` | required |
| OpenAI | `https://api.openai.com/v1` | `whisper-1` | required |

Local servers vary in which endpoints they implement — if **Test
connection** reports the server is reachable but doesn't list models,
transcription may still work; run a small dictation or dub-transcribe to
confirm.

## Response format

The backend prefers `response_format=verbose_json` for real per-segment
timestamps (OpenAI's API and most compatible servers support it) and falls
back to plain text automatically if your server rejects that format. Neither
path returns word-level timestamps — that's not part of this API.

## Privacy note

Unlike every other ASR engine in OmniVoice, audio sent through this backend
leaves your machine — to whatever server **you** configured, and nowhere
else. If that's a self-hosted server on your own network, nothing leaves
your control; if it's a third-party API (Groq, OpenAI's, or someone
else's), review their data handling before sending anything sensitive.
