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
    consistent list regardless of platform. Genuine user facts only."""
    body = client.get("/setup/preflight").json()
    ids = {c["id"] for c in body["checks"]}
    required_ids = {
        "os", "python", "ram", "disk", "hf_cache_writable",
        "gpu", "network",
    }
    assert required_ids.issubset(ids), f"missing: {required_ids - ids}"


def test_preflight_never_lists_media_tools_as_requirements(client):
    """ffmpeg / ffprobe / yt-dlp are internal dependencies the app provisions
    for itself — they must NOT appear as system-requirement check rows (the
    old model told users to `brew install ffmpeg`)."""
    body = client.get("/setup/preflight").json()
    ids = {c["id"] for c in body["checks"]}
    assert not ids & {"ffmpeg", "ffprobe", "yt-dlp"}, ids
    joined = " ".join(f"{c['detail']} {c.get('fix') or ''}" for c in body["checks"])
    assert "brew install ffmpeg" not in joined
    assert "yt-dlp" not in joined


def test_preflight_carries_media_tools_verdict(client):
    """The wizard's quiet progress line / failure card reads a top-level
    media_tools verdict: {ready, acquire:{state, progress, error}}."""
    body = client.get("/setup/preflight").json()
    media = body.get("media_tools")
    assert media is not None
    assert isinstance(media["ready"], bool)
    assert media["acquire"]["state"] in {"idle", "running", "done", "error"}


def test_preflight_kicks_background_acquisition_when_unresolved():
    """No tier resolves → preflight itself starts the bundled download (the
    first-run self-heal) instead of telling the user to install anything."""
    import services.media_tools as mt

    calls = []
    with patch.object(mt, "status", return_value={
        "ready": False, "tools": {},
        "ops": {"acquire": {"state": "idle", "progress": 0.0, "error": None},
                "ytdlp_update": {"state": "idle"}},
        "platform_key": "test",
    }), patch.object(mt, "acquire_bundled",
                     side_effect=lambda wait=False: calls.append(1) or
                     {"state": "running", "progress": 0.0, "error": None}):
        body = client_factory().get("/setup/preflight").json()

    assert calls, "preflight must trigger acquire_bundled when unresolved"
    assert body["media_tools"] == {
        "ready": False,
        "acquire": {"state": "running", "progress": 0.0, "error": None},
    }
    # And the media engine never blocks the Continue gate.
    checks_fail = any(c["status"] == "fail" for c in body["checks"])
    assert body["ok"] is (not checks_fail)


def test_preflight_does_not_retrigger_after_failed_acquisition():
    """After a failed download the wizard's failure card owns Retry —
    a preflight recheck must not silently re-fire the download."""
    import services.media_tools as mt

    with patch.object(mt, "status", return_value={
        "ready": False, "tools": {},
        "ops": {"acquire": {"state": "error", "progress": 0.0,
                            "error": "download checksum mismatch"},
                "ytdlp_update": {"state": "idle"}},
        "platform_key": "test",
    }), patch.object(mt, "acquire_bundled") as fired:
        body = client_factory().get("/setup/preflight").json()

    fired.assert_not_called()
    assert body["media_tools"]["acquire"]["state"] == "error"
    assert "checksum" in body["media_tools"]["acquire"]["error"]


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
    # #21: canonical-probe family + VRAM joined the device summary.
    assert d["gpu_family"] in {"cuda", "rocm", "mps", "xpu", "cpu"}
    assert isinstance(d["vram_gb"], (int, float))


def test_preflight_includes_active_engine_routing(client):
    """#21: preflight surfaces a routing verdict for the active TTS engine
    (no silent CPU fallback) — both a `gpu_routing` object and a check entry."""
    body = client.get("/setup/preflight").json()
    assert "gpu_routing" in body
    gr = body["gpu_routing"]
    if gr is not None:
        assert gr["routing_status"] in {
            "accelerated", "cpu_fallback", "cpu_only", "unavailable", "none",
        }
        assert "host_family" in gr
        ids = {c["id"] for c in body["checks"]}
        assert "gpu_routing" in ids


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
    from api.routers.setup.wizard import _detect_gpu
    info = _detect_gpu()
    # mac-Intel CI hosts also hit darwin; only assert vendor if arch matches.
    import platform as _p
    if _p.machine() == "arm64":
        assert info["vendor"] == "apple"
        assert info["backend"] == "mps"


def test_preflight_handles_missing_nvidia_smi():
    """When nvidia-smi is absent, vendor falls through (not nvidia)."""
    from api.routers.setup.wizard import _detect_gpu, _run_cmd  # noqa
    with patch("api.routers.setup.wizard._run_cmd", return_value=(-1, "")):
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
    from api.routers.setup import wizard as setup_mod

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
    from api.routers.setup import wizard as setup_mod

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


# ── Docker / container GPU fallback ──────────────────────────────────────

def test_preflight_docker_gpu_fallback_detects_cuda():
    """When nvidia-smi is absent but torch.cuda works (Docker container),
    vendor → 'unknown', backend → 'cuda', available → True, and
    device_name is populated from torch.cuda.get_device_name()."""
    import platform as _p
    if sys.platform == "darwin" and _p.machine() == "arm64":
        pytest.skip("apple-silicon branch returns before fallback")
    from api.routers.setup import wizard as setup_mod
    from types import SimpleNamespace

    def fake_run_cmd(args, timeout=2.0):
        # Neither nvidia-smi nor rocm-smi available
        return -1, ""

    fake_torch = SimpleNamespace(
        cuda=SimpleNamespace(
            is_available=lambda: True,
            get_device_name=lambda idx: "NVIDIA GeForce RTX 4070 Laptop GPU",
        ),
        version=SimpleNamespace(hip=None),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
    )

    with patch.object(setup_mod, "_run_cmd", side_effect=fake_run_cmd), \
         patch.dict("sys.modules", {"torch": fake_torch}):
        info = setup_mod._detect_gpu()

    assert info["vendor"] == "unknown"
    assert info["backend"] == "cuda"
    assert info["available"] is True
    assert info["device_name"] == "NVIDIA GeForce RTX 4070 Laptop GPU"


def test_preflight_docker_gpu_fallback_shows_pass_status():
    """The preflight GPU check should show status='pass' when the Docker
    fallback detects CUDA, not the old 'No compatible GPU' warning."""
    import platform as _p
    if sys.platform == "darwin" and _p.machine() == "arm64":
        pytest.skip("apple-silicon branch returns before fallback")
    from api.routers.setup import wizard as setup_mod
    from types import SimpleNamespace

    def fake_run_cmd(args, timeout=2.0):
        return -1, ""

    fake_torch = SimpleNamespace(
        cuda=SimpleNamespace(
            is_available=lambda: True,
            get_device_name=lambda idx: "NVIDIA GeForce RTX 4070 Laptop GPU",
        ),
        version=SimpleNamespace(hip=None),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
    )

    with patch.object(setup_mod, "_run_cmd", side_effect=fake_run_cmd), \
         patch.dict("sys.modules", {"torch": fake_torch}):
        r = client_factory().get("/setup/preflight").json()

    gpu = next(c for c in r["checks"] if c["id"] == "gpu")
    assert gpu["status"] == "pass", f"Expected 'pass' but got '{gpu['status']}': {gpu['detail']}"
    assert "CUDA ready" in gpu["detail"]
    assert r["device"]["gpu_available"] is True
    assert r["device"]["gpu_backend"] == "cuda"


def test_preflight_no_gpu_at_all_shows_warn():
    """When no GPU tools or torch.cuda, should warn (not fail)."""
    import platform as _p
    if sys.platform == "darwin" and _p.machine() == "arm64":
        pytest.skip("apple-silicon branch returns before fallback")
    from api.routers.setup import wizard as setup_mod
    from types import SimpleNamespace

    def fake_run_cmd(args, timeout=2.0):
        return -1, ""

    fake_torch = SimpleNamespace(
        cuda=SimpleNamespace(
            is_available=lambda: False,
            get_device_name=lambda idx: "",
        ),
        version=SimpleNamespace(hip=None),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
    )

    with patch.object(setup_mod, "_run_cmd", side_effect=fake_run_cmd), \
         patch.dict("sys.modules", {"torch": fake_torch}):
        info = setup_mod._detect_gpu()

    assert info["available"] is False
    assert info["backend"] == "cpu"


# ── Network probe ────────────────────────────────────────────────────────

def test_preflight_network_handles_offline():
    """_probe_network must gracefully return False on connection error."""
    from api.routers.setup.wizard import _probe_network
    # Deliberately unreachable host:port
    assert _probe_network(host="10.255.255.1", timeout=0.3) is False


def test_preflight_network_unreachable_is_warn_not_blocker():
    """A dead network must NOT hard-block the wizard (restricted-network
    first-run, e.g. China where huggingface.co is blocked): the check is a
    warning and the aggregate `ok` is unaffected by it."""
    from api.routers.setup import wizard as setup_mod

    with patch.object(setup_mod, "_probe_network", return_value=False):
        body = client_factory().get("/setup/preflight").json()

    net = next(c for c in body["checks"] if c["id"] == "network")
    assert net["status"] == "warn", net
    assert "continue" in (net["fix"] or "").lower()
    # ok must still equal "no fail among checks" — network can't be the fail.
    any_fail = any(c["status"] == "fail" for c in body["checks"])
    assert body["ok"] is (not any_fail)


def test_preflight_network_probes_configured_mirror():
    """With HF_ENDPOINT set, the probe targets the mirror host — not the
    hardcoded official host that may be blocked on the user's network."""
    import os
    from api.routers.setup import wizard as setup_mod

    seen_hosts: list[str] = []

    def fake_probe(host="huggingface.co", port=443, timeout=2.0):
        seen_hosts.append(host)
        return True

    with patch.dict(os.environ, {"HF_ENDPOINT": "https://mirror.example.test"}), \
         patch.object(setup_mod, "_probe_network", side_effect=fake_probe):
        body = client_factory().get("/setup/preflight").json()

    net = next(c for c in body["checks"] if c["id"] == "network")
    assert "mirror.example.test" in net["label"]
    assert net["status"] == "pass"
    assert "mirror.example.test" in seen_hosts


