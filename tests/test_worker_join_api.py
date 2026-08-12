"""Joining a control plane from the app, instead of from the environment.

Before these endpoints, becoming a worker meant launching the app with
OMNIVOICE_WORKER_MODE and OMNIVOICE_WORKER_TOKEN set and relaunching — on the
machine that is usually the least convenient one to configure by hand. The
control plane could mint join codes that had nowhere to go.

What is pinned here is what makes the flow survive contact with reality:

* worker mode persists, so a machine that joined is still a worker after a
  restart — but only after a join that actually worked, or a failed enrolment
  would have the app retrying forever on every launch;
* the endpoint from the redeemed token is remembered, because the agent needs
  it to reconnect and asking the user to also set OMNIVOICE_WORKER_ENDPOINT
  would put the barrier straight back;
* a failed join answers with the reason ("that code expired"), not a bare 409,
  because the user's next action depends on which failure it was;
* the environment still wins over the setting, so a deployment that pins
  worker mode cannot be silently switched off from a UI.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.dependencies import require_loopback
from api.routers import workers as workers_router
from worker import agent as worker_agent


@pytest.fixture
def client(monkeypatch, tmp_path):
    """The workers router with the loopback guard stubbed out."""
    settings: dict[str, str] = {}

    class _Store:
        @staticmethod
        def get_text(key, default=""):
            return settings.get(key, default)

        @staticmethod
        def set_text(key, value):
            settings[key] = value

    # Both bindings: `from services import settings_store` resolves the package
    # ATTRIBUTE when another test has already imported the real module, and the
    # sys.modules entry only when it has not — patching one leaves the outcome
    # dependent on test order.
    import services

    monkeypatch.setattr(services, "settings_store", _Store, raising=False)
    monkeypatch.setitem(__import__("sys").modules, "services.settings_store", _Store)
    monkeypatch.delenv("OMNIVOICE_WORKER_MODE", raising=False)
    monkeypatch.delenv("OMNIVOICE_WORKER_ENDPOINT", raising=False)
    monkeypatch.setattr(
        worker_agent, "_paths", lambda: {"pinned_cert": str(tmp_path / "pinned.crt")}
    )

    app = FastAPI()
    app.include_router(workers_router.router)
    app.dependency_overrides[require_loopback] = lambda: None
    with TestClient(app) as c:
        yield c, settings


def _stub_agent(monkeypatch, *, fail: str = ""):
    """Replace the real agent's start/stop with recorded no-ops."""
    calls: list = []

    async def _start(*, token_text: str = "", endpoint: str = ""):
        calls.append(("start", token_text))
        if fail:
            raise RuntimeError(fail)
        worker_agent.agent.endpoint = "studio-mac:7443"

    async def _stop():
        calls.append(("stop", ""))

    monkeypatch.setattr(worker_agent.agent, "start", _start)
    monkeypatch.setattr(worker_agent.agent, "stop", _stop)
    monkeypatch.setattr(worker_agent.agent, "last_error", "")
    monkeypatch.setattr(worker_agent.agent, "endpoint", "")
    return calls


def test_status_reports_a_machine_that_has_never_joined(client):
    c, _ = client
    body = c.get("/workers/agent").json()
    assert body == {
        "worker_mode": False,
        "running": False,
        "enrolled": False,
        "endpoint": "",
        "last_error": "",
        "env_pinned": False,
    }


def test_join_redeems_the_code_and_persists_worker_mode(client, monkeypatch):
    c, settings = client
    calls = _stub_agent(monkeypatch)

    body = c.post("/workers/agent/join", json={"token": "ovw_abc123"}).json()

    assert ("start", "ovw_abc123") in calls
    # Persisted, so the machine is still a worker after a restart.
    assert settings["worker_mode_enabled"] == "true"
    assert body["worker_mode"] is True
    assert body["endpoint"] == "studio-mac:7443"


def test_join_stops_any_previous_connection_first(client, monkeypatch):
    c, _ = client
    calls = _stub_agent(monkeypatch)

    c.post("/workers/agent/join", json={"token": "ovw_abc123"})

    # Re-joining a DIFFERENT control plane must not leave the old dial-out
    # loop running against the machine the user just left.
    assert calls[0][0] == "stop"


def test_a_failed_join_answers_with_the_reason_and_stays_off(client, monkeypatch):
    c, settings = client
    _stub_agent(monkeypatch, fail="This enrollment token has expired. Generate a new one.")

    response = c.post("/workers/agent/join", json={"token": "ovw_expired"})

    assert response.status_code == 409
    assert "expired" in response.json()["detail"]
    # Never persisted: a machine that failed to enrol must not come back up
    # retrying forever.
    assert "worker_mode_enabled" not in settings
    assert c.get("/workers/agent").json()["last_error"].startswith("This enrollment token")


def test_join_rejects_an_empty_code(client, monkeypatch):
    c, _ = client
    calls = _stub_agent(monkeypatch)
    assert c.post("/workers/agent/join", json={"token": "   "}).status_code == 422
    assert calls == []


def test_stopping_clears_the_setting_but_keeps_the_enrollment(client, monkeypatch, tmp_path):
    c, settings = client
    calls = _stub_agent(monkeypatch)
    (tmp_path / "pinned.crt").write_bytes(b"cert")

    c.post("/workers/agent/join", json={"token": "ovw_abc123"})
    body = c.post("/workers/agent/enabled", json={"enabled": False}).json()

    assert ("stop", "") in calls
    assert settings["worker_mode_enabled"] == "false"
    assert body["worker_mode"] is False
    # The pinned certificate survives, which is what lets "on" resume without
    # asking for another code.
    assert body["enrolled"] is True


def test_resuming_needs_no_new_code(client, monkeypatch, tmp_path):
    c, _ = client
    calls = _stub_agent(monkeypatch)
    (tmp_path / "pinned.crt").write_bytes(b"cert")

    assert c.post("/workers/agent/enabled", json={"enabled": True}).status_code == 200
    assert ("start", "") in calls


def test_the_environment_still_wins_over_the_stored_setting(client, monkeypatch):
    c, settings = client
    _stub_agent(monkeypatch)
    c.post("/workers/agent/enabled", json={"enabled": False})
    assert settings["worker_mode_enabled"] == "false"

    monkeypatch.setenv("OMNIVOICE_WORKER_MODE", "1")

    body = c.get("/workers/agent").json()
    assert body["worker_mode"] is True
    # …and the panel is told, so it disables a switch it cannot honour.
    assert body["env_pinned"] is True


def test_the_redeemed_endpoint_is_remembered_for_the_next_launch(client, monkeypatch):
    """The token carries the address; forgetting it puts the barrier back.

    A machine that joined from the UI used to come back up enrolled but with
    nowhere to dial, and the only fix was OMNIVOICE_WORKER_ENDPOINT.
    """
    c, settings = client
    worker_agent._remember_endpoint("studio-mac:7443")

    assert settings["worker_endpoint"] == "studio-mac:7443"
    assert worker_agent._stored_endpoint() == "studio-mac:7443"
    assert c.get("/workers/agent").json()["endpoint"] == "studio-mac:7443"
