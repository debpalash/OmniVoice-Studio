"""`require_loopback` gate contract (issue #261).

The gate must stay strict on the desktop build (non-loopback → 403, which is the
PR #81 trust boundary), but become a no-op in the headless Docker server mode,
where Docker's NAT makes the loopback origin unenforceable and exposure is
governed by the port mapping + the share PIN instead.
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.dependencies import require_loopback


def _req(host):
    """Minimal stand-in for a Starlette Request — the gate only reads client.host."""
    return SimpleNamespace(client=SimpleNamespace(host=host) if host else None)


@pytest.fixture(autouse=True)
def _clear_server_mode(monkeypatch):
    # Start each test from the desktop default regardless of the ambient env.
    monkeypatch.delenv("OMNIVOICE_SERVER_MODE", raising=False)


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "localhost"])
def test_loopback_always_allowed(host):
    require_loopback(_req(host))  # must not raise


def test_non_loopback_rejected_by_default():
    with pytest.raises(HTTPException) as exc:
        require_loopback(_req("172.17.0.1"))  # Docker bridge gateway
    assert exc.value.status_code == 403
    assert "loopback" in str(exc.value.detail).lower()


def test_missing_client_rejected_by_default():
    with pytest.raises(HTTPException):
        require_loopback(_req(None))


@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "on"])
def test_server_mode_allows_non_loopback(monkeypatch, val):
    monkeypatch.setenv("OMNIVOICE_SERVER_MODE", val)
    require_loopback(_req("172.17.0.1"))  # must not raise
    require_loopback(_req("127.0.0.1"))   # loopback still fine


@pytest.mark.parametrize("val", ["0", "false", "no", "", "off"])
def test_falsey_server_mode_keeps_gate_strict(monkeypatch, val):
    monkeypatch.setenv("OMNIVOICE_SERVER_MODE", val)
    with pytest.raises(HTTPException):
        require_loopback(_req("10.0.0.5"))
