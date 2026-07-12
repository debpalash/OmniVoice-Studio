"""ASR auto-detect must respect the hardware it's running on (#1127).

The picker used to probe WhisperX first, unconditionally. WhisperX (and
faster-whisper) are CTranslate2, which has **no Metal backend** — so on Apple
Silicon they transcribe on the *CPU* while the GPU sits idle. Because WhisperX is
always installed, the MPS branch further down was unreachable in practice and
every Mac dub ran on the CPU.

Measured on an M2, one 30 s dub chunk of whisper-large-v3:

    WhisperX (CPU)              90.4 s   <- 3x SLOWER than realtime
    MLX (GPU)                   20.5 s
    MLX (GPU) + forced align    20.3 s   <- same word timings, ~4x faster

That is how a 16-minute video became a ~48-minute transcribe and looked like a
hang. These tests pin the pick, and — just as importantly — pin that we did not
buy the speed by throwing away lip-sync accuracy: the MLX path keeps WhisperX's
wav2vec2 forced alignment (±10-30 ms) rather than settling for Whisper's own
native word timestamps (±100-300 ms).
"""
from __future__ import annotations

import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest

from services import asr_backend as ab


@pytest.fixture(autouse=True)
def _clear_align_cache(monkeypatch):
    ab._ALIGN_CACHE.clear()
    monkeypatch.delenv(ab._ALIGN_DEVICE_ENV, raising=False)
    yield
    ab._ALIGN_CACHE.clear()


def _probe(available: set[str]):
    """Stub _probe_available: only the named backend ids report available."""
    return lambda cls: cls.id in available


# ── the pick ────────────────────────────────────────────────────────────────


def test_apple_silicon_picks_mlx_not_the_cpu_bound_whisperx(monkeypatch):
    """The regression. Before the fix this returned "whisperx" — i.e. the CPU."""
    monkeypatch.setattr(ab, "_mps_available", lambda: True)
    monkeypatch.setattr(ab, "_probe_available", _probe({"mlx-whisper", "whisperx", "faster-whisper"}))
    assert ab._auto_detect() == "mlx-whisper"


def test_cuda_and_linux_still_get_whisperx(monkeypatch):
    """No MPS => CTranslate2 can use the GPU (CUDA) or is simply the best
    available. WhisperX must remain the default everywhere else."""
    monkeypatch.setattr(ab, "_mps_available", lambda: False)
    monkeypatch.setattr(ab, "_probe_available", _probe({"whisperx", "faster-whisper"}))
    assert ab._auto_detect() == "whisperx"


def test_a_mac_without_mlx_installed_falls_back_to_whisperx(monkeypatch):
    """MLX is the preference, not a requirement — never strand a user."""
    monkeypatch.setattr(ab, "_mps_available", lambda: True)
    monkeypatch.setattr(ab, "_probe_available", _probe({"whisperx", "faster-whisper"}))
    assert ab._auto_detect() == "whisperx"


def test_fallback_chain_still_degrades_to_faster_whisper_then_pytorch(monkeypatch):
    monkeypatch.setattr(ab, "_mps_available", lambda: False)
    monkeypatch.setattr(ab, "_probe_available", _probe({"faster-whisper"}))
    assert ab._auto_detect() == "faster-whisper"
    monkeypatch.setattr(ab, "_probe_available", _probe(set()))
    assert ab._auto_detect() == "pytorch-whisper"


def test_an_explicitly_pinned_backend_still_wins(monkeypatch):
    """Anyone who pinned an engine keeps it — auto-detect must not override."""
    monkeypatch.setenv("OMNIVOICE_ASR_BACKEND", "faster-whisper")
    monkeypatch.setattr(ab, "_mps_available", lambda: True)
    monkeypatch.setattr(ab, "_probe_available", _probe({"mlx-whisper"}))
    assert ab.active_backend_id() == "faster-whisper"


# ── we did not buy speed with lip-sync accuracy ─────────────────────────────


def test_forced_align_is_engine_agnostic_so_mlx_keeps_whisperx_timing(monkeypatch):
    """The whole reason the swap is safe: alignment takes plain segments, so
    MLX's GPU transcript gets the *same* wav2vec2 boundaries WhisperX would give."""
    segments = [{"text": "hello world", "start": 0.0, "end": 1.0}]
    aligned = [{"text": "hello world", "start": 0.0, "end": 1.0,
                "words": [{"word": "hello", "start": 0.01, "end": 0.4}]}]

    monkeypatch.setattr(ab, "_mps_available", lambda: False)
    monkeypatch.setattr(ab, "load_align_model", lambda lang, dev: ("model", "meta"))
    fake = type("W", (), {"align": staticmethod(lambda *a, **k: {"segments": aligned})})
    monkeypatch.setitem(__import__("sys").modules, "whisperx", fake)

    assert ab.forced_align(segments, object(), "en") == aligned


def test_alignment_retries_on_cpu_before_giving_up_on_timing(monkeypatch):
    """An aligner that hits an unimplemented MPS op must NOT silently cost us the
    word timing — it must fall back to the CPU, which always works."""
    tried: list[str] = []
    aligned = [{"text": "hi", "start": 0.0, "end": 1.0, "words": [{"word": "hi", "start": 0.0}]}]

    def align(segs, model, meta, audio, device, **kw):
        tried.append(device)
        if device == "mps":
            raise NotImplementedError("aten::_ctc_loss not implemented for MPS")
        return {"segments": aligned}

    monkeypatch.setattr(ab, "_mps_available", lambda: True)
    monkeypatch.setattr(ab, "load_align_model", lambda lang, dev: ("model", "meta"))
    fake = type("W", (), {"align": staticmethod(align)})
    monkeypatch.setitem(__import__("sys").modules, "whisperx", fake)

    out = ab.forced_align([{"text": "hi", "start": 0.0, "end": 1.0}], object(), "en")
    assert tried == ["mps", "cpu"], "must retry on CPU, not abandon alignment"
    assert out == aligned  # timing preserved


def test_a_language_with_no_aligner_keeps_its_native_timestamps(monkeypatch):
    """~20 languages have wav2vec2 aligners. The other 626 must still transcribe."""
    segments = [{"text": "x", "start": 0.0, "end": 1.0, "words": [{"word": "x", "start": 0.0}]}]
    monkeypatch.setattr(ab, "load_align_model", lambda lang, dev: None)
    assert ab.forced_align(segments, object(), "yue") == segments


def test_alignment_failure_never_loses_the_transcript(monkeypatch):
    """Worse timing beats no transcript. Never raise out of alignment."""
    segments = [{"text": "x", "start": 0.0, "end": 1.0}]
    monkeypatch.setattr(ab, "_mps_available", lambda: False)
    monkeypatch.setattr(ab, "load_align_model", lambda lang, dev: ("m", "meta"))

    def boom(*a, **k):
        raise RuntimeError("aligner exploded")

    fake = type("W", (), {"align": staticmethod(boom)})
    monkeypatch.setitem(__import__("sys").modules, "whisperx", fake)

    assert ab.forced_align(segments, object(), "en") == segments


def test_empty_segments_short_circuit(monkeypatch):
    assert ab.forced_align([], object(), "en") == []
