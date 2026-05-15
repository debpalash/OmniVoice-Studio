from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest


@pytest.fixture
def model_manager(monkeypatch):
    for mod_name in ("core.config", "services.model_manager"):
        if getattr(sys.modules.get(mod_name), "__file__", None) is None:
            sys.modules.pop(mod_name, None)

    import services.model_manager as mm

    monkeypatch.setattr(mm, "_torch", None)
    monkeypatch.setattr(mm, "_OmniVoice", None)
    monkeypatch.setattr(mm, "model", None)
    monkeypatch.setenv("OMNIVOICE_MODEL", "test/checkpoint")
    return mm


def test_tts_asr_preload_is_opt_in(model_manager, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_PRELOAD_TTS_ASR", raising=False)
    assert model_manager.should_preload_tts_asr() is False

    for value in ("1", "true", "TRUE", "yes", "on"):
        monkeypatch.setenv("OMNIVOICE_PRELOAD_TTS_ASR", value)
        assert model_manager.should_preload_tts_asr() is True

    monkeypatch.setenv("OMNIVOICE_PRELOAD_TTS_ASR", "0")
    assert model_manager.should_preload_tts_asr() is False


def test_load_model_skips_pytorch_whisper_by_default(model_manager, monkeypatch):
    calls = []

    class DummyOmniVoice:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(llm=object())

    monkeypatch.delenv("OMNIVOICE_PRELOAD_TTS_ASR", raising=False)
    monkeypatch.setattr(model_manager, "_lazy_torch", lambda: SimpleNamespace(float16="float16"))
    monkeypatch.setattr(model_manager, "_lazy_omnivoice", lambda: DummyOmniVoice)
    monkeypatch.setattr(model_manager, "get_best_device", lambda: "mps")

    loaded = model_manager._load_model_sync()

    assert loaded.llm is not None
    assert calls == [
        (
            ("test/checkpoint",),
            {"device_map": "mps", "dtype": "float16", "load_asr": False},
        )
    ]


def test_load_model_can_preload_pytorch_whisper_when_requested(model_manager, monkeypatch):
    calls = []

    class DummyOmniVoice:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(llm=object())

    monkeypatch.setenv("OMNIVOICE_PRELOAD_TTS_ASR", "1")
    monkeypatch.setattr(model_manager, "_lazy_torch", lambda: SimpleNamespace(float16="float16"))
    monkeypatch.setattr(model_manager, "_lazy_omnivoice", lambda: DummyOmniVoice)
    monkeypatch.setattr(model_manager, "get_best_device", lambda: "mps")

    model_manager._load_model_sync()

    assert calls[0][1]["load_asr"] is True
