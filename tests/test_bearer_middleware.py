"""BearerKeyMiddleware — remote-backend API key gate (Wave 2.3).

Mirrors tests/test_network_middleware.py: a TestClient with a chosen client
address exercises the loopback bypass, the SPA-shell exemption, and the
401-without / pass-with-key paths. The env var is the switch.
"""
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest


@pytest.fixture
def key_env(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_API_KEY", "s3cret-key")
    yield "s3cret-key"


def _client(addr=("10.0.0.5", 1)):
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app, client=addr)


def test_inert_without_env(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_API_KEY", raising=False)
    c = _client()  # non-loopback
    assert c.get("/health").status_code == 200


def test_loopback_bypasses_key(key_env):
    c = _client(("127.0.0.1", 1))
    assert c.get("/system/info").status_code == 200


def test_non_loopback_without_key_401(key_env):
    c = _client()
    r = c.get("/v1/audio/voices")
    assert r.status_code == 401
    assert r.json()["detail"] == "API key required"


def test_non_loopback_with_bearer_passes(key_env):
    c = _client()
    r = c.get("/v1/audio/voices", headers={"Authorization": "Bearer s3cret-key"})
    assert r.status_code != 401


def test_query_param_key_passes(key_env):
    c = _client()
    r = c.get("/v1/audio/voices?api_key=s3cret-key")
    assert r.status_code != 401


def test_wrong_key_401(key_env):
    c = _client()
    r = c.get("/v1/audio/voices", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_shell_paths_served_without_key(key_env):
    c = _client()
    assert c.get("/health").status_code == 200


def test_middleware_is_plain_asgi():
    from starlette.middleware.base import BaseHTTPMiddleware
    from main import BearerKeyMiddleware
    assert not issubclass(BearerKeyMiddleware, BaseHTTPMiddleware)
    assert callable(getattr(BearerKeyMiddleware, "__call__", None))


def test_ws_handshake_rejected_without_key(key_env):
    """A non-loopback WS handshake without the key is closed, not accepted."""
    c = _client()
    with pytest.raises(Exception):
        with c.websocket_connect("/ws/transcribe"):
            pass


def test_ws_handshake_accepted_with_query_key(key_env):
    c = _client()
    # ws_remote_authorized reads ?api_key; the capture handler then accepts.
    with c.websocket_connect("/ws/transcribe?api_key=s3cret-key") as ws:
        ws.close()
