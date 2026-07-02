"""
Tests for the sherpa-onnx live-dictation backend (services/sherpa_dictation.py
+ services/asr_backend.SherpaDictationBackend).

sherpa_onnx is mocked end-to-end so these run in CI without downloading any
model: we assert the dispatch/wiring (right recognizer factory per kind, right
CPU provider) and the output-shape normalisation to OmniVoice's
{chunks, segments, language, text} contract.

Also pins the verified ONNX asset filenames so a silent registry typo (the
streaming zipformer repos use plain `encoder-epoch-99-avg-1.int8.onnx`, NOT a
`-chunk-16-left-64` variant) fails loudly.
"""
import os
import sys
import types

import numpy as np
import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


# ── A fake sherpa_onnx module ────────────────────────────────────────────────


class _FakeStream:
    def __init__(self, owner):
        self._owner = owner
        self._fed = 0
        self._finished = False

    def accept_waveform(self, sr, samples):
        self._fed += len(samples)

    def input_finished(self):
        self._finished = True

    @property
    def result(self):
        # OfflineStream.result.text
        return types.SimpleNamespace(text="hello world", tokens=[], timestamps=[])


class _FakeOfflineRecognizer:
    last_kwargs = None
    factory = None

    def __init__(self, kwargs, factory):
        type(self).last_kwargs = kwargs
        type(self).factory = factory

    @classmethod
    def from_transducer(cls, **kw):
        return cls(kw, "from_transducer")

    @classmethod
    def from_whisper(cls, **kw):
        return cls(kw, "from_whisper")

    def create_stream(self):
        return _FakeStream(self)

    def decode_stream(self, s):
        pass


class _FakeOnlineRecognizer:
    last_kwargs = None
    factory = None

    def __init__(self, kwargs, factory):
        type(self).last_kwargs = kwargs
        type(self).factory = factory
        self._decodes = 0

    @classmethod
    def from_transducer(cls, **kw):
        return cls(kw, "from_transducer")

    @classmethod
    def from_paraformer(cls, **kw):
        return cls(kw, "from_paraformer")

    def create_stream(self):
        return _FakeStream(self)

    def is_ready(self, s):
        # Become "not ready" after one decode pass so loops terminate.
        self._decodes += 1
        return self._decodes <= 1

    def decode_stream(self, s):
        pass

    def get_result(self, s):
        return "hello world"

    def is_endpoint(self, s):
        return False

    def reset(self, s):
        self._decodes = 0


@pytest.fixture
def fake_sherpa(monkeypatch):
    mod = types.ModuleType("sherpa_onnx")
    mod.OfflineRecognizer = _FakeOfflineRecognizer
    mod.OnlineRecognizer = _FakeOnlineRecognizer
    monkeypatch.setitem(sys.modules, "sherpa_onnx", mod)
    # Reset captured state between tests.
    _FakeOfflineRecognizer.last_kwargs = None
    _FakeOnlineRecognizer.last_kwargs = None
    return mod


@pytest.fixture
def no_download(monkeypatch):
    """Make _resolve_model_dir return a fake dir without touching HF."""
    from services import sherpa_dictation as sd
    monkeypatch.setattr(sd, "_resolve_model_dir", lambda spec, download=True: "/fake/model/dir")
    return sd


# ── Registry / filename pinning ──────────────────────────────────────────────


def test_seven_models_registered():
    from services import sherpa_dictation as sd
    specs = sd.list_specs()
    assert len(specs) == 7
    ids = {s.id for s in specs}
    assert ids == {
        "sherpa-parakeet-tdt-v3", "sherpa-parakeet-tdt-v2",
        "sherpa-zipformer-bilingual-zh-en", "sherpa-paraformer-bilingual-zh-en",
        "sherpa-zipformer-en-20m", "sherpa-zipformer-zh-14m", "sherpa-whisper-tiny",
    }
    # Exactly one recommended default.
    rec = [s for s in specs if s.recommended]
    assert [s.id for s in rec] == ["sherpa-parakeet-tdt-v3"]
    assert sd.DEFAULT_MODEL_ID == "sherpa-parakeet-tdt-v3"


