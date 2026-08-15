"""The user compute-device override (Settings → Performance / OMNIVOICE_DEVICE).

The override is applied at the single choke point — `_probe()`'s family
selection — so routing, `get_best_device()`, and every UI badge inherit it.
Contract pinned here: an override steers, it cannot invent hardware (a family
this host lacks is noted and ignored); "cpu" is always honorable; env beats
the persisted Settings pick; unknown values normalize to "auto"; and the
running process reports what it actually applied (`requested_family`) so the
Settings panel can show restart-required truthfully.
"""
from __future__ import annotations

import types
from unittest.mock import patch

from core import device_caps


def _torch_mock(*, cuda_available=False, mps_available=False):
    """Minimal torch mock — just enough accelerator shape for the override
    tests (test_device_caps.py owns the full degradation matrix)."""
    cuda = types.SimpleNamespace(
        is_available=lambda: cuda_available,
        device_count=lambda: 1,
        get_device_name=lambda i: "NVIDIA RTX 4090",
        mem_get_info=lambda: (12 * 1024**3, 24 * 1024**3),
        get_device_capability=lambda i: (8, 9),
        _get_arch_list=lambda: [],
    )
    backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: mps_available)
    )
    xpu = types.SimpleNamespace(
        is_available=lambda: False, get_device_name=lambda i: ""
    )
    return types.SimpleNamespace(
        cuda=cuda, version=types.SimpleNamespace(), backends=backends, xpu=xpu
    )


def _probe_with(modules):
    with patch.dict("sys.modules", modules):
        return device_caps.refresh()


def _cleanup():
    # Leave the process-wide cache in its no-override state for other tests.
    # The env var must go FIRST: this runs inside the test (before
    # monkeypatch teardown), so a refresh with OMNIVOICE_DEVICE still set
    # would cache the overridden caps for every later test in the session.
    import os

    os.environ.pop("OMNIVOICE_DEVICE", None)
    device_caps.refresh()


def test_no_override_is_auto_and_keeps_priority_pick(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_DEVICE", raising=False)
    monkeypatch.setattr("core.prefs.resolve", lambda key, **kw: kw.get("default"))
    try:
        caps = _probe_with({"torch": _torch_mock(cuda_available=True, mps_available=True)})
        assert caps.family == "cuda"
        assert caps.requested_family == "auto"
    finally:
        _cleanup()


def test_cpu_override_forces_cpu_on_an_accelerated_host(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DEVICE", "cpu")
    try:
        caps = _probe_with({"torch": _torch_mock(cuda_available=True)})
        assert caps.family == "cpu"
        assert caps.requested_family == "cpu"
        # The pin is explained, not silent — a CUDA host showing CPU chips
        # without a note reads as a broken install.
        assert any("pinned" in n for n in caps.notes)
    finally:
        _cleanup()


def test_override_for_a_missing_family_is_noted_and_ignored(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DEVICE", "cuda")
    try:
        caps = _probe_with({"torch": _torch_mock(mps_available=True)})
        assert caps.family == "mps"  # auto pick survives
        assert caps.requested_family == "cuda"
        assert any("not available" in n for n in caps.notes)
    finally:
        _cleanup()


def test_override_matching_the_auto_pick_adds_no_note(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DEVICE", "cuda")
    try:
        caps = _probe_with({"torch": _torch_mock(cuda_available=True)})
        assert caps.family == "cuda"
        assert not any("pinned" in n for n in caps.notes)
    finally:
        _cleanup()


def test_env_beats_the_persisted_settings_pick(monkeypatch, tmp_path):
    # Same resolution order as engine selection (#981): a power-user's env
    # pin must not be silently undone by the UI's stored choice.
    from core import prefs

    monkeypatch.setattr(prefs, "_PREFS_PATH", tmp_path / "prefs.json")
    prefs.set_("compute_device", "cuda")
    try:
        monkeypatch.setenv("OMNIVOICE_DEVICE", "cpu")
        assert device_caps.requested_device_override() == "cpu"
        monkeypatch.delenv("OMNIVOICE_DEVICE")
        assert device_caps.requested_device_override() == "cuda"
    finally:
        _cleanup()


def test_unknown_values_normalize_to_auto(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DEVICE", "quantum")
    try:
        assert device_caps.requested_device_override() == "auto"
    finally:
        _cleanup()


def test_torch_unimportable_still_reports_the_request(monkeypatch):
    # Even a degraded CPU-only probe carries the requested family so the
    # Settings panel renders the user's pick instead of resetting to auto.
    monkeypatch.setenv("OMNIVOICE_DEVICE", "cpu")
    real_import = __import__

    def _no_torch(name, *a, **kw):
        if name == "torch":
            raise ImportError("no torch here")
        return real_import(name, *a, **kw)

    try:
        with patch.dict("sys.modules"):
            import sys

            sys.modules.pop("torch", None)
            with patch("builtins.__import__", side_effect=_no_torch):
                caps = device_caps.refresh()
        assert caps.probe_ok is False
        assert caps.requested_family == "cpu"
    finally:
        _cleanup()
