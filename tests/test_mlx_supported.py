"""Unit tests for core.device_caps.mlx_supported() — the shared MLX platform
gate (#390). Gates strictly on darwin+arm64+torch-MPS; returns the exact pinned
(ok, reason) tuples for every host so a stray mlx wheel on Linux/Windows/mac-Intel
never reports available.
"""
from __future__ import annotations

import sys
import types
from unittest.mock import patch

from core import device_caps


def _mps_torch(available):
    return types.SimpleNamespace(
        backends=types.SimpleNamespace(
            mps=types.SimpleNamespace(is_available=lambda: available)
        )
    )


def test_apple_silicon_with_mps_supported():
    with patch.object(sys, "platform", "darwin"), \
         patch("platform.machine", return_value="arm64"), \
         patch.dict("sys.modules", {"torch": _mps_torch(True)}):
        ok, reason = device_caps.mlx_supported()
    assert ok is True
    assert reason == ""


def test_apple_silicon_without_mps():
    with patch.object(sys, "platform", "darwin"), \
         patch("platform.machine", return_value="arm64"), \
         patch.dict("sys.modules", {"torch": _mps_torch(False)}):
        ok, reason = device_caps.mlx_supported()
    assert ok is False
    assert "torch MPS unavailable" in reason


def test_mac_intel_rejected():
    with patch.object(sys, "platform", "darwin"), \
         patch("platform.machine", return_value="x86_64"):
        ok, reason = device_caps.mlx_supported()
    assert ok is False
    assert reason == "MLX requires Apple Silicon; this Mac is Intel"


def test_linux_rejected_before_import():
    with patch.object(sys, "platform", "linux"), \
         patch("platform.machine", return_value="x86_64"):
        ok, reason = device_caps.mlx_supported()
    assert ok is False
    assert "this host is linux/x86_64" in reason


def test_windows_rejected():
    with patch.object(sys, "platform", "win32"), \
         patch("platform.machine", return_value="AMD64"):
        ok, reason = device_caps.mlx_supported()
    assert ok is False
    assert "MLX requires Apple Silicon" in reason


def test_apple_silicon_torch_unimportable():
    real_import = __import__

    def _blocked(name, *a, **k):
        if name == "torch":
            raise ImportError("no torch")
        return real_import(name, *a, **k)

    with patch.object(sys, "platform", "darwin"), \
         patch("platform.machine", return_value="arm64"), \
         patch("builtins.__import__", _blocked):
        ok, reason = device_caps.mlx_supported()
    assert ok is False
    assert "torch not importable" in reason
