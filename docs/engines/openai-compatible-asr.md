# OmniVoice Studio — OpenAI-Compatible Remote ASR

A path to Qwen3-ASR, a self-hosted FunASR/SenseVoice server, or OpenAI's own
Whisper API — today, without waiting on `transformers` to ship a direct
Qwen3-ASR integration (tracked separately). Unlike every other ASR engine,
this one runs no model locally: it's a pure network client that calls any
server exposing an OpenAI-compatible `POST /v1/audio/transcriptions`
endpoint.

## Setup

No install step — configure it directly:

1. Open **Settings → Models** and find **OpenAI-compatible ASR (remote
   server)**.
2. Set **Server URL** to your server's base URL (e.g.
   `http://localhost:8000/v1` for a local Qwen3-ASR/FunASR server, or
   `https://api.openai.com/v1` for OpenAI's own API).
3. Set **Model** to whatever your server expects (`whisper-1` for OpenAI's
   API; check your self-hosted server's docs otherwise).
4. **API key** is optional — many self-hosted servers accept requests
   without one. Set it if your server requires auth, or if you're using
   OpenAI's own API.
5. Activate the engine by setting `OMNIVOICE_ASR_BACKEND=openai-compat-asr`
   before launching. There's no in-app ASR engine picker yet (only TTS
   engines have one today) — this is the one manual step until that ships.

## Response format

The backend prefers `response_format=verbose_json` for real per-segment
timestamps (OpenAI's API and most compatible servers support it) and falls
back to plain text automatically if your server rejects that format. Neither
path returns word-level timestamps — that's not part of this API.

## Privacy note

Unlike every other ASR engine in OmniVoice, audio sent through this backend
leaves your machine — to whatever server you configured. If that's a
self-hosted server on your own network, nothing leaves your control; if
it's a third-party API (OpenAI's, or someone else's), review their data
handling before sending anything sensitive.
