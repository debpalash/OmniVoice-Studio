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
from pathlib import Path

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


class _RejectingClient(_FakeClient):
    """The candidate control plane refuses registration before the callback."""

    async def run_forever(self):
        raise RuntimeError("AUTH_FAILED: registration rejected")


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

    def _verify(token_text):
        assert token_text == "ovw_headless"
        return "studio.internal:7443", b"pinned certificate"

    monkeypatch.setenv("OMNIVOICE_WORKER_MODE", "1")
    monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", "ovw_headless")
    monkeypatch.delenv("OMNIVOICE_WORKER_ENDPOINT", raising=False)
    monkeypatch.setattr(agent, "_paths", lambda: locations)
    monkeypatch.setattr(agent, "_verify_enrollment_token", _verify)
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
        registered_readiness = instance.readiness()
    finally:
        await instance.stop()

    assert remembered == ["studio.internal:7443"]
    assert (tmp_path / "control-plane.pinned.crt").read_bytes() == b"pinned certificate"
    assert (tmp_path / "worker-id").read_text(encoding="utf-8") == "headless-worker"
    assert (tmp_path / "enrollment-token.sha256").read_text(encoding="ascii") == (
        agent._token_hash("ovw_headless")
    )
    assert _RegisteringClient.last.config.enrollment_token == "ovw_headless"
    assert _RegisteringClient.last.config.capabilities == expected_capabilities
    assert _RegisteringClient.last.advertised_capabilities == expected_capabilities
    assert registered_readiness == {"ready": True, "status": "ready"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("token", "message"),
    [
        ("", "has not been enrolled"),
        ("not-a-token", "invalid enrollment token"),
    ],
)
async def test_headless_readiness_rejects_missing_or_invalid_tokens(
    monkeypatch, tmp_path, token, message
):
    locations = {
        "root": str(tmp_path),
        "worker_key": str(tmp_path / "worker.key"),
        "pinned_cert": str(tmp_path / "control-plane.pinned.crt"),
        "worker_id": str(tmp_path / "worker-id"),
        "enrollment_token_hash": str(tmp_path / "enrollment-token.sha256"),
    }
    monkeypatch.setenv("OMNIVOICE_WORKER_MODE", "1")
    monkeypatch.delenv("OMNIVOICE_WORKER_ENDPOINT", raising=False)
    if token:
        monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", token)
        monkeypatch.setattr(
            agent,
            "_verify_enrollment_token",
            lambda _token: (_ for _ in ()).throw(ValueError(message)),
        )
    else:
        monkeypatch.delenv("OMNIVOICE_WORKER_TOKEN", raising=False)
    monkeypatch.setattr(agent, "_paths", lambda: locations)
    instance = agent.WorkerAgent()
    monkeypatch.setattr(agent, "agent", instance)

    await agent.start_if_worker_mode()

    readiness = instance.readiness()
    assert readiness["ready"] is False
    assert readiness["status"] == "failed"
    assert message in instance.last_error


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

    monkeypatch.setattr(agent, "_verify_enrollment_token", _redeem_again)

    instance = agent.WorkerAgent()
    try:
        await instance.start()
    finally:
        await instance.stop()

    assert enrolled.last.config.worker_id == "headless-worker"
    assert enrolled.last.config.enrollment_token == ""


