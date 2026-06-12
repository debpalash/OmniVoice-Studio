"""Contract test for the surface pyvideotrans's OmniVoice integration consumes.

Wave 1.3 (parity program / Spec 11): pyvideotrans drives us as a per-line
clone backend — for each subtitle line it POSTs /generate with the line's
text + an UPLOADED reference wav + transcript and expects WAV bytes back.
This test pins that exact multipart surface so a change to /generate that
would silently break the 17.9k-star upstream integration fails our CI
instead (engine-compat constraint extended to an external consumer).

Pinned shape (mirrors videotrans/tts/_omnivoice.py in the upstream PR):
  POST /generate  (multipart/form-data)
    text=<line text>            language=<natural-language name or Auto>
    ref_audio=<wav file>        ref_text=<reference transcript>
    num_step=32                 guidance_scale=2.0
    speed=<float>               denoise=false
    postprocess_output=true
  -> 200, content-type audio/wav, body = playable WAV bytes.

Engine is stubbed (pattern from tests/test_generate_engine.py) — the
contract is parameter acceptance + response shape, not audio quality.
NOTE: requires importing `main`; on the maintainer's dev box this suite
only runs in CI (local torch/Triton segfault, see project memory).
"""
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import importlib

import pytest
import torch


def _tts_mod():
    return importlib.import_module("services.tts_backend")


def _make_fake_engine(engine_id="fake-bridge-engine"):
    class _FakeEngine(_tts_mod().TTSBackend):
        id = engine_id
        display_name = "Fake Bridge Engine (test)"
        calls: list = []

        @property
        def sample_rate(self) -> int:
            return 24000

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


_FAKE_WAV = b"RIFF" + b"\x00" * 4000  # stand-in for a per-line reference clip


def _bridge_request(client, **overrides):
    """The exact request shape the upstream integration sends."""
    data = {
        "text": "Hola, esta es la linea doblada.",
        "language": "Spanish",
        "ref_text": "This is the original line.",
        "num_step": "32",
        "guidance_scale": "2.0",
        "speed": "1.0",
        "denoise": "false",
        "postprocess_output": "true",
    }
    data.update(overrides)
    return client.post(
        "/generate",
        data=data,
        files={"ref_audio": ("line_001.wav", _FAKE_WAV, "audio/wav")},
    )


def test_bridge_shape_returns_wav(client, monkeypatch):
    fake = _make_fake_engine()
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-bridge-engine", fake)
    monkeypatch.setenv("OMNIVOICE_TTS_BACKEND", "fake-bridge-engine")

    res = _bridge_request(client)

    assert res.status_code == 200, res.text
    assert res.headers.get("content-type") == "audio/wav"
    assert res.content[:4] == b"RIFF"  # playable WAV container
    assert res.headers.get("x-audio-duration")  # consumed for slot fitting

    assert len(fake.calls) == 1
    text, kw = fake.calls[0]
    assert text == "Hola, esta es la linea doblada."
    # The uploaded per-line reference must reach the engine as a file path
    # (the temp file is cleaned up after the request, so only the presence
    # of the path is assertable here), with its transcript alongside —
    # this IS the clone contract.
    assert kw.get("ref_audio")
    assert kw.get("ref_text") == "This is the original line."
    assert kw.get("language") == "Spanish"
    assert kw.get("num_step") == 32
    assert kw.get("guidance_scale") == pytest.approx(2.0)
    assert kw.get("denoise") is False
    assert kw.get("postprocess_output") is True


def test_bridge_auto_language_passes_none(client, monkeypatch):
    fake = _make_fake_engine("fake-bridge-auto")
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-bridge-auto", fake)
    monkeypatch.setenv("OMNIVOICE_TTS_BACKEND", "fake-bridge-auto")

    res = _bridge_request(client, language="Auto")
    assert res.status_code == 200, res.text
    _, kw = fake.calls[0]
    # "Auto" is a UI sentinel — engines receive None (established behavior
    # the upstream integration relies on for its default).
    assert kw.get("language") is None


def test_bridge_long_line_still_single_wav(client, monkeypatch):
    """Subtitle lines can exceed the chunking threshold — the bridge must
    still receive ONE WAV response (chunking is server-internal)."""
    fake = _make_fake_engine("fake-bridge-long")
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-bridge-long", fake)
    monkeypatch.setenv("OMNIVOICE_TTS_BACKEND", "fake-bridge-long")

    long_line = ("A very long dubbed line that keeps going. " * 30).strip()
    res = _bridge_request(client, text=long_line)
    assert res.status_code == 200, res.text
    assert res.headers.get("content-type") == "audio/wav"
    assert res.content[:4] == b"RIFF"
