"""Regression: MLXAudioBackend.generate() must forward ref_text.

CSM (sesame) only builds its voice-clone context when BOTH ref_audio and
ref_text are present. Before this fix, generate() read voice/ref_audio/
language/speed from kwargs but silently dropped ref_text, so cloning on the
CSM engine always crashed downstream with an unrelated-looking
`IndexError: list index out of range` (sesame.py builds an empty context and
then indexes context[0]) — even though generation.py's caller already has a
ref_text (either user-supplied or auto-transcribed at ~line 780).
"""
from __future__ import annotations

# tests/conftest.py prepends ./backend to sys.path so `services.*` resolves.
from services.tts_backend import MLXAudioBackend


class _FakeResult:
    def __init__(self, audio):
        self.audio = audio


class _FakeModel:
    """Stands in for the loaded mlx-audio model — records the kwargs
    generate() was called with instead of doing real inference."""

    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        yield _FakeResult([0.0, 0.0, 0.0])


def _backend_with_fake_model(monkeypatch) -> tuple[MLXAudioBackend, _FakeModel]:
    backend = MLXAudioBackend()
    fake_model = _FakeModel()
    monkeypatch.setattr(backend, "_ensure_loaded", lambda: setattr(backend, "_model", fake_model))
    return backend, fake_model


def test_ref_text_forwarded_when_ref_audio_present(monkeypatch):
    backend, fake_model = _backend_with_fake_model(monkeypatch)

    backend.generate("hello", ref_audio="/tmp/ref.wav", ref_text="reference transcript")

    assert fake_model.calls, "generate() was never called on the model"
    assert fake_model.calls[0].get("ref_text") == "reference transcript"
    assert fake_model.calls[0].get("ref_audio") == "/tmp/ref.wav"


def test_ref_text_omitted_without_ref_audio(monkeypatch):
    """ref_text alone (no ref_audio) shouldn't be forwarded — matches the
    existing ref_audio-gated pattern used by every other backend in this
    file (e.g. omnivoice_gguf, dots_tts)."""
    backend, fake_model = _backend_with_fake_model(monkeypatch)

    backend.generate("hello", ref_text="orphaned transcript, no ref_audio")

    assert "ref_text" not in fake_model.calls[0]


def test_no_ref_text_still_works(monkeypatch):
    """Design/instruct path (no ref_audio, no ref_text) is unaffected."""
    backend, fake_model = _backend_with_fake_model(monkeypatch)

    backend.generate("hello")

    assert "ref_text" not in fake_model.calls[0]
    assert "ref_audio" not in fake_model.calls[0]
