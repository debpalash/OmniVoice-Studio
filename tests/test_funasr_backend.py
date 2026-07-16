"""FunASR ASR backend — opt-in alternative to WhisperX (#182).

Tests the pure output-normaliser (no funasr install needed) + registration.
"""
import sys
import types

from services.asr_backend import _normalize_funasr, FunASRBackend, list_backends


def test_normalize_sentence_info_with_timestamps_and_speaker():
    res = [{
        "language": "en",
        "sentence_info": [
            {"text": "<|en|><|NEUTRAL|>Hello there", "start": 0, "end": 1200, "spk": 0},
            {"text": "Goodbye", "start": 1500, "end": 2300, "spk": 1},
        ],
    }]
    out = _normalize_funasr(res)
    assert out["language"] == "en"
    assert out["chunks"][0] == {"text": "Hello there", "timestamp": (0.0, 1.2)}   # ms → s, tokens stripped
    assert out["chunks"][1]["timestamp"] == (1.5, 2.3)
    assert out["segments"][0]["speaker"] == "Speaker 1"   # spk 0 → 1-based label
    assert out["segments"][1]["speaker"] == "Speaker 2"


def test_normalize_funasr_131_vad_sentence_field():
    """FunASR 1.3.1's vad_segment mode calls the text field ``sentence``."""
    res = [{
        "sentence_info": [{
            "sentence": "<|en|><|NEUTRAL|><|Speech|><|withitn|>Hello there",
            "start": 810,
            "end": 2160,
            "spk": 0,
        }],
    }]
    out = _normalize_funasr(res)
    assert out["chunks"] == [{"text": "Hello there", "timestamp": (0.81, 2.16)}]
    assert out["segments"][0]["speaker"] == "Speaker 1"


def test_normalize_single_utterance_fallback():
    res = [{"text": "<|en|><|HAPPY|>Hello world", "timestamp": [[0, 500], [500, 1000]]}]
    out = _normalize_funasr(res)
    assert out["chunks"] == [{"text": "Hello world", "timestamp": (0.0, 1.0)}]


def test_normalize_empty_and_tokens_only():
    assert _normalize_funasr([]) == {"chunks": [], "segments": [], "language": None}
    assert _normalize_funasr([{"text": "<|en|>"}])["chunks"] == []  # only rich tokens → nothing spoken


def test_is_available_reports_install_hint_when_absent():
    ok, msg = FunASRBackend.is_available()
    if not ok:  # funasr is not a hard dependency; absent in CI
        assert "funasr" in msg.lower()


def test_speaker_model_uses_vad_segment_mode(monkeypatch):
    captured = {}

    class FakeAutoModel:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    fake_funasr = types.ModuleType("funasr")
    fake_funasr.AutoModel = FakeAutoModel
    monkeypatch.setitem(sys.modules, "funasr", fake_funasr)

    backend = FunASRBackend()
    backend._spk_model = "cam++"
    backend._ensure_model()

    assert captured["spk_mode"] == "vad_segment"


def test_speaker_transcribe_requests_sensevoice_timestamps():
    captured = {}

    class FakeModel:
        def generate(self, **kwargs):
            captured.update(kwargs)
            return []

    backend = FunASRBackend()
    backend._spk_model = "cam++"
    backend._model = FakeModel()
    backend.transcribe("sample.wav")

    assert captured["output_timestamp"] is True


def test_registered_in_picker():
    ids = [b["id"] for b in list_backends()]
    assert "funasr" in ids
