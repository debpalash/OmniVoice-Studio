"""#64 — the configurable models-dir settings endpoints (validate + persist +
write the durable env that main.py reads at startup)."""
from __future__ import annotations

import os

import fastapi
import pytest

from core import user_env
from api.routers import settings as s


@pytest.fixture
def env(tmp_path, monkeypatch):
    # Resolve the durable env file via a process-global override so it survives
    # module re-import: some tests/backend/* tests stub `core.*` in sys.modules,
    # which can give the endpoint's `core.user_env` and this test's a *different*
    # module object — a setattr monkeypatch wouldn't reach the endpoint's copy.
    monkeypatch.setenv("OMNIVOICE_ENV_FILE", str(tmp_path / "env"))
    store: dict[str, str] = {}
    monkeypatch.setattr("services.settings_store.get_text", lambda k, d="": store.get(k, d))
    monkeypatch.setattr("services.settings_store.set_text", lambda k, v: store.__setitem__(k, v))
    return store


def test_set_persists_and_writes_durable_env(env, tmp_path):
    target = str(tmp_path / "models")
    res = s.set_models_dir(s._ModelsDirBody(path=target))
    abs_target = os.path.abspath(target)
    assert res["configured"] == abs_target
    assert res["restart_required"] is True
    assert env["storage.models_dir"] == abs_target
    # main.py reads this on next launch:
    assert user_env.get_user_env("OMNIVOICE_CACHE_DIR") == abs_target
    assert os.path.isdir(target)


def test_rejects_unwritable_dir(env):
    with pytest.raises(fastapi.HTTPException) as ei:
        s.set_models_dir(s._ModelsDirBody(path="/dev/null/cannot/mkdir/here"))
    assert ei.value.status_code == 400


def test_rejects_path_with_null_byte(env):
    # An embedded NUL would otherwise blow up os.makedirs with a ValueError
    # (→ 500). Validate up front and return a clean 400 instead.
    with pytest.raises(fastapi.HTTPException) as ei:
        s.set_models_dir(s._ModelsDirBody(path="/tmp/mo\x00dels"))
    assert ei.value.status_code == 400


def test_clear_reverts_to_default(env):
    env["storage.models_dir"] = "/old"
    user_env.set_user_env("OMNIVOICE_CACHE_DIR", "/old")
    res = s.set_models_dir(s._ModelsDirBody(path=""))
    assert res["configured"] is None
    assert res["restart_required"] is True
    assert env["storage.models_dir"] == ""
    assert user_env.get_user_env("OMNIVOICE_CACHE_DIR") is None


def test_get_shape(env):
    env["storage.models_dir"] = "/configured"
    res = s.get_models_dir()
    assert res["configured"] == "/configured"
    assert "effective" in res and "default" in res
