"""Regression tests for #480 — the durable per-user env file (in-app Settings
source of truth) must OVERRIDE a value the desktop launcher pre-injected, so a
models directory changed in Settings actually takes effect after restart.

Pure unit tests (no Tauri / no real launch); top-level ``tests/`` + runtime
module import to avoid the sys.modules-isolation collection-order leak.
"""
from __future__ import annotations

import os


def _user_env():
    from core import user_env
    return user_env


def test_user_env_overrides_preinjected_value(tmp_path, monkeypatch):
    """A value in the per-user env file must beat one a launcher (Tauri) already
    injected into the environment — the core of #480."""
    envfile = tmp_path / "env"
    envfile.write_text("OMNIVOICE_CACHE_DIR=/new/models/dir\n")
    monkeypatch.setenv("OMNIVOICE_ENV_FILE", str(envfile))
    # simulate Tauri injecting the OLD value before the backend loads the file
    monkeypatch.setenv("OMNIVOICE_CACHE_DIR", "/old/models/dir")

    loaded = _user_env().load_into_environ()

    assert loaded is True
    assert os.environ["OMNIVOICE_CACHE_DIR"] == "/new/models/dir"


def test_user_env_sets_value_absent_from_environ(tmp_path, monkeypatch):
    """When nothing was pre-injected, the file value is applied as-is."""
    envfile = tmp_path / "env"
    envfile.write_text("OMNIVOICE_CACHE_DIR=/chosen/dir\n")
    monkeypatch.setenv("OMNIVOICE_ENV_FILE", str(envfile))
    monkeypatch.delenv("OMNIVOICE_CACHE_DIR", raising=False)

    assert _user_env().load_into_environ() is True
    assert os.environ["OMNIVOICE_CACHE_DIR"] == "/chosen/dir"


def test_user_env_missing_file_is_noop(tmp_path, monkeypatch):
    """No file -> no-op, and a pre-injected value is left untouched."""
    monkeypatch.setenv("OMNIVOICE_ENV_FILE", str(tmp_path / "does-not-exist"))
    monkeypatch.setenv("OMNIVOICE_CACHE_DIR", "/old")

    assert _user_env().load_into_environ() is False
    assert os.environ["OMNIVOICE_CACHE_DIR"] == "/old"
