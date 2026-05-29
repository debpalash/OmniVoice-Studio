"""plan-02 (#129/#65) — torch.compile must be gated on Triton availability.

`torch.compile(mode="reduce-overhead")` needs Triton at runtime; Triton has no
Windows build, so on Windows+CUDA the compile path failed and surfaced as a
confusing "OOM". The gate skips compile (→ eager) when Triton is absent or the
user disabled it. Tests force find_spec / the setting and assert the decision.
"""
from __future__ import annotations

import importlib.util

from services import engine_env


def test_skips_when_device_not_cuda():
    assert engine_env.should_torch_compile("cpu") is False
    assert engine_env.should_torch_compile("mps") is False


def test_skips_when_triton_missing(monkeypatch):
    monkeypatch.setattr(
        importlib.util, "find_spec",
        lambda name: None if name == "triton" else object(),
    )
    assert engine_env.should_torch_compile("cuda") is False


def test_enabled_when_triton_present_and_not_disabled(monkeypatch):
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object())
    monkeypatch.setattr("services.settings_store.get_text", lambda key, default="0": "0")
    assert engine_env.should_torch_compile("cuda") is True


def test_skips_when_disabled_in_settings(monkeypatch):
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object())
    monkeypatch.setattr("services.settings_store.get_text", lambda key, default="0": "1")
    assert engine_env.should_torch_compile("cuda") is False
