"""GPT-SoVITS outbound requests stay on loopback or explicit trusted CIDRs."""
import importlib
import socket

import pytest


@pytest.fixture
def outbound_http():
    return importlib.import_module("services.outbound_http")


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
def test_rejects_non_origin_and_host_spoof_urls(outbound_http, monkeypatch, url):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    with pytest.raises(outbound_http.UnsafeEndpoint):
        outbound_http.resolve_trusted_endpoint(url)


def test_private_network_requires_explicit_existing_trust_policy(outbound_http, monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("192.168.4.20"))
    monkeypatch.delenv("OMNIVOICE_TRUSTED_NETWORKS", raising=False)
    with pytest.raises(outbound_http.UnsafeEndpoint):
        outbound_http.resolve_trusted_endpoint("http://gptsovits.lan:9880")

    monkeypatch.setenv("OMNIVOICE_TRUSTED_NETWORKS", "192.168.4.0/24")
    endpoint = outbound_http.resolve_trusted_endpoint("http://gptsovits.lan:9880")
    assert endpoint.ip == "192.168.4.20"


def test_mixed_dns_answers_are_rejected(outbound_http, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_TRUSTED_NETWORKS", "10.0.0.0/8")
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: _answer("10.2.3.4") + _answer("169.254.169.254"),
    )
    with pytest.raises(outbound_http.UnsafeEndpoint):
        outbound_http.resolve_trusted_endpoint("http://gptsovits.internal:9880")


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


class _CaptureSocket:
    def __init__(self):
        self.chunks = []

    def sendall(self, data):
        self.chunks.append(data)


@pytest.mark.parametrize(
    ("connection_kind", "endpoint_args", "expected_host"),
    [
        (
            "http",
            ("http", "127.0.0.1", 80, "127.0.0.1"),
            b"Host: 127.0.0.1\r\n",
        ),
        (
            "http",
            ("http", "localhost", 9880, "127.0.0.1"),
            b"Host: localhost:9880\r\n",
        ),
        (
            "http",
            ("http", "::1", 9880, "::1"),
            b"Host: [::1]:9880\r\n",
        ),
        (
            "https",
            ("https", "localhost", 443, "127.0.0.1"),
            b"Host: localhost\r\n",
        ),
    ],
)
def test_http_client_builds_complete_host_authority(
    outbound_http, connection_kind, endpoint_args, expected_host
):
    connection_cls = (
        outbound_http._PinnedHTTPSConnection
        if connection_kind == "https"
        else outbound_http._PinnedHTTPConnection
    )
    endpoint = outbound_http.ResolvedEndpoint(*endpoint_args)
    connection = connection_cls(endpoint, timeout=2)
    capture = _CaptureSocket()
    connection.sock = capture

    connection.request("GET", "/")

    wire = b"".join(capture.chunks)
    assert expected_host in wire


def test_valid_endpoint_is_pinned_to_the_single_validated_dns_answer(
    outbound_http, monkeypatch
):
    calls = 0

    def changing_dns(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return _answer("127.0.0.1" if calls == 1 else "169.254.169.254")

    _Connection.instances.clear()
    monkeypatch.setattr(socket, "getaddrinfo", changing_dns)
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    response = outbound_http.open_trusted_endpoint(
        "http://localhost:9880", method="POST", query="text=hello", timeout=5
    )

    connection = _Connection.instances[0]
    assert calls == 1
    assert connection.endpoint.ip == "127.0.0.1"
    assert connection.request_args[0] == ("POST", "/?text=hello")
    assert connection.request_args[1] == {}
    assert response.status == 200


def test_redirect_is_rejected_without_following_location(outbound_http, monkeypatch):
    _Connection.instances.clear()
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _answer("127.0.0.1"))
    monkeypatch.setattr(outbound_http, "_PinnedHTTPConnection", _Connection)
    original_init = _Connection.__init__

    def redirecting_init(self, endpoint, timeout):
        original_init(self, endpoint, timeout)
        self.response = _Response(302)

    monkeypatch.setattr(_Connection, "__init__", redirecting_init)
    with pytest.raises(outbound_http.UnsafeEndpoint, match="redirects"):
        outbound_http.open_trusted_endpoint(
            "http://127.0.0.1:9880", method="GET", timeout=2
        )
    assert _Connection.instances[0].closed is True


def test_gptsovits_availability_uses_valid_configured_endpoint(
    outbound_http, monkeypatch
):
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
