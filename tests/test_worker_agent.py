"""Worker mode: the bootstrap-trust step and the opt-in gate.

The security-critical moment in the whole feature is here. A worker has nothing
to validate the control plane's self-signed certificate against except the
fingerprint inside its enrollment token, so this is the one place where a
mismatch must stop everything rather than warn.
"""
from __future__ import annotations

import asyncio
import socket
import ssl
import threading

import pytest

from worker import agent, identity, tls


@pytest.fixture
def control_plane_tls(tmp_path):
    """A throwaway TLS listener presenting a real certificate."""
    creds = tls.generate_self_signed(hostnames=["localhost", "127.0.0.1"])
    cert_file = tmp_path / "c.pem"
    key_file = tmp_path / "k.pem"
    cert_file.write_bytes(creds.certificate_pem)
    key_file.write_bytes(creds.private_key_pem)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert_file), str(key_file))

    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)
    port = listener.getsockname()[1]
    stop = threading.Event()

    def _serve():
        while not stop.is_set():
            try:
                raw, _ = listener.accept()
            except OSError:
                return
            try:
                with context.wrap_socket(raw, server_side=True):
                    pass
            except OSError:
                pass

    thread = threading.Thread(target=_serve, daemon=True)
    thread.start()
    try:
        yield creds, f"localhost:{port}"
    finally:
        stop.set()
        listener.close()


# ── The opt-in gate ────────────────────────────────────────────────────────


