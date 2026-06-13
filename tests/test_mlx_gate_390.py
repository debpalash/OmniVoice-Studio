"""#390 regression: MLX-Audio and MLX-Whisper must report unavailable (and never
advertise a usable `mps` route) on non-Apple-Silicon hosts, even with the
package importable. Both backends now route through the shared
``core.device_caps.mlx_supported()`` gate BEFORE importing the package.

Backend classes are resolved at RUNTIME (other suites purge ``services.*`` from
``sys.modules``; importing the classes at module scope risks stale references
depending on test order).
"""
from __future__ import annotations

import pytest

_MLX_BACKENDS = [
    ("services.tts_backend", "MLXAudioBackend"),
    ("services.asr_backend", "MLXWhisperBackend"),
]


def _resolve(module_path, cls_name):
    import importlib
    return getattr(importlib.import_module(module_path), cls_name)


@pytest.mark.parametrize("module_path,cls_name", _MLX_BACKENDS)
def test_gate_blocks_when_mlx_unsupported(module_path, cls_name, monkeypatch):
    monkeypatch.setattr(
        "core.device_caps.mlx_supported",
        lambda: (False, "MLX requires Apple Silicon; this host is linux/x86_64"),
    )
    ok, why = _resolve(module_path, cls_name).is_available()
    assert ok is False
    assert "Apple Silicon" in why


@pytest.mark.parametrize("module_path,cls_name", _MLX_BACKENDS)
def test_gate_passthrough_when_supported(module_path, cls_name, monkeypatch):
    # When the platform gate passes, is_available proceeds to the package import.
    monkeypatch.setattr("core.device_caps.mlx_supported", lambda: (True, ""))
    ok, why = _resolve(module_path, cls_name).is_available()
    # Proof the gate didn't short-circuit: control reached the package-import
    # branch — so it's either genuinely available, or it reports the *package*
    # error ("… unavailable"), never the platform-gate string.
    assert ok or "unavailable" in why
    assert not why.startswith("MLX requires Apple Silicon")


@pytest.mark.parametrize("module_path,cls_name", _MLX_BACKENDS)
def test_mlx_backends_declare_mps_cpu(module_path, cls_name):
    assert _resolve(module_path, cls_name).gpu_compat == ("mps", "cpu")
