"""Voice-clone reference transcription goes through the ASR registry (#308).

A transcript-less reference used to fall through to OmniVoice's built-in
transformers pipeline (`load_asr_model`), which cannot load
whisper-large-v3-turbo on transformers 5.3 — even when whisperx /
faster-whisper / mlx-whisper were installed and working. `transcribe_reference`
must use the active registry backend, and degrade to None (the model fallback)
rather than raise.
"""
from services import asr_backend as ab


class _FakeBackend(ab.ASRBackend):
    id = "fake"
    display_name = "Fake"

    def __init__(self, result=None, exc=None):
        self._result = result
        self._exc = exc

    @classmethod
    def is_available(cls):
        return True, "ready"

    def transcribe(self, audio_path, *, word_timestamps=True):
        if self._exc:
            raise self._exc
        return self._result


def test_uses_active_backend_text(monkeypatch):
    monkeypatch.setattr(
        ab, "get_active_asr_backend",
        lambda **kw: _FakeBackend(result={"text": " hello there "}),
    )
    assert ab.transcribe_reference("ref.wav") == "hello there"


def test_joins_segments_when_no_top_level_text(monkeypatch):
    """WhisperX results carry no top-level "text" — only segments."""
    monkeypatch.setattr(
        ab, "get_active_asr_backend",
        lambda **kw: _FakeBackend(result={
            "segments": [{"text": " hello"}, {"text": "world "}],
        }),
    )
    assert ab.transcribe_reference("ref.wav") == "hello world"


def test_backend_failure_degrades_to_none(monkeypatch):
    monkeypatch.setattr(
        ab, "get_active_asr_backend",
        lambda **kw: _FakeBackend(exc=RuntimeError("model load failed")),
    )
    assert ab.transcribe_reference("ref.wav") is None


def test_registry_resolution_failure_degrades_to_none(monkeypatch):
    def _boom(**kw):
        raise ValueError("unknown backend")
    monkeypatch.setattr(ab, "get_active_asr_backend", _boom)
    assert ab.transcribe_reference("ref.wav") is None


def test_pytorch_whisper_defers_to_model_fallback(monkeypatch):
    """When the registry itself resolves to pytorch-whisper, defer to the
    model's lazy load instead of constructing a second pipeline."""
    be = ab.PyTorchWhisperBackend(asr_pipe=object())
    monkeypatch.setattr(ab, "get_active_asr_backend", lambda **kw: be)
    assert ab.transcribe_reference("ref.wav") is None


def test_empty_result_degrades_to_none(monkeypatch):
    monkeypatch.setattr(
        ab, "get_active_asr_backend",
        lambda **kw: _FakeBackend(result={"text": "   "}),
    )
    assert ab.transcribe_reference("ref.wav") is None