def test_worker_mode_is_off_by_default(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_WORKER_MODE", raising=False)
    assert agent.worker_mode_enabled() is False


@pytest.mark.parametrize("value,expected", [("1", True), ("true", True), ("on", True),
                                            ("0", False), ("", False), ("no", False)])
def test_worker_mode_env_gate(monkeypatch, value, expected):
    monkeypatch.setenv("OMNIVOICE_WORKER_MODE", value)
    assert agent.worker_mode_enabled() is expected


@pytest.mark.asyncio
async def test_start_if_worker_mode_is_a_no_op_when_off(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_WORKER_MODE", raising=False)
    started = []
    monkeypatch.setattr(agent.agent, "start", lambda **k: started.append(True))
    await agent.start_if_worker_mode()
    assert started == []


@pytest.mark.asyncio
async def test_a_failing_agent_never_takes_the_app_down(monkeypatch):
    """A machine that cannot reach its control plane is still a perfectly good
    OmniVoice install for whoever is sitting at it."""
    monkeypatch.setenv("OMNIVOICE_WORKER_MODE", "1")

    async def _boom(**kwargs):
        raise ConnectionError("no route to host")

    monkeypatch.setattr(agent.agent, "start", _boom)
    await agent.start_if_worker_mode()  # must not raise


# ── Trust on first use ─────────────────────────────────────────────────────


def test_certificate_is_fetched_from_a_live_server(control_plane_tls):
    creds, endpoint = control_plane_tls
    fetched = agent.fetch_server_certificate(endpoint)
    assert fetched.startswith(b"-----BEGIN CERTIFICATE-----")

    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    presented = x509.load_pem_x509_certificate(fetched)
    assert tls.pin_matches(
        presented.public_bytes(serialization.Encoding.DER), creds.fingerprint
    )


def test_matching_fingerprint_pins_the_certificate(control_plane_tls, tmp_path):
    creds, endpoint = control_plane_tls
    token = identity.mint_enrollment_token(
        endpoint=endpoint, cert_fingerprint=creds.fingerprint
    )
    path = str(tmp_path / "pinned.crt")

    resolved_endpoint, certificate = agent.pin_certificate(token.encode(), cert_path=path)

    assert resolved_endpoint == endpoint
    assert certificate.startswith(b"-----BEGIN CERTIFICATE-----")
    with open(path, "rb") as fh:
        assert fh.read() == certificate


def test_a_mismatched_fingerprint_stops_everything(control_plane_tls, tmp_path):
    """The café-network substitution. A warn-and-continue here would make the
    entire pinning design decorative."""
    _creds, endpoint = control_plane_tls
    impostor = tls.generate_self_signed(hostnames=["localhost"])
    token = identity.mint_enrollment_token(
        endpoint=endpoint, cert_fingerprint=impostor.fingerprint
    )
    path = str(tmp_path / "pinned.crt")

    with pytest.raises(ValueError, match="does not match"):
        agent.pin_certificate(token.encode(), cert_path=path)

    import os

    assert not os.path.exists(path), "a rejected certificate must never be pinned"


def test_an_expired_token_is_refused_before_any_connection(tmp_path):
    token = identity.mint_enrollment_token(
        endpoint="127.0.0.1:1", cert_fingerprint="ab" * 32, ttl_seconds=-1
    )
    with pytest.raises(ValueError, match="expired"):
        agent.pin_certificate(token.encode(), cert_path=str(tmp_path / "p.crt"))


def test_a_malformed_endpoint_is_rejected():
    with pytest.raises(ValueError, match="host:port"):
        agent.fetch_server_certificate("no-port-here")


# ── Enrollment state ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_starting_without_enrollment_explains_what_to_do(monkeypatch, tmp_path):
    """The error has to name the next action; "not enrolled" alone is a wall."""
    monkeypatch.delenv("OMNIVOICE_WORKER_TOKEN", raising=False)
    monkeypatch.delenv("OMNIVOICE_WORKER_ENDPOINT", raising=False)
    monkeypatch.setattr(
        agent,
        "_paths",
        lambda: {
            "root": str(tmp_path),
            "worker_key": str(tmp_path / "worker.key"),
            "pinned_cert": str(tmp_path / "absent.crt"),
            "worker_id": str(tmp_path / "worker-id"),
        },
    )

    with pytest.raises(RuntimeError, match="has not been enrolled"):
        await agent.WorkerAgent().start()


# ── What the agent hands the client ────────────────────────────────────────


class _FakeClient:
    """Stands in for WorkerClient; records what the agent constructed it with."""

    last = None

    def __init__(self, config, **hooks):
        type(self).last = self
        self.config = config
        self.hooks = hooks
        self.stopped = False

    async def run_forever(self):
        await asyncio.Event().wait()

    async def stop(self):
        self.stopped = True


class _RegisteringClient(_FakeClient):
    """Completes enrollment, then remains alive like the real dial-out loop."""

    async def run_forever(self):
        self.advertised_capabilities = self.hooks["capability_probe"]()
        self.hooks["on_registered"]("headless-worker")
        await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_environment_only_startup_enrolls_and_advertises_capabilities(
    monkeypatch, tmp_path
):
    """A headless host needs only the two documented environment variables."""
    from worker import capabilities
    from worker.transport import client as transport

    expected_capabilities = [
        {
            "engine": "indextts",
            "model_id": "indextts:default",
            "operations": ["tts", "clone"],
            "supported": True,
            "installed": True,
            "downloaded": True,
        }
    ]
    locations = {
        "root": str(tmp_path),
        "worker_key": str(tmp_path / "worker.key"),
        "pinned_cert": str(tmp_path / "control-plane.pinned.crt"),
        "worker_id": str(tmp_path / "worker-id"),
    }
    remembered = []

    def _pin(token_text):
        assert token_text == "ovw_headless"
        (tmp_path / "control-plane.pinned.crt").write_bytes(b"pinned certificate")
        return "studio.internal:7443", b"pinned certificate"

    monkeypatch.setenv("OMNIVOICE_WORKER_MODE", "1")
    monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", "ovw_headless")
    monkeypatch.delenv("OMNIVOICE_WORKER_ENDPOINT", raising=False)
    monkeypatch.setattr(agent, "_paths", lambda: locations)
    monkeypatch.setattr(agent, "pin_certificate", _pin)
    monkeypatch.setattr(agent, "_remember_endpoint", remembered.append)
    monkeypatch.setattr(capabilities, "discover", lambda **_: expected_capabilities)
    monkeypatch.setattr(capabilities, "describe_gpus", lambda: [{"vendor": "nvidia"}])
    monkeypatch.setattr(transport, "WorkerClient", _RegisteringClient)
    _RegisteringClient.last = None
    instance = agent.WorkerAgent()
    monkeypatch.setattr(agent, "agent", instance)

    try:
        await agent.start_if_worker_mode()
        await instance.wait_until_registered(timeout=1)
    finally:
        await instance.stop()

    assert remembered == ["studio.internal:7443"]
    assert (tmp_path / "worker-id").read_text(encoding="utf-8") == "headless-worker"
    assert (tmp_path / "enrollment-token.sha256").read_text(encoding="ascii") == (
        agent._token_hash("ovw_headless")
    )
    assert _RegisteringClient.last.config.enrollment_token == "ovw_headless"
    assert _RegisteringClient.last.config.capabilities == expected_capabilities
    assert _RegisteringClient.last.advertised_capabilities == expected_capabilities


@pytest.mark.asyncio
async def test_a_consumed_environment_token_is_not_redeemed_after_restart(
    monkeypatch, enrolled, tmp_path
):
    """Compose keeps its environment across restarts; the join code is one-use."""
    from worker import capabilities

    (tmp_path / "worker-id").write_text("headless-worker", encoding="utf-8")
    (tmp_path / "enrollment-token.sha256").write_text(
        agent._token_hash("ovw_already_spent"), encoding="ascii"
    )
    monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", "ovw_already_spent")
    monkeypatch.setattr(capabilities, "discover", lambda **_: [])

    def _redeem_again(_token):
        raise AssertionError("a persisted one-use token was redeemed twice")

    monkeypatch.setattr(agent, "pin_certificate", _redeem_again)

    instance = agent.WorkerAgent()
    try:
        await instance.start()
    finally:
        await instance.stop()

    assert enrolled.last.config.worker_id == "headless-worker"
    assert enrolled.last.config.enrollment_token == ""


@pytest.mark.asyncio
async def test_a_fresh_environment_token_reenrolls_an_existing_worker(
    monkeypatch, enrolled, tmp_path
):
    """Changing the Compose token must recover a revoked or moved worker."""
    from worker import capabilities

    (tmp_path / "worker-id").write_text("headless-worker", encoding="utf-8")
    (tmp_path / "enrollment-token.sha256").write_text(
        agent._token_hash("ovw_old"), encoding="ascii"
    )
    monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", "ovw_fresh")
    monkeypatch.setattr(capabilities, "discover", lambda **_: [])
    redeemed = []

    def _redeem(token_text):
        redeemed.append(token_text)
        return "new-studio.internal:7443", b"new pinned certificate"

    monkeypatch.setattr(agent, "pin_certificate", _redeem)

    instance = agent.WorkerAgent()
    try:
        await instance.start()
    finally:
        await instance.stop()

    assert redeemed == ["ovw_fresh"]
    assert enrolled.last.config.enrollment_token == "ovw_fresh"


@pytest.fixture
def enrolled(monkeypatch, tmp_path):
    """An already-enrolled worker whose client is a stand-in."""
    from worker.transport import client as transport

    (tmp_path / "control-plane.pinned.crt").write_bytes(b"-----BEGIN CERTIFICATE-----\n")
    monkeypatch.setenv("OMNIVOICE_WORKER_ENDPOINT", "127.0.0.1:1")
    monkeypatch.delenv("OMNIVOICE_WORKER_TOKEN", raising=False)
    monkeypatch.setattr(
        agent,
        "_paths",
        lambda: {
            "root": str(tmp_path),
            "worker_key": str(tmp_path / "worker.key"),
            "pinned_cert": str(tmp_path / "control-plane.pinned.crt"),
            "worker_id": str(tmp_path / "worker-id"),
        },
    )
    monkeypatch.setattr(transport, "WorkerClient", _FakeClient)
    _FakeClient.last = None
    return _FakeClient


@pytest.mark.asyncio
async def test_engines_present_but_not_downloaded_are_still_advertised(
    monkeypatch, enrolled
):
    """Otherwise "this worker has no such engine" and "it has it but the weights
    are missing" are the same silence, and the control plane can never offer
    the download that would unblock the job."""
    from worker import capabilities

    seen = []
    monkeypatch.setattr(
        capabilities,
        "discover",
        lambda **kwargs: seen.append(kwargs) or [{"engine": "indextts"}],
    )

    instance = agent.WorkerAgent()
    try:
        await instance.start()
        # The reconnect probe must ask the same question as the first one, or a
        # reconnect quietly drops every not-yet-downloaded engine.
        enrolled.last.hooks["capability_probe"]()
    finally:
        await instance.stop()

    assert seen == [{"include_unavailable": True}, {"include_unavailable": True}]


@pytest.mark.asyncio
async def test_the_worker_releases_engines_it_has_stopped_using(monkeypatch, enrolled):
    """Requirement 6. A machine lending its GPU is usually not the one its owner
    is sitting at — holding several GB against a task that may never come is
    pure cost."""
    from services import tts_backend
    from worker import capabilities

    monkeypatch.setattr(capabilities, "discover", lambda **_: [])
    monkeypatch.setattr(agent, "IDLE_SWEEP_INTERVAL_SECONDS", 0.01)
    swept = asyncio.Event()
    monkeypatch.setattr(
        tts_backend, "release_idle_engines", lambda *a, **k: swept.set() or []
    )

    instance = agent.WorkerAgent()
    try:
        await instance.start()
        await asyncio.wait_for(swept.wait(), timeout=2)
        sweep = instance._idle_sweep
    finally:
        await instance.stop()

    assert sweep.cancelled() or sweep.done(), "the sweep outlives the agent"


@pytest.mark.asyncio
async def test_remote_sweep_does_not_unload_during_local_gpu_work(monkeypatch, enrolled):
    """The same process may serve a local user and remote assignments."""
    from services import model_manager, tts_backend
    from worker import capabilities

    monkeypatch.setattr(capabilities, "discover", lambda **_: [])
    monkeypatch.setattr(agent, "IDLE_SWEEP_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(
        model_manager, "gpu_pool_stats", lambda: {"running": 1, "queued": 0}
    )
    unloaded = []
    monkeypatch.setattr(tts_backend, "release_idle_engines", lambda: unloaded.append(1))

    instance = agent.WorkerAgent()
    try:
        await instance.start()
        await asyncio.sleep(0.05)
    finally:
        await instance.stop()

    assert unloaded == []


@pytest.mark.asyncio
async def test_a_failing_sweep_never_takes_the_worker_down(monkeypatch, enrolled):
    """The agent's standing promise: a machine that cannot do the extra thing is
    still a perfectly good worker."""
    from services import tts_backend
    from worker import capabilities

    monkeypatch.setattr(capabilities, "discover", lambda **_: [])
    monkeypatch.setattr(agent, "IDLE_SWEEP_INTERVAL_SECONDS", 0.01)
    calls = []

    def _boom(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("driver wedged")

    monkeypatch.setattr(tts_backend, "release_idle_engines", _boom)

    instance = agent.WorkerAgent()
    try:
        await instance.start()
        while len(calls) < 2:
            await asyncio.sleep(0.01)
        assert not instance._idle_sweep.done()
    finally:
        await instance.stop()
