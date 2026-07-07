"""Tests for backend/services/tts_backend.py::list_backends — Plan 02-01 Task 2.

ENGINE-05 closes when no single backend's `is_available()` exception can
take down the picker. ENGINE-06 data is delivered via the `last_error` and
`isolation_mode` fields on each entry.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterator
from unittest.mock import MagicMock

import pytest

# tests/conftest.py prepends ./backend to sys.path so `services.*` resolves.
from services import tts_backend
from services.subprocess_backend import SubprocessBackend
from services.tts_backend import TTSBackend, list_backends


REPO_ROOT = Path(__file__).resolve().parents[3]
ECHO_SCRIPT = REPO_ROOT / "backend" / "engines" / "_echo" / "main.py"


# ── helpers — context-managed registry mutations ───────────────────────────


@pytest.fixture
def registry_sandbox() -> Iterator[dict]:
    """Snapshot _REGISTRY + _LAST_ERRORS, yield, then restore.

    Every test that injects a fake backend uses this so registrations from
    one test never leak into another (the production registry must keep
    the same nine engine shape between runs).
    """
    saved_registry = dict(tts_backend._REGISTRY)
    saved_errors = dict(tts_backend._LAST_ERRORS)
    try:
        yield tts_backend._REGISTRY
    finally:
        tts_backend._REGISTRY.clear()
        tts_backend._REGISTRY.update(saved_registry)
        tts_backend._LAST_ERRORS.clear()
        tts_backend._LAST_ERRORS.update(saved_errors)


# ── synthetic backends used across tests ───────────────────────────────────


class BrokenBackend(TTSBackend):
    id = "broken"
    display_name = "Broken (test)"

    @property
    def sample_rate(self) -> int:
        return 24000

    @property
    def supported_languages(self) -> list[str]:
        return ["en"]

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        raise RuntimeError("kaboom")

    def generate(self, text: str, **kw):
        raise NotImplementedError


class HealthyInProcessBackend(TTSBackend):
    id = "healthy-inproc"
    display_name = "Healthy (in-process test)"

    @property
    def sample_rate(self) -> int:
        return 24000

    @property
    def supported_languages(self) -> list[str]:
        return ["en"]

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        return True, "ready"

    def generate(self, text: str, **kw):
        raise NotImplementedError


class FakeSubBackend(SubprocessBackend):
    id = "fake-sub"
    display_name = "Fake Subprocess (test)"

    @property
    def sample_rate(self) -> int:
        return 24000

    @property
    def supported_languages(self) -> list[str]:
        return ["multi"]

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        return True, "ready"

    @classmethod
    def venv_python(cls) -> Path:
        return Path(sys.executable)

    @classmethod
    def sidecar_script(cls) -> Path:
        return ECHO_SCRIPT


# ── ENGINE-05 — graceful degradation ───────────────────────────────────────


def test_list_backends_resilient(registry_sandbox):
    """A BrokenBackend.is_available() that raises must NOT take down the list."""
    registry_sandbox["broken"] = BrokenBackend
    out = list_backends()

    by_id = {entry["id"]: entry for entry in out}
    assert "broken" in by_id
    entry = by_id["broken"]
    assert entry["available"] is False
    assert "RuntimeError" in (entry["reason"] or "")
    assert "kaboom" in (entry["reason"] or "")
    assert "RuntimeError" in (entry["last_error"] or "")
    assert "kaboom" in (entry["last_error"] or "")

    # And every production backend still appears.
    expected = {
        "omnivoice", "cosyvoice", "kittentts", "mlx-audio", "voxcpm2",
        "moss-tts-nano", "indextts2", "gpt-sovits", "sherpa-onnx",
    }
    assert expected.issubset(by_id.keys()), (
        f"missing: {expected - by_id.keys()}"
    )


def test_list_backends_shape(registry_sandbox):
    """Every entry must contain exactly the documented keys — no more, no
    less — EXCEPT mlx-audio, which also carries `curated_models` +
    `active_model_id` (#981): it multiplexes 7+ curated models behind one
    backend id, so the Settings picker needs the roster + current pick."""
    out = list_backends()
    # `gpu_compat` joined the documented shape in Plan 02-04 alongside the
    # Engine Compatibility Matrix UI (ENGINE-06). The three routing keys
    # (effective_device / routing_status / routing_reason) joined in #21 so the
    # matrix can show the device each engine actually uses on THIS host.
    required = {
        "id", "display_name", "available", "reason",
        "install_hint", "last_error", "isolation_mode", "gpu_compat",
        "effective_device", "routing_status", "routing_reason",
        # Copy-paste env-var line for path-gated opt-in engines (None otherwise).
        "setup_snippet",
    }
    mlx_audio_extra = {"curated_models", "active_model_id"}
    for entry in out:
        expected = required | mlx_audio_extra if entry["id"] == "mlx-audio" else required
        assert set(entry.keys()) == expected, (
            f"entry {entry.get('id')} has wrong keys: "
            f"missing {expected - entry.keys()}, "
            f"extra {entry.keys() - expected}"
        )


def test_mlx_audio_curated_models_roster(registry_sandbox):
    """#981 — mlx-audio's entry carries the curated-model roster + the
    currently-active pick, so Settings can render a model picker instead of
    always silently defaulting to Kokoro."""
    out = {entry["id"]: entry for entry in list_backends()}
    entry = out["mlx-audio"]
    assert entry["active_model_id"] == "kokoro"  # DEFAULT_MODEL_KEY, no prefs set
    keys = {m["key"] for m in entry["curated_models"]}
    assert keys == set(tts_backend.MLXAudioBackend.CURATED_MODELS)
    for m in entry["curated_models"]:
        assert set(m.keys()) == {"key", "label", "repo_id"}
        assert m["repo_id"] == tts_backend.MLXAudioBackend.CURATED_MODELS[m["key"]]
        assert m["label"]  # non-empty, readable


def test_mlx_audio_active_model_id_reflects_prefs(registry_sandbox, monkeypatch, tmp_path):
    from core import prefs as _prefs
    monkeypatch.setattr(_prefs, "_PREFS_PATH", str(tmp_path / "prefs.json"))
    monkeypatch.delenv("OMNIVOICE_MLX_AUDIO_MODEL", raising=False)
    _prefs.set_("mlx_audio_model_id", "outetts")
    out = {entry["id"]: entry for entry in list_backends()}
    assert out["mlx-audio"]["active_model_id"] == "outetts"


def test_curated_models_not_present_on_other_backends(registry_sandbox):
    """Only mlx-audio multiplexes multiple models behind one backend id — no
    other entry should carry curated_models/active_model_id."""
    out = list_backends()
    for entry in out:
        if entry["id"] == "mlx-audio":
            continue
        assert "curated_models" not in entry
        assert "active_model_id" not in entry


def test_isolation_mode_in_process_vs_subprocess(registry_sandbox):
    """SubprocessBackend subclasses get isolation_mode='subprocess'; others 'in-process'."""
    registry_sandbox["fake-sub"] = FakeSubBackend
    registry_sandbox["healthy-inproc"] = HealthyInProcessBackend
    out = {entry["id"]: entry for entry in list_backends()}

    assert out["fake-sub"]["isolation_mode"] == "subprocess"
    assert out["healthy-inproc"]["isolation_mode"] == "in-process"
    # The pre-existing OmniVoice backend is in-process — sanity check.
    assert out["omnivoice"]["isolation_mode"] == "in-process"


def test_last_error_cleared_after_recovery(registry_sandbox):
    """First call raises → last_error populated. Second call returns ok →
    last_error cleared. The field must reflect MOST-RECENT failure, not stale."""
    state = {"calls": 0}

    class FlakyBackend(TTSBackend):
        id = "flaky"
        display_name = "Flaky (test)"

        @property
        def sample_rate(self) -> int:
            return 24000

        @property
        def supported_languages(self) -> list[str]:
            return ["en"]

        @classmethod
        def is_available(cls) -> tuple[bool, str]:
            state["calls"] += 1
            if state["calls"] == 1:
                raise RuntimeError("first call boom")
            return True, "ready"

        def generate(self, text: str, **kw):
            raise NotImplementedError

    registry_sandbox["flaky"] = FlakyBackend

    # First listing — failure populates last_error.
    first = {e["id"]: e for e in list_backends()}
    assert first["flaky"]["available"] is False
    assert first["flaky"]["last_error"] is not None
    assert "first call boom" in first["flaky"]["last_error"]

    # Second listing — success clears the cache.
    second = {e["id"]: e for e in list_backends()}
    assert second["flaky"]["available"] is True
    assert second["flaky"]["reason"] is None
    assert second["flaky"]["last_error"] is None


def test_existing_engines_still_listed():
    """Sanity: the wrap must not silently drop entries. We expect all nine
    in-tree engines unchanged."""
    out = list_backends()
    ids = {entry["id"] for entry in out}
    expected = {
        "omnivoice", "cosyvoice", "kittentts", "mlx-audio", "voxcpm2",
        "moss-tts-nano", "indextts2", "gpt-sovits", "sherpa-onnx",
    }
    assert expected.issubset(ids), f"missing entries: {expected - ids}"
    assert len(out) >= 9


def test_install_hint_preserved():
    """install_hint passthrough — Phase 1's tooltips must still render."""
    out = {entry["id"]: entry for entry in list_backends()}
    assert "kittentts" in out
    # The pre-existing _INSTALL_HINTS dict carries this one.
    assert out["kittentts"]["install_hint"] is not None
    assert "kittentts" in out["kittentts"]["install_hint"].lower()
