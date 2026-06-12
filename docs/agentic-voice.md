# Agentic voice: OmniVoice as a TTS/STT provider

OmniVoice exposes an **OpenAI-compatible API**, so any agent framework that
speaks to OpenAI's audio endpoints can use your local OmniVoice for speech —
in your own cloned voice, with nothing leaving your machine. You bring the
agent runtime; OmniVoice is the voice.

This is "agentic v1": OmniVoice is a provider, not the orchestrator. You wire
your own agent (a support line, a desk assistant, a Discord persona) and point
its TTS/STT at OmniVoice.

> **Scope.** This page covers OmniVoice-as-provider. Outbound phone calls are a
> separate, deferred milestone (they need a paid carrier — there is no
> fully-local path to the PSTN) and ship only behind explicit consent
> guardrails. See the roadmap in `docs/competitive-analysis.md` (§R1).

## The endpoints

OmniVoice serves these on `http://localhost:3900/v1` (or your
[remote backend URL](remote-gpu.md)):

| OpenAI route | OmniVoice support |
|---|---|
| `POST /v1/audio/speech` | TTS. `model` = engine id, `voice` = a voice-profile id (your clone) or preset, `response_format` incl. `pcm` and `wav`, `speed`. Default output is 24 kHz. |
| `POST /v1/audio/transcriptions` | STT (Whisper-family). |
| `GET /v1/audio/voices` | list available voices (OmniVoice extension). |

A contract test (`tests/test_agentic_provider_contract.py`) pins this request
shape in CI, so the recipes below won't silently break.

## pipecat (recommended)

[pipecat](https://github.com/pipecat-ai/pipecat) (BSD-2) runs as a Python
library inside your own process — no extra server. Point its OpenAI TTS/STT
services at OmniVoice:

```python
from pipecat.services.openai.tts import OpenAITTSService
from pipecat.services.openai.stt import OpenAISTTService

tts = OpenAITTSService(
    base_url="http://localhost:3900/v1",
    api_key="not-needed-locally",        # any string; OmniVoice ignores it unless OMNIVOICE_API_KEY is set
    voice="<your-voice-profile-id>",     # from GET /v1/audio/voices, or "default"
    model="omnivoice",                   # or any installed engine id
    sample_rate=24000,                   # matches OmniVoice's default output
)

stt = OpenAISTTService(
    base_url="http://localhost:3900/v1",
    api_key="not-needed-locally",
)
```

Drop those into any pipecat pipeline (VAD, turn-taking, and LLM stay local
too). A minimal runnable example is in
[`examples/agentic/pipecat_minimal.py`](../examples/agentic/pipecat_minimal.py).

## LiveKit Agents

[LiveKit Agents](https://github.com/livekit/agents) (Apache-2.0) needs a
LiveKit media server alongside, but its OpenAI plugin takes the same
`base_url`:

```python
from livekit.plugins import openai

tts = openai.TTS(base_url="http://localhost:3900/v1", api_key="x", voice="<profile-id>")
stt = openai.STT(base_url="http://localhost:3900/v1", api_key="x")
```

Choose LiveKit over pipecat only when you need its WebRTC/SIP scale; for a
single local agent, pipecat is lighter.

## Remote backend

Running OmniVoice on a [remote GPU box](remote-gpu.md)? Use that backend's URL
as `base_url` and pass its `OMNIVOICE_API_KEY` as the `api_key` — the same
bearer the rest of the app uses. Keep it on your tailnet, not the open
internet.

## Use your own voice responsibly

When an agent speaks in a cloned voice, prefer a profile you've marked
**verified own voice** (Settings → a voice profile → Voice ownership). That
consent lock is what gates the heavier agentic features as they land, and
it's the honest default for "an AI is speaking as me."
