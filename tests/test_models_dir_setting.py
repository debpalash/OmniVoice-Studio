"""#64 — the configurable models-dir settings endpoints (validate + persist +
write the durable env that main.py reads at startup).

Single source of truth: the durable per-user env file (``OMNIVOICE_CACHE_DIR``).
``main.py`` reads it at launch; the GET endpoint reads it back. There is no
second store to diverge from.
"""
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
    envfile = str(tmp_path / "env")
    monkeypatch.setenv("OMNIVOICE_ENV_FILE", envfile)
    return envfile


def test_set_persists_and_writes_durable_env(env, tmp_path):
    target = str(tmp_path / "models")
    res = s.set_models_dir(s._ModelsDirBody(path=target))
    abs_target = os.path.abspath(target)
    assert res["configured"] == abs_target
    assert res["restart_required"] is True
    # main.py reads this on next launch; GET reads it back — single source:
    assert user_env.get_user_env("OMNIVOICE_CACHE_DIR") == abs_target
    assert s.get_models_dir()["configured"] == abs_target
    assert os.path.isdir(target)


def test_rejects_unwritable_dir(env, monkeypatch, tmp_path):
    # OS-neutral: force the mkdir to fail rather than relying on Unix-only
    # /dev/null path semantics (cross-platform parity).
    def boom(*a, **k):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(os, "makedirs", boom)
    with pytest.raises(fastapi.HTTPException) as ei:
        s.set_models_dir(s._ModelsDirBody(path=str(tmp_path / "ro")))
    assert ei.value.status_code == 400


def test_rejects_path_with_null_byte(env):
    # An embedded NUL would otherwise blow up os.makedirs with a ValueError
    # (→ 500). Validate up front and return a clean 400 instead.
    with pytest.raises(fastapi.HTTPException) as ei:
        s.set_models_dir(s._ModelsDirBody(path="/tmp/mo\x00dels"))
    assert ei.value.status_code == 400


def test_clear_reverts_to_default(env):
    user_env.set_user_env("OMNIVOICE_CACHE_DIR", "/old")
    res = s.set_models_dir(s._ModelsDirBody(path=""))
    assert res["configured"] is None
    assert res["restart_required"] is True
    assert user_env.get_user_env("OMNIVOICE_CACHE_DIR") is None
    assert s.get_models_dir()["configured"] is None


def test_get_shape(env):
    user_env.set_user_env("OMNIVOICE_CACHE_DIR", "/configured")
    res = s.get_models_dir()
    assert res["configured"] == "/configured"
    assert "effective" in res and "default" in res


def test_default_is_xdg_aware(env, monkeypatch, tmp_path):
    # huggingface_hub's default cache root honors XDG_CACHE_HOME on Linux.
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    for var in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_HOME"):
        monkeypatch.delenv(var, raising=False)
    default = s.get_models_dir()["default"]
    assert default == str(tmp_path / "xdg" / "huggingface")
