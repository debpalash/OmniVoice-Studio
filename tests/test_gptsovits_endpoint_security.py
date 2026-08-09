"""GPT-SoVITS outbound requests stay on loopback or explicit trusted CIDRs."""
import socket

import pytest

from services import outbound_http
from services.outbound_http import UnsafeEndpoint, open_trusted_endpoint, resolve_trusted_endpoint


def _answer(ip: str, port: int = 9880):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return [(family, socket.SOCK_STREAM, 6, "", (ip, port))]


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://127.0.0.1/resource",
        "http://127.0.0.1.evil.example:9880",
        "http://127.0.0.1@evil.example:9880",
        "http://user:secret@127.0.0.1:9880",
        "http://127.0.0.1:9880/admin",
        "http://127.0.0.1:9880/?next=http://169.254.169.254",
    ],
)
def test_rejects_non_origin_and_host_spoof_urls(monkeypatch, url):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    with pytest.raises(UnsafeEndpoint):
        resolve_trusted_endpoint(url)


def test_private_network_requires_explicit_existing_trust_policy(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("192.168.4.20"))
    monkeypatch.delenv("OMNIVOICE_TRUSTED_NETWORKS", raising=False)
    with pytest.raises(UnsafeEndpoint):
        resolve_trusted_endpoint("http://gptsovits.lan:9880")

    monkeypatch.setenv("OMNIVOICE_TRUSTED_NETWORKS", "192.168.4.0/24")
    endpoint = resolve_trusted_endpoint("http://gptsovits.lan:9880")
    assert endpoint.ip == "192.168.4.20"


def test_mixed_dns_answers_are_rejected(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_TRUSTED_NETWORKS", "10.0.0.0/8")
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: _answer("10.2.3.4") + _answer("169.254.169.254"),
    )
    with pytest.raises(UnsafeEndpoint):
        resolve_trusted_endpoint("http://gptsovits.internal:9880")


class _Response:
    def __init__(self, status=200):
        self.status = status
        self.closed = False

    def close(self):
        self.closed = True


class _Connection:
    instances = []

    def __init__(self, endpoint, timeout):
        self.endpoint = endpoint
        self.timeout = timeout
        self.request_args = None
        self.response = _Response()
        self.closed = False
        self.instances.append(self)

    def request(self, *args, **kwargs):
        self.request_args = (args, kwargs)

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


def test_valid_endpoint_is_pinned_to_the_single_validated_dns_answer(monkeypatch):
    calls = 0

    def changing_dns(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return _answer("127.0.0.1" if calls == 1 else "169.254.169.254")

    _Connection.instances.clear()
    monkeypatch.setattr(socket, "getaddrinfo", changing_dns)
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    response = open_trusted_endpoint(
        "http://localhost:9880", method="POST", query="text=hello", timeout=5
    )

    connection = _Connection.instances[0]
    assert calls == 1
    assert connection.endpoint.ip == "127.0.0.1"
    assert connection.request_args[0] == ("POST", "/?text=hello")
    assert response.status == 200


def test_redirect_is_rejected_without_following_location(monkeypatch):
    _Connection.instances.clear()
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    original_init = _Connection.__init__

    def redirecting_init(self, endpoint, timeout):
        original_init(self, endpoint, timeout)
        self.response = _Response(302)

    monkeypatch.setattr(_Connection, "__init__", redirecting_init)
    with pytest.raises(UnsafeEndpoint, match="redirects"):
        open_trusted_endpoint("http://127.0.0.1:9880", method="GET", timeout=2)
    assert _Connection.instances[0].closed is True


def test_gptsovits_availability_uses_valid_configured_endpoint(monkeypatch):
    from services.tts_backend import GPTSoVITSBackend

    calls = []

    class _ContextResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setenv("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
    monkeypatch.setattr(
        outbound_http,
        "open_trusted_endpoint",
        lambda url, **kwargs: calls.append((url, kwargs)) or _ContextResponse(),
    )

    assert GPTSoVITSBackend.is_available() == (True, "ready (server reachable)")
    assert calls == [("http://127.0.0.1:9880", {"method": "GET", "timeout": 2})]
