"""HF mirror (HF_ENDPOINT) setting — Wave 4.3. Pure, prefs stubbed."""
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import importlib

import pytest


@pytest.fixture
def settings_mod(monkeypatch):
    store = {}
    import core.user_env as ue
    monkeypatch.setattr(ue, "get_user_env", lambda k, path=None: store.get(k))
    monkeypatch.setattr(ue, "set_user_env", lambda k, v, path=None: store.__setitem__(k, v))
    monkeypatch.setattr(ue, "unset_user_env", lambda k, path=None: store.pop(k, None))
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    return importlib.import_module("api.routers.settings")


def test_get_default_empty(settings_mod):
    st = settings_mod.get_hf_mirror()
    assert st["configured"] == "" and st["effective"] == ""
    assert any(p["url"] == "https://hf-mirror.com" for p in st["presets"])


def test_set_and_clear(settings_mod):
    st = settings_mod.set_hf_mirror(settings_mod._HFMirrorBody(url="https://hf-mirror.com/"))
    assert st["configured"] == "https://hf-mirror.com"  # trailing slash trimmed
    assert st["restart_required"] is True
    assert os.environ["HF_ENDPOINT"] == "https://hf-mirror.com"
    assert settings_mod.get_hf_mirror()["configured"] == "https://hf-mirror.com"

    settings_mod.set_hf_mirror(settings_mod._HFMirrorBody(url=""))
    assert settings_mod.get_hf_mirror()["configured"] == ""
    assert "HF_ENDPOINT" not in os.environ


def test_rejects_non_http(settings_mod):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        settings_mod.set_hf_mirror(settings_mod._HFMirrorBody(url="hf-mirror.com"))
    assert ei.value.status_code == 400
