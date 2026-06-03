"""PyTorch-Whisper backend must work as a standalone fallback (issue #255).

On machines where WhisperX / faster-whisper can't load cuDNN 8
(`cudnn_ops_infer64_8.dll` missing), the PyTorch-Whisper backend should build
its own transformers pipeline on demand — without OMNIVOICE_PRELOAD_TTS_ASR=1
and without loading the full TTS model.
"""
import sys
import types

import pytest

from services import asr_backend as ab


def test_is_available_when_transformers_present():
    ok, msg = ab.PyTorchWhisperBackend.is_available()
    assert ok is True
    assert msg == "ready"


def test_reuses_constructor_pipe_without_building(monkeypatch):
    sentinel = object()
    be = ab.PyTorchWhisperBackend(asr_pipe=sentinel)

    def _boom(*a, **k):
        raise AssertionError("must not build a pipeline when one was passed in")

    # transformers.pipeline is imported lazily inside _ensure_pipe.
    fake_tf = types.ModuleType("transformers")
    fake_tf.pipeline = _boom
    monkeypatch.setitem(sys.modules, "transformers", fake_tf)

    be._ensure_pipe()
    assert be._pipe is sentinel


def test_lazy_builds_standalone_pipeline(monkeypatch):
    """No preloaded pipe → build a standalone transformers ASR pipeline, with no
    call into the TTS model loader (get_model)."""
    captured = {}

    def fake_pipeline(task, **kw):
        captured["task"] = task
        captured["kw"] = kw
        return lambda *a, **k: {"chunks": []}

    fake_tf = types.ModuleType("transformers")
    fake_tf.pipeline = fake_pipeline
    monkeypatch.setitem(sys.modules, "transformers", fake_tf)
    monkeypatch.setattr("services.model_manager.get_best_device", lambda: "cpu")

    # Guard: building the standalone pipe must NOT pull in the full TTS model.
    import services.model_manager as mm

    def _no_get_model(*a, **k):
        raise AssertionError("standalone ASR build must not call get_model()")

    monkeypatch.setattr(mm, "get_model", _no_get_model, raising=False)

    be = ab.PyTorchWhisperBackend(asr_pipe=None)
    be._ensure_pipe()

    assert be._pipe is not None
    assert captured["task"] == "automatic-speech-recognition"
    assert captured["kw"]["model"]  # a concrete model name was chosen


def test_pytorch_asr_model_overridable_via_env(monkeypatch):
    captured = {}

    def fake_pipeline(task, **kw):
        captured["kw"] = kw
        return object()

    fake_tf = types.ModuleType("transformers")
    fake_tf.pipeline = fake_pipeline
    monkeypatch.setitem(sys.modules, "transformers", fake_tf)
    monkeypatch.setattr("services.model_manager.get_best_device", lambda: "cpu")
    monkeypatch.setenv("OMNIVOICE_PYTORCH_ASR_MODEL", "openai/whisper-small")

    ab.PyTorchWhisperBackend(asr_pipe=None)._ensure_pipe()
    assert captured["kw"]["model"] == "openai/whisper-small"
