"""Pinned HTTP transport for explicitly configured local/trusted services."""
from __future__ import annotations

import http.client
import re
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

from api.dependencies import is_local_host


class UnsafeEndpoint(ValueError):
    """The configured endpoint is outside VoiceStudio's trusted networks."""


@dataclass(frozen=True)
class ResolvedEndpoint:
    scheme: str
    host: str
    port: int
    ip: str


_IP_PREFIX_HOST_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}\.")


def resolve_trusted_endpoint(url: str) -> ResolvedEndpoint:
    """Validate and resolve a root HTTP(S) endpoint to one trusted address.

    Loopback is trusted by default. Non-loopback targets require an explicit
    match in ``OMNIVOICE_TRUSTED_NETWORKS``, the same policy used for remote
    inference consumers. Every DNS answer must be trusted; mixed answers are
    rejected rather than choosing a convenient one.
    """
    try:
        parsed = urlsplit(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except (TypeError, ValueError) as exc:
        raise UnsafeEndpoint("invalid endpoint URL") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.hostname.lower().startswith("localhost.")
        or _IP_PREFIX_HOST_RE.match(parsed.hostname)
    ):
        raise UnsafeEndpoint("endpoint must be a credential-free HTTP(S) origin")
    try:
        answers = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise UnsafeEndpoint("endpoint host could not be resolved") from exc
    ips = list(dict.fromkeys(answer[4][0] for answer in answers))
    if not ips or any(not is_local_host(ip) for ip in ips):
        raise UnsafeEndpoint("endpoint is outside loopback or OMNIVOICE_TRUSTED_NETWORKS")
    return ResolvedEndpoint(parsed.scheme, parsed.hostname, port, ips[0])


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, endpoint: ResolvedEndpoint, timeout: float):
        super().__init__(endpoint.host, endpoint.port, timeout=timeout)
        self._pinned_ip = endpoint.ip

    def connect(self) -> None:
        self.sock = self._create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, endpoint: ResolvedEndpoint, timeout: float):
        super().__init__(endpoint.host, endpoint.port, timeout=timeout)
        self._pinned_ip = endpoint.ip

    def connect(self) -> None:
        sock = self._create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address
        )
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def open_trusted_endpoint(
    base_url: str,
    *,
    method: str,
    query: str = "",
    timeout: float,
) -> http.client.HTTPResponse:
    """Open one request without redirects, pinned to the validated DNS answer."""
    endpoint = resolve_trusted_endpoint(base_url)
    conn_cls = _PinnedHTTPSConnection if endpoint.scheme == "https" else _PinnedHTTPConnection
    conn = conn_cls(endpoint, timeout)
    target = "/" + (f"?{query}" if query else "")
    # Let http.client format the authority from the validated host and port.
    # Supplying the hostname ourselves drops non-default ports and IPv6
    # brackets, which can make Host-aware inference servers misroute requests.
    conn.request(method, target)
    response = conn.getresponse()
    # Redirects are never followed: a configured inference origin must answer
    # directly, so a Location header cannot escape the validated connection.
    if 300 <= response.status < 400:
        response.close()
        conn.close()
        raise UnsafeEndpoint("endpoint redirects are not allowed")
    if response.status >= 400:
        response.close()
        conn.close()
        raise OSError(f"endpoint returned HTTP {response.status}")
    return response
