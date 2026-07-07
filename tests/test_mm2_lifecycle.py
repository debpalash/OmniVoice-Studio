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


def test_list_loaded_attributes_resident_tts_to_its_engine(monkeypatch):
    # Field report: OmniVoice stays resident in VRAM after switching to
    # voxcpm2, and the panel offered no hint it wasn't the routed engine.
    class _Model:
        _asr_pipe = object()
        def parameters(self): raise StopIteration
    monkeypatch.setattr(mm, "model", _Model())
    monkeypatch.setattr(mm, "_diar_pipeline", None)

    # String-target setattr: other suites pop+reimport services.* modules
    # mid-run (see module docstring), so the collection-time `tb` alias can go
    # stale — patch the module object _active_tts_id late-imports at call time.
    monkeypatch.setattr("services.tts_backend.active_backend_id", lambda: "voxcpm2")
    rows = {m["id"]: m for m in ml.list_loaded()["models"]}
    assert rows["tts"]["engine_id"] == "omnivoice"
    assert rows["tts"]["is_active_engine"] is False
    # ASR isn't competing with the TTS selection — must not be mislabeled.
    assert "is_active_engine" not in rows["asr"]

    monkeypatch.setattr("services.tts_backend.active_backend_id", lambda: "omnivoice")
    rows = {m["id"]: m for m in ml.list_loaded()["models"]}
    assert rows["tts"]["is_active_engine"] is True


def test_list_loaded_attribution_failure_degrades(monkeypatch):
    # Attribution is advisory: a raising prefs layer must not break the
    # panel, just leave the active flag unknown.
    class _Model:
        _asr_pipe = None
        def parameters(self): raise StopIteration
    monkeypatch.setattr(mm, "model", _Model())
    monkeypatch.setattr(mm, "_diar_pipeline", None)
    def _boom():
        raise RuntimeError("prefs unavailable")
    monkeypatch.setattr("services.tts_backend.active_backend_id", _boom)
    rows = {m["id"]: m for m in ml.list_loaded()["models"]}
    assert rows["tts"]["is_active_engine"] is None


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


# ── #622: install-state detector is weight-aware (truncated cache ≠ installed) ─

import api.routers.setup.models as models  # noqa: E402


def _make_snapshot(cache_root, repo_id, files):
    """Build a minimal HF-style snapshots/<rev>/ dir and return its cache root."""
    name = "models--" + repo_id.replace("/", "--")
    rev = cache_root / name / "snapshots" / "abc123"
    rev.mkdir(parents=True)
    for fname, data in files.items():
        (rev / fname).write_bytes(data)
    return rev


def test_snapshot_has_weights_distinguishes_truncated(tmp_path):
    full = tmp_path / "full"; full.mkdir()
    (full / "config.json").write_bytes(b"{}")
    (full / "model.safetensors").write_bytes(b"\0" * (6 * 1024 * 1024))
    assert models.snapshot_has_weights(str(full)) is True

    trunc = tmp_path / "trunc"; trunc.mkdir()
    (trunc / "config.json").write_bytes(b"{}")
    (trunc / "tokenizer.json").write_bytes(b"x" * 4096)
    assert models.snapshot_has_weights(str(trunc)) is False


def test_cache_is_complete_flags_truncated_weight_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    # Weight-bearing repo with config only (interrupted download) → incomplete.
    _make_snapshot(tmp_path, "k2-fsa/OmniVoice", {"config.json": b"{}"})
    assert models.cache_is_complete({"repo_id": "k2-fsa/OmniVoice"}) is False
    # Same repo once the shard lands → complete.
    _make_snapshot(
        tmp_path / "ok", "k2-fsa/OmniVoice",
        {"config.json": b"{}", "model.safetensors": b"\0" * (6 * 1024 * 1024)},
    )
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "ok"))
    assert models.cache_is_complete({"repo_id": "k2-fsa/OmniVoice"}) is True


def test_cache_is_complete_exempts_config_only_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    # pyannote pipeline ships no weight of its own — a tiny cache is legit, not
    # truncated; the config_only hint must keep it from being flagged incomplete.
    _make_snapshot(tmp_path, "pyannote/speaker-diarization-3.1", {"config.yaml": b"x"})
    assert models.cache_is_complete(
        {"repo_id": "pyannote/speaker-diarization-3.1", "config_only": True}
    ) is True


def test_list_models_downgrades_truncated_cache(tmp_path, monkeypatch):
    """A size-positive but weight-less cache must report installed=False so the
    first-run wizard re-offers the download instead of stranding the user (#622)."""
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    _make_snapshot(tmp_path, "k2-fsa/OmniVoice", {"config.json": b"{}"})

    class _Repo:
        def __init__(self, rid, size):
            self.repo_id, self.size_on_disk = rid, size
            self.last_accessed, self.nb_files = 0, 1

    class _Info:
        repos = [_Repo("k2-fsa/OmniVoice", 4096)]  # size > 0 (config landed)

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "scan_cache_dir", lambda: _Info())
    models.invalidate_cache()
    out = models.list_models()
    row = next(m for m in out["models"] if m["repo_id"] == "k2-fsa/OmniVoice")
    assert row["installed"] is False
    assert row["incomplete"] is True
    models.invalidate_cache()
