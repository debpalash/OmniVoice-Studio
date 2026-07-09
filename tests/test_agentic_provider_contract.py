"""Contract test for the surface agent runtimes (pipecat / LiveKit) consume.

Wave 2.5 (parity program / Action 15): OmniVoice acts as a TTS/STT provider
for pipecat and LiveKit via the OpenAI-compatible API. Those runtimes call
POST /v1/audio/speech with {model, input, voice, response_format, speed} and
expect raw audio back; pipecat's OpenAITTSService defaults to PCM @ 24 kHz.
This test pins that the endpoint accepts exactly that request shape and
returns audio, so a change can't silently break the documented recipe
(docs/agentic-voice.md). Mirrors tests/test_pyvideotrans_contract.py.

Engine stubbed (pattern from tests/test_generate_engine.py). Requires
importing `main` — validated in CI (local torch/Triton segfault, see
project memory).
"""
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import importlib

import pytest
import torch


def _tts_mod():
    return importlib.import_module("services.tts_backend")


def _make_fake_engine(engine_id="fake-agent-engine"):
    class _FakeEngine(_tts_mod().TTSBackend):
        id = engine_id
        display_name = "Fake Agent Engine (test)"
        calls: list = []

        @property
        def sample_rate(self) -> int:
            return 24000  # pipecat's OpenAITTSService default

        @property
        def supported_languages(self) -> list[str]:
            return ["multi"]

        @classmethod
        def is_available(cls):
            return True, "ready"

        def generate(self, text, **kw) -> torch.Tensor:
            type(self).calls.append((text, kw))
            return torch.zeros(1, 4800)

    return _FakeEngine


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app, client=("127.0.0.1", 50000))


def test_pipecat_speech_request_returns_pcm(client, monkeypatch):
    """The exact body pipecat's OpenAITTSService sends → raw PCM bytes."""
    fake = _make_fake_engine()
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-agent-engine", fake)

    res = client.post("/v1/audio/speech", json={
        "model": "fake-agent-engine",
        "input": "Hello from the agent.",
        "voice": "default",
        "response_format": "pcm",
        "speed": 1.0,
    })

    assert res.status_code == 200, res.text
    # PCM is raw int16 samples — no container header, even byte length.
    assert len(res.content) > 0 and len(res.content) % 2 == 0
    assert len(fake.calls) == 1
    assert fake.calls[0][0] == "Hello from the agent."


def test_wav_format_for_runtimes_that_prefer_a_container(client, monkeypatch):
    fake = _make_fake_engine("fake-agent-wav")
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-agent-wav", fake)

    res = client.post("/v1/audio/speech", json={
        "model": "fake-agent-wav",
        "input": "Container please.",
        "response_format": "wav",
    })
    assert res.status_code == 200, res.text
    assert res.content[:4] == b"RIFF"
    assert res.headers["content-type"].startswith("audio/")


def test_voice_profile_id_resolves_for_agent_binding(client, monkeypatch, tmp_path):
    """An agent bound to a cloned voice passes the profile ID as `voice`."""
    fake = _make_fake_engine("fake-agent-voice")
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-agent-voice", fake)

    # Unknown id falls through to the engine as a preset name (no DB row) —
    # the contract is that a non-alias voice is forwarded, not rejected.
    res = client.post("/v1/audio/speech", json={
        "model": "fake-agent-voice",
        "input": "In my voice.",
        "voice": "some-profile-id",
    })
    assert res.status_code == 200, res.text
    assert fake.calls[0][1].get("voice") == "some-profile-id"


def test_speed_passthrough(client, monkeypatch):
    fake = _make_fake_engine("fake-agent-speed")
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-agent-speed", fake)
    res = client.post("/v1/audio/speech", json={
        "model": "fake-agent-speed", "input": "Faster.", "speed": 1.25,
    })
    assert res.status_code == 200, res.text
    assert fake.calls[0][1].get("speed") == pytest.approx(1.25)


def test_num_step_and_guidance_scale_passthrough(client, monkeypatch):
    """#1014: these were silently DISCARDED (200 OK, fields dropped) — a T4
    hardware report caught it by comparing against the native /generate.
    They must now reach the engine's generate() kwargs."""
    fake = _make_fake_engine("fake-agent-quality")
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-agent-quality", fake)
    res = client.post("/v1/audio/speech", json={
        "model": "fake-agent-quality", "input": "Quality preset.",
        "num_step": 32, "guidance_scale": 3.0,
    })
    assert res.status_code == 200, res.text
    kw = fake.calls[0][1]
    assert kw.get("num_step") == 32
    assert kw.get("guidance_scale") == pytest.approx(3.0)


def test_num_step_and_guidance_scale_omitted_stay_absent(client, monkeypatch):
    """Engines that don't accept these kwargs must not suddenly receive
    None values — omitted means absent, exactly like duration/seed."""
    fake = _make_fake_engine("fake-agent-defaults")
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-agent-defaults", fake)
    res = client.post("/v1/audio/speech", json={
        "model": "fake-agent-defaults", "input": "Defaults.",
    })
    assert res.status_code == 200, res.text
    kw = fake.calls[0][1]
    assert "num_step" not in kw
    assert "guidance_scale" not in kw
