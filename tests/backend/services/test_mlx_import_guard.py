"""MLX import-guard hardening (Wave 4.4).

A PyInstaller-bundled mlx whose native dylib/metallib fails to load raises
OSError/RuntimeError on import — not ImportError. is_available() must report
unavailable instead of letting that propagate and crash the registry scan.
"""
import builtins

import pytest


def _block_import(monkeypatch, name, exc):
    real = builtins.__import__

    def fake(n, *a, **k):
        if n == name:
            raise exc
        return real(n, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake)


@pytest.mark.parametrize("exc", [OSError("dlopen metallib failed"),
                                 RuntimeError("metal device init failed"),
                                 ImportError("No module named mlx_whisper")])
def test_mlx_whisper_unavailable_not_crash(monkeypatch, exc):
    import torch
    if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
        # is_available short-circuits on non-MPS before importing mlx; force
        # the MPS branch so the import guard is what we're exercising.
        monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True, raising=False)
    from services.asr_backend import MLXWhisperBackend
    _block_import(monkeypatch, "mlx_whisper", exc)
    ok, msg = MLXWhisperBackend.is_available()
    assert ok is False
    assert "mlx-whisper" in msg


@pytest.mark.parametrize("exc", [OSError("dlopen failed"),
                                 RuntimeError("metal init failed"),
                                 ImportError("no mlx_audio")])
def test_mlx_audio_unavailable_not_crash(monkeypatch, exc):
    from services.tts_backend import MLXAudioBackend
    _block_import(monkeypatch, "mlx_audio", exc)
    ok, msg = MLXAudioBackend.is_available()
    assert ok is False
    assert "mlx-audio" in msg
