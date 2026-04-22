"""Tests for GET /setup/preflight — the first-run system health probe.

Mocks subprocess calls (nvidia-smi / rocm-smi), platform detection, and
network + torch imports so the endpoint shape + branching logic is verified
without needing a specific hardware configuration.
"""
from __future__ import annotations

import sys
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    from main import app
    return TestClient(app)


# ── Shape ────────────────────────────────────────────────────────────────

def test_preflight_returns_expected_shape(client):
    """Endpoint always returns {ok, has_warnings, checks[], device}."""
    r = client.get("/setup/preflight")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) >= {"ok", "has_warnings", "checks", "device"}
    assert isinstance(body["ok"], bool)
    assert isinstance(body["has_warnings"], bool)
    assert isinstance(body["checks"], list)
    assert isinstance(body["device"], dict)


def test_preflight_every_check_has_required_fields(client):
    """Each check entry must carry id/label/status/detail/fix."""
    body = client.get("/setup/preflight").json()
    for c in body["checks"]:
        assert set(c.keys()) >= {"id", "label", "status", "detail", "fix"}
        assert c["status"] in {"pass", "warn", "fail"}


def test_preflight_always_probes_core_checks(client):
    """The fixed set of checks should always be present — users need a
    consistent list regardless of platform."""
    body = client.get("/setup/preflight").json()
    ids = {c["id"] for c in body["checks"]}
    required_ids = {
        "os", "python", "ram", "disk", "hf_cache_writable",
        "ffmpeg", "ffprobe", "gpu", "network",
    }
    assert required_ids.issubset(ids), f"missing: {required_ids - ids}"


def test_preflight_device_summary(client):
    """device block must include os/arch/gpu_vendor/gpu_backend/ram_gb."""
    body = client.get("/setup/preflight").json()
    d = body["device"]
    assert set(d.keys()) >= {
        "os", "arch", "gpu_vendor", "gpu_backend", "gpu_available",
        "gpu_driver", "gpu_device_name", "ram_gb", "disk_free_gb",
    }
    assert d["gpu_backend"] in {"cuda", "rocm", "mps", "cpu"}
    assert d["gpu_vendor"] in {"nvidia", "amd", "apple", "intel", "unknown", "none"}


# ── Aggregation logic ────────────────────────────────────────────────────

def test_preflight_ok_false_when_any_fail(client):
    """If any check is fail, aggregate ok must be false."""
    body = client.get("/setup/preflight").json()
    any_fail = any(c["status"] == "fail" for c in body["checks"])
    assert body["ok"] is (not any_fail)


def test_preflight_has_warnings_matches_checks(client):
    body = client.get("/setup/preflight").json()
    any_warn = any(c["status"] == "warn" for c in body["checks"])
    assert body["has_warnings"] is any_warn


# ── GPU vendor detection branches ────────────────────────────────────────

def test_preflight_detects_apple_silicon():
    """On mac-ARM, vendor → 'apple' and backend → 'mps'."""
    if sys.platform != "darwin":
        pytest.skip("apple-silicon branch only exercisable on darwin")
    from api.routers.setup import _detect_gpu
    info = _detect_gpu()
    # mac-Intel CI hosts also hit darwin; only assert vendor if arch matches.
    import platform as _p
    if _p.machine() == "arm64":
        assert info["vendor"] == "apple"
        assert info["backend"] == "mps"


def test_preflight_handles_missing_nvidia_smi():
    """When nvidia-smi is absent, vendor falls through (not nvidia)."""
    from api.routers.setup import _detect_gpu, _run_cmd  # noqa
    with patch("api.routers.setup._run_cmd", return_value=(-1, "")):
        info = _detect_gpu()
        # On mac-ARM the apple branch returns before _run_cmd; skip that case.
        import platform as _p
        if sys.platform != "darwin" or _p.machine() != "arm64":
            assert info["vendor"] != "nvidia"


def test_preflight_nvidia_driver_below_min_flags_fail():
    """An old NVIDIA driver must produce status='fail' with a driver-update fix."""
    import platform as _p
    if sys.platform == "darwin" and _p.machine() == "arm64":
        pytest.skip("apple-silicon branch returns before nvidia-smi — not reachable")
    from api.routers import setup as setup_mod

    def fake_run_cmd(args, timeout=2.0):
        if args and args[0] == "nvidia-smi":
            return 0, "520.61.05, NVIDIA GeForce RTX 3090\n"
        return -1, ""

    with patch.object(setup_mod, "_run_cmd", side_effect=fake_run_cmd):
        info = setup_mod._detect_gpu()

    assert info["vendor"] == "nvidia"
    assert info["available"] is False
    assert any("driver" in n.lower() for n in info["notes"])


def test_preflight_amd_flags_warn_when_no_rocm_torch():
    """AMD GPU + torch without HIP → warn with ROCm install instructions."""
    import platform as _p
    if sys.platform == "darwin" and _p.machine() == "arm64":
        pytest.skip("apple-silicon branch returns before rocm-smi")
    from api.routers import setup as setup_mod

    def fake_run_cmd(args, timeout=2.0):
        if args and args[0] == "rocm-smi":
            return 0, "GPU[0]: Card series: AMD Radeon RX 7900 XTX\n"
        return -1, ""

    with patch.object(setup_mod, "_run_cmd", side_effect=fake_run_cmd):
        info = setup_mod._detect_gpu()

    assert info["vendor"] == "amd"
    # The bundled CUDA torch has no .version.hip → must be flagged
    if info["backend"] != "rocm":
        assert any("rocm" in n.lower() for n in info["notes"])


# ── Network probe ────────────────────────────────────────────────────────

def test_preflight_network_handles_offline():
    """_probe_network must gracefully return False on connection error."""
    from api.routers.setup import _probe_network
    # Deliberately unreachable host:port
    assert _probe_network(host="10.255.255.1", timeout=0.3) is False


# ── RAM thresholds ───────────────────────────────────────────────────────

def test_preflight_ram_fail_threshold():
    """Below _RAM_FAIL_GB → fail status in the RAM check."""
    from api.routers import setup as setup_mod

    with patch.object(setup_mod, "_ram_gb", return_value=4.0):
        r = client_factory().get("/setup/preflight").json()
    ram = next(c for c in r["checks"] if c["id"] == "ram")
    assert ram["status"] == "fail"


def test_preflight_ram_warn_threshold():
    """Between fail and warn thresholds → warn."""
    from api.routers import setup as setup_mod

    with patch.object(setup_mod, "_ram_gb", return_value=10.0):
        r = client_factory().get("/setup/preflight").json()
    ram = next(c for c in r["checks"] if c["id"] == "ram")
    assert ram["status"] == "warn"


# ── Helpers ──────────────────────────────────────────────────────────────

def client_factory():
    """Per-test TestClient; avoids module-scoped fixture collisions with
    ``patch()`` context managers."""
    from main import app
    return TestClient(app)
