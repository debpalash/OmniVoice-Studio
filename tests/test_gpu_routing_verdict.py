"""Active-engine GPU routing verdict (#21 PR 4) — the no-silent-fallback
surface for preflight + diagnose.

Covers `tts_backend.gpu_routing_verdict()` (built from active_routing + the host
probe) and `diagnose._check_gpu_routing()`'s status mapping. Both are exercised
with mocks so no torch / full app import is needed.
"""
from __future__ import annotations

import pytest

from core.device_caps import HostCaps
from core.diagnose import OK, WARN, FAIL


# ── gpu_routing_verdict ─────────────────────────────────────────────────────

def test_verdict_uses_active_routing_and_host(monkeypatch):
    from services import tts_backend as tb
    monkeypatch.setattr(tb, "active_routing", lambda: {
        "engine": "omnivoice", "available": True,
        "effective_device": "cpu", "routing_status": "cpu_fallback",
        "routing_reason": "engine has no CUDA path; running on CPU",
    })
    monkeypatch.setattr(
        "core.device_caps.detect_host_caps",
        lambda: HostCaps(family="cuda", available_families=("cuda", "cpu"), vram_gb=24.0),
    )
    v = tb.gpu_routing_verdict()
    assert v["engine"] == "omnivoice"
    assert v["routing_status"] == "cpu_fallback"
    assert v["host_family"] == "cuda"
    assert v["vram_gb"] == 24.0


def test_verdict_degrades_when_no_active_engine(monkeypatch):
    from services import tts_backend as tb
    monkeypatch.setattr(tb, "active_routing", lambda: None)
    monkeypatch.setattr(
        "core.device_caps.detect_host_caps",
        lambda: HostCaps(family="cpu", available_families=("cpu",)),
    )
    v = tb.gpu_routing_verdict()
    assert v["engine"] is None
    assert v["routing_status"] == "none"
    assert v["host_family"] == "cpu"


# ── diagnose._check_gpu_routing status mapping ──────────────────────────────

@pytest.mark.parametrize("verdict,expected_status", [
    ({"engine": "e", "effective_device": "cuda", "routing_status": "accelerated",
      "routing_reason": None, "host_family": "cuda", "vram_gb": 24.0}, OK),
    ({"engine": "e", "effective_device": "cuda", "routing_status": "accelerated",
      "routing_reason": "CUDA selected, but: may fail at kernel launch",
      "host_family": "cuda", "vram_gb": 24.0}, WARN),
    ({"engine": "e", "effective_device": "cpu", "routing_status": "cpu_fallback",
      "routing_reason": "engine has no CUDA path; running on CPU",
      "host_family": "cuda", "vram_gb": 24.0}, WARN),
    ({"engine": "e", "effective_device": "cpu", "routing_status": "cpu_only",
      "routing_reason": None, "host_family": "cpu", "vram_gb": 0.0}, OK),
    ({"engine": "e", "effective_device": "cuda", "routing_status": "unavailable",
      "routing_reason": "requires cuda; this host has cpu",
      "host_family": "cpu", "vram_gb": 0.0}, FAIL),
    ({"engine": None, "effective_device": None, "routing_status": "none",
      "routing_reason": None, "host_family": "cpu", "vram_gb": 0.0}, WARN),
])
def test_diagnose_routing_status_mapping(monkeypatch, verdict, expected_status):
    import core.diagnose as diag
    monkeypatch.setattr("services.tts_backend.gpu_routing_verdict", lambda: verdict)
    check = diag._check_gpu_routing()
    assert check["id"] == "gpu_routing"
    assert check["status"] == expected_status
    if expected_status in (WARN, FAIL):
        assert check["hint"], "actionable hint required on warn/fail"


def test_diagnose_routing_never_raises(monkeypatch):
    import core.diagnose as diag

    def _boom():
        raise RuntimeError("probe exploded")

    monkeypatch.setattr("services.tts_backend.gpu_routing_verdict", _boom)
    check = diag._check_gpu_routing()
    assert check["status"] == WARN  # degrades, doesn't propagate