def test_verified_filenames_pinned():
    from services import sherpa_dictation as sd
    g = sd.get_spec
    # Offline transducers — int8 triplet.
    assert g("sherpa-parakeet-tdt-v3").files == {
        "encoder": "encoder.int8.onnx", "decoder": "decoder.int8.onnx",
        "joiner": "joiner.int8.onnx", "tokens": "tokens.txt"}
    # Streaming zipformer — VERIFIED epoch naming (NOT -chunk-16-left-64).
    assert g("sherpa-zipformer-bilingual-zh-en").files["encoder"] == \
        "encoder-epoch-99-avg-1.int8.onnx"
    assert g("sherpa-zipformer-en-20m").files["joiner"] == \
        "joiner-epoch-99-avg-1.int8.onnx"
    assert g("sherpa-zipformer-zh-14m").files["decoder"] == \
        "decoder-epoch-99-avg-1.int8.onnx"
    # Streaming paraformer — NO joiner.
    assert "joiner" not in g("sherpa-paraformer-bilingual-zh-en").files
    # Whisper tiny — tiny-prefixed assets.
    assert g("sherpa-whisper-tiny").files == {
        "encoder": "tiny-encoder.int8.onnx", "decoder": "tiny-decoder.int8.onnx",
        "tokens": "tiny-tokens.txt"}


def test_get_spec_accepts_repo_id():
    from services import sherpa_dictation as sd
    spec = sd.get_spec("csukuangfj/sherpa-onnx-whisper-tiny")
    assert spec is not None and spec.id == "sherpa-whisper-tiny"
    assert sd.is_sherpa_model("sherpa-whisper-tiny")
    assert not sd.is_sherpa_model("Systran/faster-whisper-large-v3")
    assert not sd.is_sherpa_model(None)


# ── The 4 recognizer kinds construct + transcribe ───────────────────────────


@pytest.mark.parametrize("model_id,kind,factory,is_online", [
    ("sherpa-parakeet-tdt-v3", "offline-transducer", "from_transducer", False),
    ("sherpa-whisper-tiny", "offline-whisper", "from_whisper", False),
    ("sherpa-zipformer-en-20m", "online-transducer", "from_transducer", True),
    ("sherpa-paraformer-bilingual-zh-en", "online-paraformer", "from_paraformer", True),
])
def test_recognizer_kind_constructs_and_transcribes(
    fake_sherpa, no_download, monkeypatch, tmp_path, model_id, kind, factory, is_online,
):
    from services import asr_backend as ab
    from services import sherpa_dictation as sd

    # Feed a fixed waveform so transcribe() doesn't read a real file.
    monkeypatch.setattr(
        ab, "_load_audio_16k_mono_f32",
        lambda path: (np.zeros(16000, dtype=np.float32), 16000),
    )

    spec = sd.get_spec(model_id)
    assert spec.kind == kind

    backend = ab.SherpaDictationBackend(model_id=model_id)
    out = backend.transcribe(str(tmp_path / "x.wav"))

    # Right factory on the right recognizer class + CPU provider.
    cls = fake_sherpa.OnlineRecognizer if is_online else fake_sherpa.OfflineRecognizer
    assert cls.factory == factory
    assert cls.last_kwargs["provider"] == "cpu"
    assert cls.last_kwargs["num_threads"] == 2
    if kind == "offline-transducer":
        assert cls.last_kwargs["model_type"] == "nemo_transducer"
    if kind == "offline-whisper":
        assert cls.last_kwargs["language"] == ""
        assert cls.last_kwargs["task"] == "transcribe"

    # Output-shape normalisation.
    assert out["text"] == "hello world"
    assert out["chunks"][0]["text"] == "hello world"
    assert out["chunks"][0]["timestamp"][0] == 0.0
    assert out["segments"][0]["text"] == "hello world"
    assert "language" in out


def test_backend_streaming_flag(fake_sherpa, no_download):
    from services import asr_backend as ab
    assert ab.SherpaDictationBackend(model_id="sherpa-zipformer-en-20m").streaming
    assert not ab.SherpaDictationBackend(model_id="sherpa-parakeet-tdt-v3").streaming


def test_unknown_model_id_raises(fake_sherpa):
    from services import asr_backend as ab
    with pytest.raises(ValueError):
        ab.SherpaDictationBackend(model_id="nope")


def test_registered_in_asr_registry():
    from services import asr_backend as ab
    assert "sherpa-onnx-asr" in ab._REGISTRY
    assert ab._REGISTRY["sherpa-onnx-asr"] is ab.SherpaDictationBackend
    assert "sherpa-onnx-asr" in ab._INSTALL_HINTS


