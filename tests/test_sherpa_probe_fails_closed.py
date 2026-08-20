"""The sherpa availability probe must fail closed (#1610 review).

``sherpa_available()`` caught ImportError plus OSError/RuntimeError, the types
a broken native wheel usually raises. That set is open-ended — an extension
module can raise anything during init. ``SherpaDictationBackend.is_available()``
calls this directly and ``capture_ws.ws_transcribe`` calls that without a
guard, so an unlisted exception type didn't degrade to "engine unavailable",
it took the dictation WebSocket down.
"""
from __future__ import annotations

import builtins
import importlib

import pytest


@pytest.fixture
def sherpa():
    return importlib.import_module("services.sherpa_dictation")


class _Boom(Exception):
    """A native init failure that is neither OSError nor RuntimeError."""


@pytest.mark.parametrize("exc", [
    ImportError("no module named sherpa_onnx"),
    OSError("cannot load libonnxruntime.so"),
    RuntimeError("failed to initialize backend"),
    _Boom("ctypes ArgumentError-shaped failure"),
    ValueError("unexpected init failure"),
])
def test_any_import_failure_reports_unavailable(sherpa, monkeypatch, exc):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "sherpa_onnx":
            raise exc
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    ok, detail = sherpa.sherpa_available()
    assert ok is False
    assert detail  # the reason is always reported, never swallowed silently
    assert type(exc).__name__ in detail or "not installed" in detail


def test_a_working_install_still_reports_ready(sherpa, monkeypatch):
    import sys
    import types

    monkeypatch.setitem(sys.modules, "sherpa_onnx", types.ModuleType("sherpa_onnx"))
    assert sherpa.sherpa_available() == (True, "ready")
