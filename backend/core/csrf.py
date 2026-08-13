"""Exact-origin CSRF checks for ambient browser authentication."""

from __future__ import annotations

import os
from urllib.parse import SplitResult, urlsplit


CSRF_HEADER = "x-voicestudio-csrf"
CSRF_VALUE = "1"
SAFE_HTTP_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

_FORWARDED_PROTO_HEADER = "x-forwarded-proto"


def effective_scheme(connection) -> str:
    """Scheme of the client-facing hop: the resolved scope, TLS-upgraded by proxy evidence.

    Behind a TLS-terminating proxy (Tailscale Serve — the flagship remote-GPU
    deployment in docs/remote-gpu.md — nginx, Caddy, ...) the browser talks
    ``https`` while the backend hop is plain ``http``. uvicorn's
    ProxyHeadersMiddleware (on by default in both launch paths: ``uvicorn.run``
    in backend/main.py and the Docker ``python -m uvicorn`` entrypoint) already
    rewrites the ASGI scope from ``X-Forwarded-Proto``, but only when the peer
    is in ``--forwarded-allow-ips`` (default: loopback). That covers Serve on
    bare metal, and we prefer that signal — the scope is consulted first — but
    it misses Docker (the proxy connects from the bridge gateway) and any other
    non-loopback proxy topology, so the header is honored here as well.

    Spoofing analysis — why honoring it never weakens a check: the upgrade is
    one-way. ``https``/``wss`` as the first forwarded value promotes ``http``
    to ``https``; every other value is ignored, so a forged header can never
    downgrade a genuine TLS hop. For the exact-origin comparison the host:port
    half of the tuple is untouched, a browser cannot attach X-Forwarded-Proto
    cross-site without a CORS preflight this API never grants, and a
    non-browser client able to forge the header can already forge Origin
    itself — it gains nothing. For cookies the upgrade can only ADD the Secure
    flag (a Secure cookie set over plain http is simply dropped by the
    browser — the spoofer only breaks their own session), never strip it.
    """
    url = getattr(connection, "url", None)
    scheme = getattr(url, "scheme", None)
    if not scheme:
        scope = getattr(connection, "scope", None)
        scheme = scope.get("scheme", "http") if isinstance(scope, dict) else "http"
    scheme = {"ws": "http", "wss": "https"}.get(scheme, scheme)
    if scheme != "https":
        headers = getattr(connection, "headers", None) or {}
        forwarded = (
            headers.get(_FORWARDED_PROTO_HEADER, "") if hasattr(headers, "get") else ""
        )
        if forwarded.split(",")[0].strip().lower() in {"https", "wss"}:
            scheme = "https"
    return scheme


def _origin_tuple(value: str | None) -> tuple[str, str, int | None] | None:
    if not value or value == "null":
        return None
    try:
        parsed: SplitResult = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if (
        not parsed.scheme
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        return None
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https", "tauri"}:
        return None
    if port is None:
        if scheme == "http":
            port = 80
        elif scheme == "https":
            port = 443
    return scheme, parsed.hostname.lower(), port


def configured_allowed_origins() -> frozenset[tuple[str, str, int | None]]:
    raw_port = os.environ.get("OMNIVOICE_UI_PORT", "3901")
    try:
        ui_port = int(raw_port)
    except (TypeError, ValueError):
        ui_port = 3901
    values = os.environ.get(
        "OMNIVOICE_ALLOWED_ORIGINS",
        f"http://localhost:{ui_port},http://127.0.0.1:{ui_port},"
        "tauri://localhost,http://tauri.localhost",
    ).split(",")
    return frozenset(
        origin
        for value in values
        if (origin := _origin_tuple(value.strip())) is not None
    )


def _destination_origin(connection) -> tuple[str, str, int | None] | None:
    scheme = effective_scheme(connection)
    url = getattr(connection, "url", None)
    netloc = getattr(url, "netloc", None)
    if netloc:
        return _origin_tuple(f"{scheme}://{netloc}")
    scope = getattr(connection, "scope", None)
    headers = getattr(connection, "headers", None) or {}
    if not isinstance(scope, dict):
        return None
    host = headers.get("host", "") if hasattr(headers, "get") else ""
    return _origin_tuple(f"{scheme}://{host}")


def origin_allowed(connection) -> bool:
    headers = getattr(connection, "headers", None) or {}
    origin_value = headers.get("origin", "") if hasattr(headers, "get") else ""
    presented = _origin_tuple(origin_value)
    if presented is None:
        return False
    return presented == _destination_origin(connection) or presented in configured_allowed_origins()


def cookie_csrf_allowed(connection, *, side_effectful_get: bool = False) -> bool:
    headers = getattr(connection, "headers", None) or {}
    marker = headers.get(CSRF_HEADER, "") if hasattr(headers, "get") else ""
    if marker != CSRF_VALUE or not origin_allowed(connection):
        return False
    method = getattr(connection, "method", None)
    if method is None:
        scope = getattr(connection, "scope", None)
        method = scope.get("method", "GET") if isinstance(scope, dict) else "GET"
    method = str(method).upper()
    if side_effectful_get or method in SAFE_HTTP_METHODS:
        fetch_site = headers.get("sec-fetch-site", "") if hasattr(headers, "get") else ""
        return fetch_site == "same-origin"
    return True
