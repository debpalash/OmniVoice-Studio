"""Regression tests for #581: an incomplete/corrupt TTS model cache must
self-repair (re-fetch the missing files) instead of dead-ending the user with
a manual delete-and-reinstall instruction.

The old behavior raised a RuntimeError on the *first* truncated-cache OSError.
The fix makes `_load_model_sync` attempt an in-place `snapshot_download` repair
and retry the load once before surfacing the actionable message — so these
tests fail before the fix (no repair is attempted; load_asr default path raises
RuntimeError) and pass after.
"""
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
    monkeypatch.delenv("OMNIVOICE_PRELOAD_TTS_ASR", raising=False)
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    monkeypatch.setattr(mm, "_lazy_torch", lambda: SimpleNamespace(float16="float16"))
    monkeypatch.setattr(mm, "get_best_device", lambda: "cpu")
    return mm


_TRUNCATED = OSError(
    "test/checkpoint does not appear to have a file named pytorch_model.bin "
    "or model.safetensors"
)


def test_incomplete_cache_error_detection(model_manager):
    assert model_manager._is_incomplete_cache_error(_TRUNCATED) is True
    # An unrelated OSError must NOT be classified as an incomplete cache.
    assert model_manager._is_incomplete_cache_error(OSError("disk full")) is False


def test_complete_cache_does_not_trigger_repair(model_manager, monkeypatch):
    """Fast path: a complete cache loads on the first try with no repair call."""
    repair_calls = []
    monkeypatch.setattr(
        model_manager, "_repair_model_cache",
        lambda checkpoint: repair_calls.append(checkpoint) or True,
    )

    class GoodOmniVoice:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            return SimpleNamespace(llm=object())

    monkeypatch.setattr(model_manager, "_lazy_omnivoice", lambda: GoodOmniVoice)

    loaded = model_manager._load_model_sync()
    assert loaded.llm is not None
    assert repair_calls == []  # repair never attempted on a healthy cache


def test_incomplete_cache_self_repairs_and_retries(model_manager, monkeypatch):
    """The core #581 fix: the first load hits a truncated cache, repair runs,
    and the retried load succeeds — no RuntimeError surfaces to the user."""
    repair_calls = []
    monkeypatch.setattr(
        model_manager, "_repair_model_cache",
        lambda checkpoint: repair_calls.append(checkpoint) or True,
    )

    class FlakyOmniVoice:
        attempts = 0

        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            cls.attempts += 1
            if cls.attempts == 1:
                raise _TRUNCATED
            return SimpleNamespace(llm=object())

    monkeypatch.setattr(model_manager, "_lazy_omnivoice", lambda: FlakyOmniVoice)

    loaded = model_manager._load_model_sync()
    assert loaded.llm is not None
    assert repair_calls == ["test/checkpoint"]
    assert FlakyOmniVoice.attempts == 2  # load, repair, reload


def test_repair_failure_surfaces_actionable_message(model_manager, monkeypatch):
    """If repair can't fix the cache, the user still gets the actionable
    delete-and-reinstall message (not a raw transformers OSError)."""
    monkeypatch.setattr(model_manager, "_repair_model_cache", lambda checkpoint: False)

    class BrokenOmniVoice:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            raise _TRUNCATED

    monkeypatch.setattr(model_manager, "_lazy_omnivoice", lambda: BrokenOmniVoice)

    with pytest.raises(RuntimeError, match="incomplete"):
        model_manager._load_model_sync()


def test_repair_skipped_in_offline_mode(model_manager, monkeypatch):
    """Offline mode must not trigger a network re-fetch the user opted out of."""
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    called = []
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download",
        lambda *a, **k: called.append((a, k)),
    )
    assert model_manager._repair_model_cache("test/checkpoint") is False
    assert called == []  # no download attempted offline


def test_repair_invokes_snapshot_download(model_manager, monkeypatch):
    """Repair re-fetches the repo via snapshot_download (resume/fill missing)."""
    calls = []

    def fake_snapshot_download(**kwargs):
        calls.append(kwargs)
        return "/cache/test/checkpoint"

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake_snapshot_download)

    assert model_manager._repair_model_cache("test/checkpoint") is True
    assert calls and calls[0]["repo_id"] == "test/checkpoint"


def test_repair_returns_false_when_download_fails(model_manager, monkeypatch):
    """A failed re-fetch (no network, gated repo) returns False, never raises."""
    import huggingface_hub

    def boom(**kwargs):
        raise OSError("network down")

    monkeypatch.setattr(huggingface_hub, "snapshot_download", boom)
    assert model_manager._repair_model_cache("test/checkpoint") is False
