from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest


@pytest.fixture
def disk_modules():
    from services import engine_disk_usage
    from services.sidecar_install import SPECS

    return engine_disk_usage, SPECS


def test_in_process_model_exposes_unknown_dependency_cost_explicitly(monkeypatch, disk_modules):
    engine_disk_usage, _ = disk_modules
    monkeypatch.setattr(engine_disk_usage, "_measure_model_cache", lambda _engine_id: None)
    usage = engine_disk_usage.disk_usage_for("omnivoice")
    assert usage["estimate"]["model_download_bytes"] > 0
    assert usage["estimate"]["package_download_bytes"] is None
    assert usage["estimate"]["confidence"] == "estimated"
    assert usage["estimate"]["destination_volume"]


def test_lightweight_optional_engine_has_weight_estimate_not_fake_package_zero(monkeypatch, disk_modules):
    engine_disk_usage, _ = disk_modules
    monkeypatch.setattr(engine_disk_usage, "_measure_model_cache", lambda _engine_id: None)
    usage = engine_disk_usage.disk_usage_for("kittentts")
    assert usage["estimate"]["model_download_bytes"] == round(0.08 * 1024**3)
    assert usage["estimate"]["package_download_bytes"] is None


def test_separate_torch_sidecar_uses_installer_build_metadata(monkeypatch, tmp_path, disk_modules):
    engine_disk_usage, SPECS = disk_modules
    spec = SPECS["indextts2"]
    monkeypatch.setattr("services.sidecar_install.DATA_DIR", tmp_path)
    usage = engine_disk_usage.disk_usage_for(spec.engine_id)
    assert usage["estimate"]["model_download_bytes"] == spec.weights_bytes
    assert usage["estimate"]["package_download_bytes"] == spec.dependency_bytes
    assert usage["estimate"]["unique_installed_bytes"] == spec.required_bytes
    assert usage["estimate"]["temporary_free_bytes"] == spec.temporary_free_bytes
    assert usage["estimate"]["deduplication"] == "uv_same_volume"


def test_installed_sidecar_reports_separate_measured_categories(monkeypatch, tmp_path, disk_modules):
    engine_disk_usage, SPECS = disk_modules
    spec = SPECS["indextts2"]
    monkeypatch.setattr("services.sidecar_install.DATA_DIR", tmp_path)
    checkout = tmp_path / "engines" / spec.engine_id / spec.checkout_dirname
    for relative, payload in (
        (Path(spec.weights_subdir) / "model.bin", b"weights"),
        (Path(".venv") / "package.py", b"environment"),
        (Path("source.py"), b"source"),
    ):
        path = checkout / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    cache = tmp_path / "engines" / ".uv-cache" / "wheel"
    cache.parent.mkdir(parents=True)
    cache.write_bytes(b"shared")

    engine_disk_usage._measurement_cache.clear()
    actual = engine_disk_usage.actual_for(spec.engine_id)
    assert actual["model_bytes"] == len(b"weights")
    assert actual["environment_bytes"] == len(b"environment")
    assert actual["cache_bytes"] == len(b"shared")
    assert actual["total_owned_bytes"] == len(b"weights") + len(b"environment") + len(b"source")
    assert actual["confidence"] == "measured"


def test_disk_measurement_route_rejects_unknown_engine(monkeypatch):
    from api.routers import engines
    from fastapi import HTTPException

    def unknown_backend(_engine_id):
        raise ValueError("unknown")

    monkeypatch.setattr(
        engines.tts_backend,
        "get_backend_class",
        unknown_backend,
    )
    with pytest.raises(HTTPException) as caught:
        engines.engine_disk_usage("unknown")
    assert caught.value.status_code == 404


def test_concurrent_disk_measurements_are_coalesced(monkeypatch, disk_modules):
    engine_disk_usage, _ = disk_modules
    calls = 0
    entered = Event()
    release = Event()

    def measure(_engine_id):
        nonlocal calls
        calls += 1
        entered.set()
        assert release.wait(timeout=1)
        return {"total_owned_bytes": 7, "confidence": "measured"}

    engine_disk_usage._measurement_cache.clear()
    monkeypatch.setattr(engine_disk_usage, "_measure_sidecar", measure)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(engine_disk_usage.actual_for, "coalesce")
        assert entered.wait(timeout=1)
        second = pool.submit(engine_disk_usage.actual_for, "coalesce")
        assert not second.done()
        release.set()
        results = [first.result(), second.result()]

    assert calls == 1
    assert [result["total_owned_bytes"] for result in results] == [7, 7]