def test_preflight_network_suggests_reachable_mirror():
    """Official endpoint blocked but hf-mirror.com reachable → the fix names
    the mirror and the check carries mirror_reachable=True for the wizard's
    quick-pick affordance."""
    from api.routers.setup import wizard as setup_mod

    def fake_probe(host="huggingface.co", port=443, timeout=2.0):
        return host == "hf-mirror.com"

    with patch.object(setup_mod, "_probe_network", side_effect=fake_probe):
        body = client_factory().get("/setup/preflight").json()

    net = next(c for c in body["checks"] if c["id"] == "network")
    assert net["status"] == "warn"
    assert net.get("mirror_reachable") is True
    assert "hf-mirror.com" in (net["fix"] or "")


# ── RAM thresholds ───────────────────────────────────────────────────────

def test_preflight_ram_fail_threshold():
    """Below _RAM_FAIL_GB → fail status in the RAM check."""
    from api.routers.setup import wizard as setup_mod

    with patch.object(setup_mod, "_ram_gb", return_value=4.0):
        r = client_factory().get("/setup/preflight").json()
    ram = next(c for c in r["checks"] if c["id"] == "ram")
    assert ram["status"] == "fail"


def test_preflight_ram_warn_threshold():
    """Between fail and warn thresholds → warn."""
    from api.routers.setup import wizard as setup_mod

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
