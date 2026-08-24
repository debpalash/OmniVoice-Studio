"""Security regressions shared by inbound and outbound worker transports."""

from __future__ import annotations

import logging
import ssl

import pytest


def test_pin_bootstrap_rejects_legacy_tls():
    from worker import tls

    context = tls.unverified_client_context()

    assert context.minimum_version >= ssl.TLSVersion.TLSv1_2
    assert context.verify_mode == ssl.CERT_NONE


@pytest.mark.asyncio
async def test_connector_never_logs_or_exposes_private_failures(monkeypatch, caplog):
    from worker.inbound.connection_string import Connection
    from worker.inbound.connector import NodeConnection

    private = "ovnode_private-secret"
    connection = NodeConnection(
        object(),
        Connection(
            host="127.0.0.1",
            port=7444,
            secret="ovnode_" + "s" * 40,
            fingerprint="a" * 64,
        ),
    )

    async def fail_once():
        connection._stop.set()
        raise RuntimeError(private)

    monkeypatch.setattr(connection, "_connect_once", fail_once)
    with caplog.at_level(logging.WARNING):
        await connection.run_forever()

    assert private not in caplog.text
    assert private not in connection.last_error


@pytest.mark.asyncio
async def test_longform_stream_returns_only_a_fixed_public_failure():
    from api.routers.audiobook import _public_longform_stream

    private = "trace /home/alice ovnode_private-secret"

    async def broken_stream():
        raise RuntimeError(private)
        yield "unreachable"

    frames = [frame async for frame in _public_longform_stream(broken_stream())]

    assert len(frames) == 1
    assert private not in frames[0]
    assert "Render failed" in frames[0]


@pytest.mark.asyncio
async def test_inbound_startup_error_is_not_returned_to_the_api(monkeypatch):
    from api.routers import workers
    from worker.inbound import service as inbound_service

    private = "bind failed at /home/alice with ovnode_private-secret"

    class Node:
        startup_error = private
        running = False
        port = 0

        async def start(self):
            return None

        def snapshot(self):
            return {}

    monkeypatch.setattr(inbound_service, "enabled_override", lambda: None)
    monkeypatch.setattr(inbound_service, "set_enabled", lambda _value: None)
    monkeypatch.setattr(inbound_service, "enabled", lambda: True)
    monkeypatch.setattr(inbound_service, "node", Node())

    with pytest.raises(workers.HTTPException) as exc:
        await workers.set_inbound_enabled(
            workers.InboundEnableRequest(enabled=True, bind="", port=0)
        )

    assert exc.value.status_code == 409
    assert private not in exc.value.detail


@pytest.mark.asyncio
async def test_live_inbound_listener_rejects_endpoint_changes_before_persisting(
    monkeypatch,
):
    from api.routers import workers
    from worker.inbound import service as inbound_service

    mutations = []

    class Node:
        running = True
        port = 7444

        async def start(self):
            raise AssertionError("a live listener must not be started in place")

    monkeypatch.setattr(inbound_service, "enabled_override", lambda: None)
    monkeypatch.setattr(inbound_service, "bind_host", lambda: "0.0.0.0")
    monkeypatch.setattr(inbound_service, "bind_port", lambda: 7444)
    monkeypatch.setattr(
        inbound_service,
        "set_bind_host",
        lambda value: mutations.append(("bind", value)),
    )
    monkeypatch.setattr(
        inbound_service,
        "set_bind_port",
        lambda value: mutations.append(("port", value)),
    )
    monkeypatch.setattr(
        inbound_service,
        "set_enabled",
        lambda value: mutations.append(("enabled", value)),
    )
    monkeypatch.setattr(inbound_service, "node", Node())

    with pytest.raises(workers.HTTPException) as exc:
        await workers.set_inbound_enabled(
            workers.InboundEnableRequest(
                enabled=True,
                bind="127.0.0.1",
                port=7445,
            )
        )

    assert exc.value.status_code == 409
    assert mutations == []
