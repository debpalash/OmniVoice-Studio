"""WhisperX CUDA-OOM → CPU fallback (api/services parity for small GPUs).

On an 8 GB laptop GPU with the TTS model resident, whisperx's CTranslate2
load of large-v3 dies with `RuntimeError: CUDA failed with error out of
memory`, which previously surfaced as a bare 500 from /dub/transcribe. The
backend now retries on CPU (slower, same model/accuracy). This test forces the
OOM deterministically (no GPU needed) and asserts the device switch.
"""
from __future__ import annotations

import os
import sys
import tempfile
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

_config = types.ModuleType("core.config")
_config.DATA_DIR = tempfile.mkdtemp(prefix="omnivoice_asr_oom_")
_config.VOICES_DIR = _config.DATA_DIR
_config.OUTPUTS_DIR = _config.DATA_DIR
sys.modules["core.config"] = _config

whisperx = pytest.importorskip("whisperx")

from services.asr_backend import WhisperXBackend  # noqa: E402


def test_cuda_oom_falls_back_to_cpu(monkeypatch):
    calls = []

    def fake_load_model(name, device, compute_type, **kw):
        calls.append((device, compute_type))
        if device == "cuda":
            raise RuntimeError("CUDA failed with error out of memory")
        return object()  # CPU load succeeds

    monkeypatch.setattr(whisperx, "load_model", fake_load_model)

    be = WhisperXBackend()
    # Force the CUDA starting point regardless of the CI host's hardware.
    be._device, be._compute_type = "cuda", "float16"
    be._allow_vad_pickle_globals = lambda: None  # skip torch pickle allowlist

    be._ensure_asr()

    assert be._asr is not None                      # didn't raise — recovered
    assert be._device == "cpu" and be._compute_type == "int8"
    assert [d for d, _ in calls] == ["cuda", "cpu"]  # tried CUDA, then CPU


def test_non_oom_runtime_error_still_raises(monkeypatch):
    def fake_load_model(name, device, compute_type, **kw):
        raise RuntimeError("some other failure")  # not an OOM → must propagate

    monkeypatch.setattr(whisperx, "load_model", fake_load_model)

    be = WhisperXBackend()
    be._device, be._compute_type = "cuda", "float16"
    be._allow_vad_pickle_globals = lambda: None
    with pytest.raises(RuntimeError, match="some other failure"):
        be._ensure_asr()
