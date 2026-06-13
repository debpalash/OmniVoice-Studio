"""Unit tests for backend/services/engine_routing.py (GPU compat matrix, PR 1).

``resolve_routing`` is a pure function over ``(gpu_compat, HostCaps)`` — these
tests construct ``HostCaps`` directly (no torch) and assert every rule + edge
from spec §2, plus the cross-OS determinism + never-emits-"n/a" guarantees.
"""
from __future__ import annotations

from core.device_caps import DIRECTML_MARKER, KERNEL_RISK_MARKER, HostCaps
from services.engine_routing import resolve_routing


def _caps(family, *, notes=(), available=None):
    if available is None:
        available = (family, "cpu") if family != "cpu" else ("cpu",)
    return HostCaps(family=family, available_families=available, notes=tuple(notes))


# ── Rule 2: accelerated ──────────────────────────────────────────────────
def test_cuda_host_cuda_engine_accelerated():
    r = resolve_routing(("cuda", "cpu"), _caps("cuda"))
    assert r == {"effective_device": "cuda", "routing_status": "accelerated",
                 "routing_reason": None}


def test_mps_host_mps_engine_accelerated():
    r = resolve_routing(("mps", "cpu"), _caps("mps"))
    assert r["routing_status"] == "accelerated"
    assert r["effective_device"] == "mps"


def test_accelerated_with_kernel_risk_caveat():
    note = f"GPU (sm_120) not in this torch build's archs — {KERNEL_RISK_MARKER}"
    r = resolve_routing(("cuda", "cpu"), _caps("cuda", notes=[note]))
    assert r["routing_status"] == "accelerated"
    assert r["routing_reason"] is not None
    assert r["routing_reason"].startswith("CUDA selected, but:")
    assert KERNEL_RISK_MARKER in r["routing_reason"]


def test_accelerated_ignores_advisory_notes():
    # Multi-GPU / VRAM advisory notes must NOT downgrade the accelerated badge.
    r = resolve_routing(("cuda", "cpu"),
                        _caps("cuda", notes=["3 GPUs detected; routing reflects device 0"]))
    assert r["routing_status"] == "accelerated"
    assert r["routing_reason"] is None


# ── Rule 3: cpu_fallback (the no-silent-fallback signal) ──────────────────
def test_cuda_host_cpu_only_engine_falls_back():
    r = resolve_routing(("cpu",), _caps("cuda"))
    assert r["routing_status"] == "cpu_fallback"
    assert r["effective_device"] == "cpu"
    assert "no CUDA path" in r["routing_reason"]


def test_rocm_host_cuda_only_engine_falls_back_with_specific_reason():
    r = resolve_routing(("cuda", "cpu"), _caps("rocm"))
    assert r["routing_status"] == "cpu_fallback"
    assert r["routing_reason"] == "declares CUDA only; ROCm not in its compat set"


def test_xpu_host_cpu_engine_falls_back():
    r = resolve_routing(("cuda", "cpu"), _caps("xpu"))
    assert r["routing_status"] == "cpu_fallback"
    assert "no XPU path" in r["routing_reason"]


# ── Rule 4: cpu_only (benign) ─────────────────────────────────────────────
def test_cpu_host_cpu_engine_is_neutral():
    r = resolve_routing(("cuda", "cpu"), _caps("cpu"))
    assert r == {"effective_device": "cpu", "routing_status": "cpu_only",
                 "routing_reason": None}


def test_directml_host_gets_explanatory_reason_but_stays_neutral():
    note = f"{DIRECTML_MARKER} (Windows GPU); torch-family probe treats as non-accelerated"
    r = resolve_routing(("cuda", "cpu"), _caps("cpu", notes=[note]))
    assert r["routing_status"] == "cpu_only"   # never blocks
    assert "DirectML" in r["routing_reason"]


# ── Rule 5: unavailable ───────────────────────────────────────────────────
def test_cpu_host_gpu_only_engine_unavailable():
    r = resolve_routing(("cuda",), _caps("cpu"))
    assert r["routing_status"] == "unavailable"
    assert r["effective_device"] == "cuda"
    assert "requires cuda" in r["routing_reason"]
    assert "this host has cpu" in r["routing_reason"]


def test_xpu_host_gpu_only_no_cpu_unavailable():
    r = resolve_routing(("cuda", "mps"), _caps("xpu"))
    assert r["routing_status"] == "unavailable"


# ── Rule 1: defensive empty compat ────────────────────────────────────────
def test_empty_compat_is_defensive_cpu_only():
    r = resolve_routing((), _caps("cuda"))
    assert r["routing_status"] == "cpu_only"
    assert r["effective_device"] == "cpu"


# ── Contract guarantees ───────────────────────────────────────────────────
def test_never_emits_n_a():
    for fam in ("cuda", "rocm", "mps", "xpu", "cpu"):
        for compat in ((), ("cpu",), ("cuda",), ("cuda", "cpu"), ("mps", "cpu")):
            assert resolve_routing(compat, _caps(fam))["routing_status"] != "n/a"


def test_deterministic_across_calls():
    caps = _caps("rocm")
    assert resolve_routing(("cuda", "cpu"), caps) == resolve_routing(("cuda", "cpu"), caps)


def test_reason_str_for_fallback_and_unavailable_none_for_clean():
    assert resolve_routing(("cpu",), _caps("cuda"))["routing_reason"] is not None
    assert resolve_routing(("cuda",), _caps("cpu"))["routing_reason"] is not None
    assert resolve_routing(("cuda", "cpu"), _caps("cuda"))["routing_reason"] is None
