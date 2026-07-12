"""On unified memory, "offload" must mean UNLOAD — the 16 GB dub OOM (#1119).

`offload_tts_for_asr()` exists to make room before WhisperX large-v3 (~3 GB)
loads. On a dedicated GPU it moves the TTS model to CPU. On Apple Silicon it used
to do **nothing at all**, with the comment "MPS / CPU don't benefit from manual
offloading".

That reasoning is right about the *strategy* and wrong about the *conclusion*:
moving a model "to CPU" on unified memory frees nothing, because it is the same
physical RAM — but that means the fix is to RELEASE the model, not to skip the
step. Holding the ~3.8 GB TTS model resident while large-v3 loads on top is what
gets the backend OOM-killed mid-dub on a 16 GB Mac; the transcribe stream simply
dies (#1119, and the same machine profile as #1113).

Fail-before: on MPS the model stayed loaded and nothing was freed.
"""
from __future__ import annotations

import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest

import services.model_manager as mm


@pytest.fixture
def unified(monkeypatch):
    """A unified-memory host (Apple Silicon): no dedicated VRAM."""
    monkeypatch.setattr(mm, "_has_dedicated_vram", lambda: False)
    monkeypatch.setattr(mm, "model", object(), raising=False)
    freed = {"n": 0}
    monkeypatch.setattr(mm, "free_vram", lambda: freed.__setitem__("n", freed["n"] + 1))
    monkeypatch.setattr(mm, "_lazy_torch", lambda: object())
    return freed


def _ram(monkeypatch, gb):
    monkeypatch.setattr(
        "services.memory_budget.available_memory",
        lambda: {"ram_available_gb": gb, "ram_total_gb": 16.0},
    )


def test_releases_the_tts_model_when_ram_is_tight(unified, monkeypatch):
    """The bug: on a 16 GB Mac with little headroom, the TTS model stayed
    resident while large-v3 loaded on top — and the OS killed the backend."""
    _ram(monkeypatch, 2.5)  # ASR needs ~3 GB; there is not room for both

    mm.offload_tts_for_asr()

    assert mm.model is None       # actually released — the room is real
    assert unified["n"] >= 1      # device caches emptied too


def test_keeps_the_model_warm_when_there_is_plenty_of_room(unified, monkeypatch):
    """A roomy machine pays no reload — offloading is a cost, not a virtue."""
    _ram(monkeypatch, 12.0)

    mm.offload_tts_for_asr()

    assert mm.model is not None   # untouched


def test_restore_is_a_no_op_on_unified_memory(unified, monkeypatch):
    """Nothing to restore: the model was unloaded, and get_model() reloads it
    lazily on the next TTS call. Reloading it here would re-occupy the RAM we
    just freed, while the dub still has translation and synthesis to do."""
    _ram(monkeypatch, 2.0)
    mm.offload_tts_for_asr()
    assert mm.model is None

    mm.restore_tts_after_asr()    # must not raise, must not reload
    assert mm.model is None


def test_nothing_to_do_when_no_model_is_loaded(unified, monkeypatch):
    monkeypatch.setattr(mm, "model", None, raising=False)
    _ram(monkeypatch, 1.0)
    mm.offload_tts_for_asr()      # must not raise
    assert mm.model is None


def test_a_failing_memory_probe_never_aborts_the_transcription(unified, monkeypatch):
    """Making room is best-effort: if we can't tell how much RAM is free, the
    dub still runs — it must not die because a probe raised."""
    def boom():
        raise RuntimeError("psutil exploded")

    monkeypatch.setattr("services.memory_budget.available_memory", boom)

    mm.offload_tts_for_asr()      # must not raise
    assert mm.model is not None   # left alone rather than guessed at


def test_dedicated_gpu_path_is_untouched(monkeypatch):
    """CUDA still moves the model to CPU — this change is unified-memory only."""
    monkeypatch.setattr(mm, "_has_dedicated_vram", lambda: True)
    moved = {"to": None}

    class FakeModel:
        def to(self, dev):
            moved["to"] = dev

    monkeypatch.setattr(mm, "model", FakeModel(), raising=False)
    monkeypatch.setattr(mm, "free_vram", lambda: None)

    class FakeCuda:
        @staticmethod
        def is_available():
            return True

        @staticmethod
        def mem_get_info():
            return (1 * 1024 ** 3, 8 * 1024 ** 3)  # 1 GB free → offload

    monkeypatch.setattr(mm, "_lazy_torch", lambda: type("T", (), {"cuda": FakeCuda})())

    mm.offload_tts_for_asr()

    assert moved["to"] == "cpu"        # moved, not unloaded
    assert mm.model is not None        # the CUDA strategy keeps the object
