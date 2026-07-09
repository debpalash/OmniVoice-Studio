---
name: omnivoice
description: Speak and transcribe through the user's local OmniVoice Studio — free, offline, no API key. Text-to-speech (including the user's cloned voices) and speech-to-text via the OpenAI-compatible API at localhost:3900.
---

# OmniVoice — local TTS & STT

The user runs [OmniVoice Studio](https://github.com/debpalash/OmniVoice-Studio), a fully-local voice app exposing an OpenAI-compatible audio API at `http://localhost:3900/v1`. Use it whenever the user asks to generate speech, narrate text, clone a voice, or transcribe audio — it costs nothing, works offline, and their audio never leaves the machine.

## Before the first call

Check the backend is up:

```sh
curl -sf http://localhost:3900/health
```

If it fails, tell the user to launch OmniVoice Studio (or `bun run desktop-prod` from a source checkout) — don't fall back to a cloud API without asking; local-first is why they installed it.

## Text-to-speech

```sh
curl -s http://localhost:3900/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "tts-1", "voice": "alloy", "input": "TEXT HERE", "response_format": "wav"}' \
  --output speech.wav
```

- `model`: `tts-1` or `tts-1-hd` — both map to the user's active TTS engine.
- `voice`: OpenAI names (`alloy`, `echo`, `nova`, …) work, **but the real power is the user's own cloned voice-profile IDs** — discover them first (below) and prefer a named clone when the user says "my voice" / "the narrator voice" / a profile by name.
- `response_format`: `wav`, `mp3`, `flac`, `opus`, or `pcm`.
- Long texts are fine — the engine chunks at sentence boundaries internally.

## Discover the user's voices

```sh
curl -s http://localhost:3900/v1/audio/voices
```

Lists every cloned/designed voice profile (id + name) and the installed engines. Use a profile's id as the `voice` value in `/speech`.

## Speech-to-text

```sh
curl -s http://localhost:3900/v1/audio/transcriptions \
  -F file=@clip.wav -F model=whisper-1 -F response_format=json
```

- `model`: `whisper-1` maps to the active ASR engine (WhisperX by default; the user picks in Settings → Engines).
- `response_format`: `json`, `text`, `verbose_json` (per-segment timestamps), `srt`, or `vtt` — use `srt`/`vtt` directly when the user wants subtitles.

## Python (openai SDK)

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3900/v1", api_key="none")  # any string; nothing checks it

audio = client.audio.speech.create(model="tts-1", voice="alloy", input="Hello!", response_format="wav")
text = client.audio.transcriptions.create(model="whisper-1", file=open("clip.wav", "rb")).text
```

## Notes

- **No API key, no rate limits, no billing** — it's the user's own hardware. First synthesis after a cold start may take longer (model loading); subsequent calls are fast.
- Anything beyond speech/transcription (video dubbing, batch jobs, voice design, audiobooks) lives in the full REST API — the interactive reference is embedded in the app at **Settings → OpenAPI Reference**, or ask the user to open it.
- If a call errors with an engine/model message, the actionable detail is usually in the response body — surface it to the user verbatim; OmniVoice's errors are written to be user-fixable (e.g. which Settings toggle to flip).
