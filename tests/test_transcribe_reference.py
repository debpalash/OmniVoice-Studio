"""Voice-clone reference transcription goes through the ASR registry (#308)
and caches transcripts by audio content (#1032).

A transcript-less reference used to fall through to OmniVoice's built-in
transformers pipeline (`load_asr_model`), which cannot load
whisper-large-v3-turbo on transformers 5.3 — even when whisperx /
faster-whisper / mlx-whisper were installed and working. `transcribe_reference`
must use the active registry backend, and degrade to None (the model fallback)
rather than raise.

#1032: the registry hands back a FRESH backend instance per call, so every
transcribe was a full whisper model load — on EVERY /generate whose reference
had no stored transcript. Same clip → same transcript, so results are cached
by content hash; a repeat call must not touch the ASR backend at all.
"""
import pytest

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


@pytest.fixture(autouse=True)
def _clean_transcript_cache():
    """Each test starts (and leaves) with an empty content-hash cache."""
    ab._ref_transcript_cache.clear()
    yield
    ab._ref_transcript_cache.clear()


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


# ── #1032: content-keyed transcript cache ────────────────────────────────────


class _CountingFactory:
    """Stands in for get_active_asr_backend; counts backend constructions —
    the expensive per-call model load the cache must eliminate."""

    def __init__(self, result=None, exc=None):
        self.calls = 0
        self._result = result
        self._exc = exc

    def __call__(self, **kw):
        self.calls += 1
        return _FakeBackend(result=self._result, exc=self._exc)


def test_same_content_transcribed_once(monkeypatch, tmp_path):
    """Two calls on the same bytes → ONE backend construction/transcribe.
    Before #1032 every call rebuilt (and thus reloaded) the ASR backend."""
    factory = _CountingFactory(result={"text": "hello there"})
    monkeypatch.setattr(ab, "get_active_asr_backend", factory)
    clip = tmp_path / "ref.wav"
    clip.write_bytes(b"RIFF-fake-audio-bytes")

    assert ab.transcribe_reference(str(clip)) == "hello there"
    assert ab.transcribe_reference(str(clip)) == "hello there"
    assert factory.calls == 1


def test_same_content_different_path_hits_cache(monkeypatch, tmp_path):
    """Ad-hoc clone uploads land in a NEW temp file per request — the cache
    must key on content, not path."""
    factory = _CountingFactory(result={"text": "same clip"})
    monkeypatch.setattr(ab, "get_active_asr_backend", factory)
    a = tmp_path / "upload-1.wav"
    b = tmp_path / "upload-2.wav"
    a.write_bytes(b"identical-bytes")
    b.write_bytes(b"identical-bytes")

    assert ab.transcribe_reference(str(a)) == "same clip"
    assert ab.transcribe_reference(str(b)) == "same clip"
    assert factory.calls == 1


def test_different_content_not_conflated(monkeypatch, tmp_path):
    factory = _CountingFactory(result={"text": "some words"})
    monkeypatch.setattr(ab, "get_active_asr_backend", factory)
    a = tmp_path / "a.wav"
    b = tmp_path / "b.wav"
    a.write_bytes(b"clip-A")
    b.write_bytes(b"clip-B")

    ab.transcribe_reference(str(a))
    ab.transcribe_reference(str(b))
    assert factory.calls == 2


def test_failure_not_cached(monkeypatch, tmp_path):
    """A transient ASR failure must retry on the next request, not stick."""
    clip = tmp_path / "ref.wav"
    clip.write_bytes(b"bytes")
    failing = _CountingFactory(exc=RuntimeError("model load failed"))
    monkeypatch.setattr(ab, "get_active_asr_backend", failing)
    assert ab.transcribe_reference(str(clip)) is None
    assert failing.calls == 1

    working = _CountingFactory(result={"text": "recovered"})
    monkeypatch.setattr(ab, "get_active_asr_backend", working)
    assert ab.transcribe_reference(str(clip)) == "recovered"
    assert working.calls == 1


def test_unreadable_path_still_transcribes_uncached(monkeypatch):
    """No fingerprint (unreadable file) → transcribe every time, cache nothing.
    Keeps the pre-#1032 behavior for anything the hash can't see."""
    factory = _CountingFactory(result={"text": "words"})
    monkeypatch.setattr(ab, "get_active_asr_backend", factory)
    assert ab.transcribe_reference("does-not-exist.wav") == "words"
    assert ab.transcribe_reference("does-not-exist.wav") == "words"
    assert factory.calls == 2
    assert len(ab._ref_transcript_cache) == 0


def test_cache_is_bounded(monkeypatch, tmp_path):
    factory = _CountingFactory(result={"text": "words"})
    monkeypatch.setattr(ab, "get_active_asr_backend", factory)
    for i in range(ab._REF_TRANSCRIPT_CACHE_MAX + 5):
        clip = tmp_path / f"clip-{i}.wav"
        clip.write_bytes(f"clip-{i}".encode())
        ab.transcribe_reference(str(clip))
    assert len(ab._ref_transcript_cache) == ab._REF_TRANSCRIPT_CACHE_MAX
