"""Regression for #1787 (closes duplicates #1774, #1778): the generation-
timeout error told users to "raise the generation timeout" with no UI path to
do it — the only control was the `OMNIVOICE_GENERATE_TIMEOUT_S` env var, which
a desktop-installer user has no obvious way to set.

Three things this pins down:
  1. `/system/set-env` now accepts OMNIVOICE_GENERATE_TIMEOUT_S and
     OMNIVOICE_CPU_GENERATE_TIMEOUT_S, validated as positive numbers (same
     shape as the existing `_PORT_KEYS` validation), and persists them to
     prefs.json like every other PERSISTENT_KEYS entry.
  2. The persisted value is what services/model_manager.py's GPU_JOB_TIMEOUT_S
     / CPU_JOB_TIMEOUT_S capture on the next import — i.e. the same "restored
     before ml_imports" contract OMNIVOICE_PORT already relies on, so a saved
     budget really does take effect after a restart (not silently never).
  3. The public-facing timeout copy no longer recommends an action with no UI
     path.
"""
from __future__ import annotations

import os
import sys

import pytest
from fastapi.testclient import TestClient


def _loopback_client():
    from main import app
    return TestClient(app, client=("127.0.0.1", 50000))


# ── /system/set-env validation ──────────────────────────────────────────────

@pytest.mark.parametrize(
    "key", ["OMNIVOICE_GENERATE_TIMEOUT_S", "OMNIVOICE_CPU_GENERATE_TIMEOUT_S"]
)
class TestSetEnvValidation:
    def test_rejects_non_numeric(self, key):
        c = _loopback_client()
        r = c.post("/system/set-env", json={"key": key, "value": "soon"})
        assert r.status_code == 400
        assert "not a number" in r.json()["detail"]

    def test_rejects_zero(self, key):
        c = _loopback_client()
        r = c.post("/system/set-env", json={"key": key, "value": "0"})
        assert r.status_code == 400

    def test_rejects_negative(self, key):
        c = _loopback_client()
        r = c.post("/system/set-env", json={"key": key, "value": "-30"})
        assert r.status_code == 400

    def test_rejects_absurdly_large_value(self, key):
        """A fat-fingered extra digit must not hide a wedged job for days."""
        c = _loopback_client()
        r = c.post("/system/set-env", json={"key": key, "value": "50000000"})
        assert r.status_code == 400

    def test_accepts_valid_value_and_persists(self, key):
        c = _loopback_client()
        try:
            r = c.post("/system/set-env", json={"key": key, "value": "900"})
            assert r.status_code == 200
            assert r.json() == {"key": key, "set": True}
            assert os.environ.get(key) == "900"

            from core import prefs
            assert prefs.get(f"env.{key}") == "900"
        finally:
            os.environ.pop(key, None)
            from core import prefs
            prefs.delete(f"env.{key}")


# ── effective-budget behaviour: persisted value survives the next import ──

@pytest.fixture
def model_manager(monkeypatch):
    for mod_name in ("core.config", "services.model_manager"):
        if getattr(sys.modules.get(mod_name), "__file__", None) is None:
            sys.modules.pop(mod_name, None)
    import services.model_manager as mm
    return mm


def test_generate_budget_takes_effect_after_restart(model_manager, monkeypatch):
    """`generate_timeout_s` is read from module-level GPU_JOB_TIMEOUT_S, which
    is captured at import time — so the effective budget changes only once
    the (restored) env var is present BEFORE the next import, exactly what
    the "restart required" badge in Settings promises."""
    import importlib

    monkeypatch.setenv("OMNIVOICE_GENERATE_TIMEOUT_S", "111")
    mm = importlib.reload(model_manager)
    try:
        assert mm.GPU_JOB_TIMEOUT_S == 111.0
        assert mm.generate_timeout_s("short") == 111.0
    finally:
        monkeypatch.delenv("OMNIVOICE_GENERATE_TIMEOUT_S", raising=False)
        importlib.reload(mm)


def test_cpu_budget_takes_effect_after_restart(model_manager, monkeypatch):
    import importlib

    monkeypatch.setenv("OMNIVOICE_CPU_GENERATE_TIMEOUT_S", "222")
    mm = importlib.reload(model_manager)
    try:
        assert mm.CPU_JOB_TIMEOUT_S == 222.0
    finally:
        monkeypatch.delenv("OMNIVOICE_CPU_GENERATE_TIMEOUT_S", raising=False)
        importlib.reload(mm)


# ── /system/info surfaces the effective values ──────────────────────────────

def test_system_info_has_generate_timeout_fields():
    c = _loopback_client()
    body = c.get("/system/info").json()
    assert isinstance(body["generate_timeout_s"], (int, float))
    assert isinstance(body["cpu_generate_timeout_s"], (int, float))
    assert body["generate_timeout_s"] > 0
    assert body["cpu_generate_timeout_s"] > 0


# ── copy fix: the timeout message must not recommend a UI-less action ──────

def test_generation_timeout_copy_names_a_reachable_remedy():
    from core.public_errors import stream_failure

    detail = stream_failure("generation_timeout")["detail"]
    assert "raise the generation timeout" not in detail
    assert "Settings" in detail
