"""Minimal pipecat agent that speaks and listens through local OmniVoice.

OmniVoice is used purely as an OpenAI-compatible TTS/STT provider — nothing
leaves your machine. See docs/agentic-voice.md for the full recipe.

Run OmniVoice first (default http://localhost:3900), then:

    uv pip install "pipecat-ai[openai,silero]"
    python examples/agentic/pipecat_minimal.py

This is a deliberately tiny skeleton: it wires the OmniVoice TTS/STT services
into a pipecat pipeline and leaves the transport + LLM for you to choose. It
does not run a phone call or a server — that is the "agentic v1" scope
(OmniVoice as provider, you bring the runtime).
"""

from __future__ import annotations

import os

OMNIVOICE_BASE_URL = os.environ.get("OMNIVOICE_API_URL", "http://localhost:3900") + "/v1"
# OmniVoice ignores the key for local use; if you set OMNIVOICE_API_KEY on a
# remote backend, pass that same value here.
OMNIVOICE_API_KEY = os.environ.get("OMNIVOICE_API_KEY", "not-needed-locally")
# A voice-profile id from GET /v1/audio/voices, or "default".
OMNIVOICE_VOICE = os.environ.get("OMNIVOICE_VOICE", "default")


def build_services():
    """Return (stt, tts) backed by local OmniVoice.

    Imported lazily so this file is importable (and lint-clean) without
    pipecat installed — the smoke test in CI checks the wiring shape, not a
    live pipeline.
    """
    from pipecat.services.openai.stt import OpenAISTTService
    from pipecat.services.openai.tts import OpenAITTSService

    stt = OpenAISTTService(
        base_url=OMNIVOICE_BASE_URL,
        api_key=OMNIVOICE_API_KEY,
    )
    tts = OpenAITTSService(
        base_url=OMNIVOICE_BASE_URL,
        api_key=OMNIVOICE_API_KEY,
        voice=OMNIVOICE_VOICE,
        model="omnivoice",
        sample_rate=24000,  # OmniVoice's default output rate
    )
    return stt, tts


def main() -> None:
    stt, tts = build_services()
    print("OmniVoice STT + TTS services constructed against", OMNIVOICE_BASE_URL)
    print("Wire `stt` and `tts` into your pipecat Pipeline with a transport")
    print("and an LLM service. See docs/agentic-voice.md.")


if __name__ == "__main__":
    main()
