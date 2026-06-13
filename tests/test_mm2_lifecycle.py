"""MM2 model-management cleanup — unload contract, lifecycle facade, config,
cooldown bounding, per-role weight validation, sidecar VRAM surfacing.

Top-level (not under tests/backend/) on purpose: adding files there reorders
collection and can expose a pre-existing sys.modules-isolation leak in other
backend fixtures (see tests/test_fdl_*).
"""
from __future__ import annotations

import asyncio
import os

import pytest

import services.tts_backend as tb
import services.model_lifecycle as ml
import services.model_manager as mm
import services.subprocess_backend as sb
import api.routers.setup.download as dl


def _run(coro):
    return asyncio.run(coro)


# ── MM2-01 / MM2-02: registry reuse + unload-on-switch ──────────────────────

def _fake_backend(calls):
    class Fake(tb.TTSBackend):
        id = "fake-mm2"
        display_name = "Fake"
        @property
        def sample_rate(self): return 24000
        @property
        def supported_languages(self): return ["multi"]
        @classmethod
        def is_available(cls): return True, "ok"
        def generate(self, *a, **k): ...
        def unload(self): calls["unload"] += 1
    return Fake


def test_active_instance_reused_for_same_id(monkeypatch):
    tb.reset_active_backend()
    monkeypatch.setattr(tb, "active_backend_id", lambda: "omnivoice")
    a = tb.get_active_tts_backend()
    b = tb.get_active_tts_backend()
    assert a is b
    tb.reset_active_backend()


def test_switch_unloads_previous_engine(monkeypatch):
    calls = {"unload": 0}
    tb._REGISTRY["fake-mm2"] = _fake_backend(calls)
    tb.reset_active_backend()
    monkeypatch.setattr(tb, "active_backend_id", lambda: "fake-mm2")
    tb.get_active_tts_backend()
    monkeypatch.setattr(tb, "active_backend_id", lambda: "omnivoice")
    tb.get_active_tts_backend()
    assert calls["unload"] == 1
    tb.reset_active_backend()
    tb._REGISTRY.pop("fake-mm2", None)


def test_reset_active_backend_is_idempotent_and_unloads():
    calls = {"unload": 0}
    tb._active_instance = _fake_backend(calls)()
    tb._active_instance_id = "fake-mm2"
    tb.reset_active_backend()
    tb.reset_active_backend()  # second call no-ops
    assert calls["unload"] == 1
    assert tb._active_instance is None


def test_omnivoice_unload_idempotent_and_preload_safe():
    b = tb.OmniVoiceBackend()
    b.unload()
    b.unload()  # twice, and before any generate() — must not raise


# ── MM2-04 / MM2-03: lifecycle facade + honest ASR ──────────────────────────

def test_list_loaded_empty(monkeypatch):
    monkeypatch.setattr(mm, "model", None)
    monkeypatch.setattr(mm, "_diar_pipeline", None)
    out = ml.list_loaded()
    assert out == {"models": [], "count": 0} or out["count"] == 0


def test_list_loaded_asr_row_is_honest(monkeypatch):
    class _Model:
        _asr_pipe = object()
        def parameters(self): raise StopIteration
    monkeypatch.setattr(mm, "model", _Model())
    monkeypatch.setattr(mm, "_diar_pipeline", None)
    rows = {m["id"]: m for m in ml.list_loaded()["models"]}
    assert "asr" in rows
    asr = rows["asr"]
    assert asr["unloadable"] is False
    assert asr.get("note")  # explains the disabled unload button


def test_facade_unload_unknown_raises():
    with pytest.raises(ValueError):
        _run(ml.unload("bogus"))


def test_facade_unload_tts_not_loaded(monkeypatch):
    monkeypatch.setattr(mm, "model", None)
    r = _run(ml.unload("tts"))
    assert r == {"unloaded": "tts", "success": False, "reason": "not loaded"}


def test_facade_unload_sidecars_none_running():
    r = _run(ml.unload("sidecars"))
    assert r["unloaded"] == "sidecars"
    assert r["success"] is False and r["count"] == 0


# ── MM2-05: unified idle config (env wins) ──────────────────────────────────

def test_idle_timeout_env_wins(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_IDLE_TIMEOUT_S", "123")
    assert mm._resolve_idle_timeout() == 123.0


def test_sidecar_idle_timeout_env_wins(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S", "0")
    assert sb._resolve_sidecar_idle_timeout() == 0.0  # <=0 disables reaping


# ── MM2-06: bounded cooldowns ───────────────────────────────────────────────

def test_cooldown_sweep_evicts_stale():
    now = 1_000_000.0
    dl._install_cooldowns.clear()
    dl._install_cooldowns["old/repo"] = now - dl._COOLDOWN_TTL_SECS - 10
    dl._install_cooldowns["fresh/repo"] = now - 5
    dl._sweep_cooldowns(now)
    assert "old/repo" not in dl._install_cooldowns
    assert "fresh/repo" in dl._install_cooldowns
    dl._install_cooldowns.clear()


# ── MM2-07: per-role weight validation ──────────────────────────────────────

def test_small_onnx_is_not_flagged_as_truncated(tmp_path):
    # A complete-but-small ONNX model (> 64 KB, < 5 MB) must pass.
    (tmp_path / "model.onnx").write_bytes(b"\0" * (128 * 1024))
    dl._validate_snapshot_has_weights("x/onnx", str(tmp_path))  # must not raise


def test_truncated_snapshot_still_rejected(tmp_path):
    # Only tiny config/tokenizer files, no plausible weight → reject (#352).
    (tmp_path / "config.json").write_bytes(b"{}")
    (tmp_path / "tokenizer.json").write_bytes(b"x" * 2048)
    with pytest.raises(OSError):
        dl._validate_snapshot_has_weights("x/truncated", str(tmp_path))


def test_large_tensor_weight_passes(tmp_path):
    (tmp_path / "model.safetensors").write_bytes(b"\0" * (6 * 1024 * 1024))
    dl._validate_snapshot_has_weights("x/big", str(tmp_path))  # must not raise