# ── get_capture_asr_backend() honors dictation.model_id ─────────────────────


def test_capture_backend_honors_dictation_model_id(fake_sherpa, no_download, monkeypatch):
    from services import asr_backend as ab

    # Reset the cached singleton + force sherpa "available".
    ab._capture_backend = None
    ab._capture_backend_key = None
    monkeypatch.setattr(ab.SherpaDictationBackend, "is_available",
                        classmethod(lambda cls: (True, "ready")))

    prefs_store = {"dictation.enabled": True, "dictation.model_id": "sherpa-whisper-tiny"}
    from core import prefs as _prefs
    monkeypatch.setattr(_prefs, "get", lambda k, d=None: prefs_store.get(k, d))
    monkeypatch.delenv("OMNIVOICE_SHERPA_ASR_MODEL", raising=False)

    b = ab.get_capture_asr_backend()
    assert isinstance(b, ab.SherpaDictationBackend)
    assert b.spec.id == "sherpa-whisper-tiny"

    # Switching the pref rebuilds the singleton for the new model.
    prefs_store["dictation.model_id"] = "sherpa-parakeet-tdt-v3"
    ab._capture_backend = None
    ab._capture_backend_key = None
    b2 = ab.get_capture_asr_backend()
    assert b2.spec.id == "sherpa-parakeet-tdt-v3"


# ── #888: warmup builds the recognizer; WS sessions reuse it ────────────────


def test_sherpa_warmup_builds_recognizer(fake_sherpa, no_download):
    """warmup() eagerly builds the recognizer so the first live session doesn't
    pay the ONNX-session load. Before the fix SherpaDictationBackend had no
    warmup(), so the #888 preload's `if hasattr(backend, 'warmup')` was a no-op
    and the recognizer stayed cold until the first dictation."""
    from services import asr_backend as ab

    b = ab.SherpaDictationBackend(model_id="sherpa-whisper-tiny")
    assert hasattr(b, "warmup")
    assert b._rec is None
    b.warmup()
    assert b._rec is not None  # recognizer built eagerly
    # Idempotent — a second warmup keeps the SAME recognizer (no rebuild).
    rec = b._rec
    b.warmup()
    assert b._rec is rec


def test_get_sherpa_dictation_backend_reuses_warm_singleton(fake_sherpa, no_download, monkeypatch):
    """A second WS session for the same model reuses the warm backend instead
    of rebuilding the recognizer (1.3–2.5s) per connect — the reuse that makes
    the #888 preload actually pay off. A model switch rebuilds (same
    invalidation as the get_capture_asr_backend singleton)."""
    from services import asr_backend as ab

    ab._capture_backend = None
    ab._capture_backend_key = None
    monkeypatch.setattr(ab.SherpaDictationBackend, "is_available",
                        classmethod(lambda cls: (True, "ready")))

    b1 = ab.get_sherpa_dictation_backend("sherpa-whisper-tiny")
    b1.warmup()
    rec = b1._rec

    b2 = ab.get_sherpa_dictation_backend("sherpa-whisper-tiny")
    assert b2 is b1, "same-model session rebuilt the backend instead of reusing"
    assert b2._rec is rec, "recognizer was rebuilt on reuse"

    # Switching the model rebuilds and rebinds the shared singleton.
    b3 = ab.get_sherpa_dictation_backend("sherpa-parakeet-tdt-v3")
    assert b3 is not b1
    assert b3.spec.id == "sherpa-parakeet-tdt-v3"

    ab._capture_backend = None
    ab._capture_backend_key = None


def test_capture_backend_falls_back_when_dictation_disabled(monkeypatch):
    from services import asr_backend as ab
    ab._capture_backend = None
    ab._capture_backend_key = None

    prefs_store = {"dictation.enabled": False, "dictation.model_id": "sherpa-whisper-tiny"}
    from core import prefs as _prefs
    monkeypatch.setattr(_prefs, "get", lambda k, d=None: prefs_store.get(k, d))
    monkeypatch.delenv("OMNIVOICE_SHERPA_ASR_MODEL", raising=False)

    # dictation_model_id() returns None → not a sherpa backend.
    assert ab.dictation_model_id() is None
    b = ab.get_capture_asr_backend()
    assert not isinstance(b, ab.SherpaDictationBackend)
    # cleanup singleton so other tests start clean
    ab._capture_backend = None
    ab._capture_backend_key = None