@pytest.mark.asyncio
async def test_legacy_same_environment_token_is_not_redeemed(
    monkeypatch, enrolled, tmp_path, control_plane_tls
):
    """Upgrade a legacy Compose volume without spending its old token again."""
    from worker import capabilities
    from worker.transport import client as transport

    creds, endpoint = control_plane_tls
    token = identity.mint_enrollment_token(
        endpoint=endpoint, cert_fingerprint=creds.fingerprint
    ).encode()
    (tmp_path / "control-plane.pinned.crt").write_bytes(creds.certificate_pem)
    (tmp_path / "worker-id").write_text("headless-worker", encoding="utf-8")
    monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", token)
    monkeypatch.setenv("OMNIVOICE_WORKER_ENDPOINT", endpoint)
    monkeypatch.setattr(agent, "_stored_endpoint", lambda: endpoint)
    monkeypatch.setattr(capabilities, "discover", lambda **_: [])

    def _redeem_again(_token):
        raise AssertionError("the legacy enrollment token was redeemed twice")

    monkeypatch.setattr(agent, "_verify_enrollment_token", _redeem_again)
    monkeypatch.setattr(transport, "WorkerClient", _RegisteringClient)
    _RegisteringClient.last = None

    instance = agent.WorkerAgent()
    try:
        await instance.start()
        await instance.wait_until_registered(timeout=1)
    finally:
        await instance.stop()

    assert _RegisteringClient.last.config.enrollment_token == ""
    assert (tmp_path / "control-plane.pinned.crt").read_bytes() == creds.certificate_pem
    assert agent._load_consumed_token_hash(
        str(tmp_path / "enrollment-token.sha256")
    ) == agent._token_hash(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("replacement_kind", ["endpoint", "certificate"])
async def test_legacy_replacement_token_moves_a_non_revoked_worker(
    monkeypatch, enrolled, tmp_path, replacement_kind
):
    """An unmarked legacy volume can still adopt a distinct control plane."""
    from worker import capabilities
    from worker.transport import client as transport

    old_endpoint = "old-studio.internal:7443"
    old_creds = tls.generate_self_signed(hostnames=["old-studio.internal"])
    new_endpoint = (
        "new-studio.internal:7443"
        if replacement_kind == "endpoint"
        else old_endpoint
    )
    new_fingerprint = (
        old_creds.fingerprint if replacement_kind == "endpoint" else "ab" * 32
    )
    token = identity.mint_enrollment_token(
        endpoint=new_endpoint, cert_fingerprint=new_fingerprint
    ).encode()
    old_certificate = old_creds.certificate_pem
    (tmp_path / "control-plane.pinned.crt").write_bytes(old_certificate)
    (tmp_path / "worker-id").write_text("headless-worker", encoding="utf-8")
    monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", token)
    monkeypatch.setenv("OMNIVOICE_WORKER_ENDPOINT", old_endpoint)
    monkeypatch.setattr(agent, "_stored_endpoint", lambda: old_endpoint)
    monkeypatch.setattr(capabilities, "discover", lambda **_: [])
    verified = []
    remembered = []

    def _verify(token_text):
        verified.append(token_text)
        return new_endpoint, b"new pinned certificate"

    monkeypatch.setattr(agent, "_verify_enrollment_token", _verify)
    monkeypatch.setattr(agent, "_remember_endpoint", remembered.append)
    monkeypatch.setattr(transport, "WorkerClient", _RegisteringClient)
    _RegisteringClient.last = None

    instance = agent.WorkerAgent()
    try:
        await instance.start()
        assert (tmp_path / "control-plane.pinned.crt").read_bytes() == old_certificate
        await instance.wait_until_registered(timeout=1)
    finally:
        await instance.stop()

    assert verified == [token]
    assert _RegisteringClient.last.config.enrollment_token == token
    assert (tmp_path / "control-plane.pinned.crt").read_bytes() == b"new pinned certificate"
    assert remembered == [new_endpoint]
    assert agent._load_consumed_token_hash(
        str(tmp_path / "enrollment-token.sha256")
    ) == agent._token_hash(token)


@pytest.mark.asyncio
async def test_a_fresh_environment_token_moves_a_non_revoked_worker(
    monkeypatch, enrolled, tmp_path
):
    """Changing the Compose token can move an identity the server still accepts."""
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

    monkeypatch.setattr(agent, "_verify_enrollment_token", _redeem)

    instance = agent.WorkerAgent()
    try:
        await instance.start()
    finally:
        await instance.stop()

    assert redeemed == ["ovw_fresh"]
    assert enrolled.last.config.enrollment_token == "ovw_fresh"


@pytest.mark.asyncio
async def test_rejected_replacement_preserves_the_working_enrollment(
    monkeypatch, tmp_path, control_plane_tls
):
    """Verification may stage new trust, but rejection must commit none of it."""
    from worker import capabilities
    from worker.transport import client as transport

    replacement_creds, replacement_endpoint = control_plane_tls
    old_creds = tls.generate_self_signed(hostnames=["old-studio.internal"])
    old_endpoint = "old-studio.internal:7443"
    old_worker_id = "working-worker"
    old_token_hash = agent._token_hash("ovw_old")
    token = identity.mint_enrollment_token(
        endpoint=replacement_endpoint,
        cert_fingerprint=replacement_creds.fingerprint,
    ).encode()
    locations = {
        "root": str(tmp_path),
        "worker_key": str(tmp_path / "worker.key"),
        "pinned_cert": str(tmp_path / "control-plane.pinned.crt"),
        "worker_id": str(tmp_path / "worker-id"),
        "enrollment_token_hash": str(tmp_path / "enrollment-token.sha256"),
    }
    (tmp_path / "control-plane.pinned.crt").write_bytes(old_creds.certificate_pem)
    (tmp_path / "worker-id").write_text(old_worker_id, encoding="utf-8")
    (tmp_path / "enrollment-token.sha256").write_text(
        old_token_hash, encoding="ascii"
    )
    remembered = []
    monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", token)
    monkeypatch.delenv("OMNIVOICE_WORKER_ENDPOINT", raising=False)
    monkeypatch.setattr(agent, "_paths", lambda: locations)
    monkeypatch.setattr(agent, "_stored_endpoint", lambda: old_endpoint)
    monkeypatch.setattr(agent, "_remember_endpoint", remembered.append)
    monkeypatch.setattr(capabilities, "discover", lambda **_: [])
    monkeypatch.setattr(capabilities, "describe_gpus", lambda: [])
    monkeypatch.setattr(transport, "WorkerClient", _RejectingClient)
    _RejectingClient.last = None

    instance = agent.WorkerAgent()
    try:
        await instance.start()
        with pytest.raises(RuntimeError, match="registration rejected"):
            await instance.wait_until_registered(timeout=1)
    finally:
        await instance.stop()

    assert _RejectingClient.last.config.certificate_pem == replacement_creds.certificate_pem
    assert (tmp_path / "control-plane.pinned.crt").read_bytes() == old_creds.certificate_pem
    assert (tmp_path / "worker-id").read_text(encoding="utf-8") == old_worker_id
    assert (tmp_path / "enrollment-token.sha256").read_text(
        encoding="ascii"
    ) == old_token_hash
    assert remembered == []
    assert instance.status()["endpoint"] == old_endpoint


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "damaged_hash", ["abc123", "A" * 64, "g" * 64, ("0" * 64) + "\n"]
)
async def test_a_partial_or_corrupt_token_hash_is_treated_as_legacy_state(
    monkeypatch, enrolled, tmp_path, damaged_hash
):
    """A killed marker write must never make a spent token run again."""
    from worker import capabilities

    (tmp_path / "worker-id").write_text("headless-worker", encoding="utf-8")
    (tmp_path / "enrollment-token.sha256").write_text(
        damaged_hash, encoding="ascii"
    )
    monkeypatch.setenv("OMNIVOICE_WORKER_TOKEN", "ovw_already_spent")
    monkeypatch.setattr(capabilities, "discover", lambda **_: [])

    def _redeem_again(_token):
        raise AssertionError("corrupt legacy state retried a spent token")

    monkeypatch.setattr(agent, "_verify_enrollment_token", _redeem_again)

    instance = agent.WorkerAgent()
    try:
        await instance.start()
    finally:
        await instance.stop()

    assert agent._load_consumed_token_hash(
        str(tmp_path / "enrollment-token.sha256")
    ) == ""
    assert enrolled.last.config.enrollment_token == ""


def test_consumed_token_hash_is_replaced_atomically(monkeypatch, tmp_path):
    target = tmp_path / "enrollment-token.sha256"
    replaced = []
    real_replace = agent.os.replace

    def _replace(source, destination):
        replaced.append((source, destination))
        real_replace(source, destination)

    monkeypatch.setattr(agent.os, "replace", _replace)

    agent._save_consumed_token_hash(str(target), "ovw_once")

    assert len(replaced) == 1
    assert replaced[0][1] == str(target)
    assert Path(replaced[0][0]).parent == tmp_path
    assert agent._load_consumed_token_hash(str(target)) == agent._token_hash("ovw_once")
    assert list(tmp_path.iterdir()) == [target]


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
