"""
Shared FastAPI dependencies.

These are intentionally tiny — one concern per dependency — so they can be
composed at the route or router level without surprises.

Currently exposed:
- `require_loopback`: 403 unless the request came from a loopback origin
  (bypassed in explicit server mode — see `_server_mode`).
- `require_native_access`: true-loopback-only access to the host filesystem;
  unlike `require_loopback`, it is never bypassed by server mode.
- `ws_remote_authorized`: whether a WebSocket handshake from a non-loopback
  client carries the remote API key (Wave 2.3) — used by WS endpoints that
  keep their own inline loopback guards.
"""

import ipaddress
import os
import secrets

from fastapi import HTTPException, Request


# IPv4 + IPv6 loopback literals + the conventional `localhost` hostname.
# `request.client.host` carries an address, not a hostname, so the literal
# "localhost" entry is defensive — some upstream wrappers (TestClient with
# a custom client tuple, certain reverse-proxy headers) may pass strings
# rather than parsed addresses. We accept the broader set without weakening
# the guard: nothing here matches a non-loopback origin.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


def _trusted_networks():
    """CIDR networks from OMNIVOICE_TRUSTED_NETWORKS (comma-separated) treated as
    loopback-trusted — e.g. a reverse proxy or self-hosted LAN, so the API-key /
    PIN gates don't block LAN clients that can't present the credential (a proxy
    that strips the Authorization header). Read at call time (matching
    `_server_mode` / `remote_api_key`) so tests can monkeypatch the env; restart
    to apply changes in production."""
    nets = []
    for cidr in os.environ.get("OMNIVOICE_TRUSTED_NETWORKS", "").split(","):
        cidr = cidr.strip()
        if cidr:
            try:
                nets.append(ipaddress.ip_network(cidr, strict=False))
            except ValueError:
                pass  # malformed entry ignored — never wedge the auth gate
    return nets


def is_loopback(host):
    """True loopback address only (127.0.0.1, ::1, localhost) — NOT a trusted
    network. Admin gates (``require_loopback`` → ``/system/set-env``,
    ``/api/settings/*``) use this so a trusted-network CIDR exempts consumption
    (TTS / dictation) but never the RCE-class admin surface."""
    return host in _LOOPBACK_HOSTS


def is_local_host(host):
    """Loopback address, OR on a configured trusted network. The consumption
    gates (PIN/API-key middleware, WS guard) call this so a trusted LAN/proxy is
    exempted. Admin gates use :func:`is_loopback` — NOT this — to preserve the
    two-tier privilege model: consumption trust ≠ admin trust."""
    if is_loopback(host):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except (ValueError, TypeError):
        return False
    # Unwrap IPv4-mapped IPv6 (::ffff:192.168.1.5) so it matches IPv4 CIDRs —
    # dual-stack proxies (Caddy, Node.js) frequently pass the mapped form.
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    return any(ip in net for net in _trusted_networks())

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _server_mode() -> bool:
    """Whether this process is a headless server deployment (Docker image).

    In Docker the loopback gate is *unenforceable*: Docker's network NAT
    rewrites ``request.client.host`` to the bridge gateway (e.g. 172.17.0.1)
    even for a localhost-only ``-p 127.0.0.1:3900:3900`` mapping, so every
    request looks non-loopback and the gate 403s the operator out of the
    system/settings routes they need (issue #261 — incl. ``/system/info``,
    which blanks the version display).

    The Docker image sets ``OMNIVOICE_SERVER_MODE=1`` to opt out of the gate.
    Network exposure then rests on the operator's port mapping plus the
    optional share PIN (``NetworkAccessMiddleware`` still 401s unauthenticated
    non-loopback clients whenever a PIN is set). The desktop build never sets
    this, so its loopback boundary — including denying LAN share guests access
    to admin routes — is unchanged. Read at call time so it stays testable.
    """
    return os.environ.get("OMNIVOICE_SERVER_MODE", "").strip().lower() in _TRUTHY


def _configured_pin(request) -> str | None:
    """The active share PIN (``app.state.network_share.pin``) or None. Read via
    getattr so a bare Request stub (or a request that hit before lifespan set
    the state) never raises — a missing PIN just means 'no PIN gate'."""
    app = getattr(request, "app", None)
    state = getattr(app, "state", None) if app is not None else None
    ns = getattr(state, "network_share", None) if state is not None else None
    return getattr(ns, "pin", None) if ns is not None else None


def _admin_credential_configured(request) -> bool:
    """Whether the operator has set ANY credential gate — the remote API key or
    a share PIN. When neither is set, server mode leaves admin open (the Docker
    issue #261 flow the image depends on)."""
    if os.environ.get("OMNIVOICE_API_KEY"):
        return True
    return bool(_configured_pin(request))


def _request_presents_admin_credential(request) -> bool:
    """Whether the request carries a valid **API key** via the channels the
    middleware accepts (``Authorization: Bearer`` / ``?api_key`` / ``ov_key``
    cookie).

    Admin is RCE-class (``/system/set-env`` + ``/api/settings/*``), so only the
    API key — a long operator-chosen secret — unlocks it. The 6-digit share PIN
    is deliberately NOT accepted here: it is a *consumption* credential for LAN
    playback and is short enough to brute-force (10^6, no lockout), so it must
    never gate the admin surface (CodeRabbit #1213). A trusted-network CIDR
    (``is_local_host`` — also a consumption exemption) likewise never unlocks
    admin. Net: remote admin in server mode requires the API key; a PIN-only
    deployment keeps admin loopback-only. getattr-defensive so a minimal Request
    stub never raises."""
    api_key = os.environ.get("OMNIVOICE_API_KEY") or ""
    if not api_key:
        return False
    headers = getattr(request, "headers", None) or {}
    query = getattr(request, "query_params", None) or {}
    cookies = getattr(request, "cookies", None) or {}

    auth = headers.get("authorization", "")
    supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not supplied:
        supplied = query.get("api_key") or cookies.get("ov_key") or ""
    return bool(supplied and secrets.compare_digest(supplied, api_key))


def require_loopback(request: Request) -> None:
    """Reject any request whose `client.host` is not a loopback address.

    Use as a router-level dependency to protect every route on the router
    in one place:

        router = APIRouter(dependencies=[Depends(require_loopback)])

    Or as a per-route dependency for narrower scope:

        @router.post("/foo", dependencies=[Depends(require_loopback)])

    Returns None on success (FastAPI dependency convention). Raises 403
    on rejection — the response body is `{"detail": "loopback origin required"}`
    so existing tests for `/system/set-env` keep passing without modification.

    In server mode (Docker, see `_server_mode`) the loopback origin is
    unenforceable, so the gate can't require true loopback. It then applies the
    admin-credential rule instead:

    - No credential configured (no API key, no PIN) → open, matching the #261
      Docker flow where the operator reaches ``/system/*`` off the bridge
      gateway with nothing set.
    - A credential IS configured → the request must present the **API key**.
      This keeps the two-tier privilege model intact under server mode:
      ``OMNIVOICE_TRUSTED_NETWORKS`` is a *consumption* exemption
      (``is_local_host``) that bypasses the PIN / API-key middleware, and it must
      NEVER by itself unlock the admin surface (``/system/set-env`` — RCE-class —
      and ``/api/settings/*``). The 6-digit share PIN is a consumption credential
      too and does not gate admin, so a PIN-only deployment keeps admin
      loopback-only; remote admin requires the (long) API key. A LAN client in a
      trusted CIDR — or one holding only the PIN — gets 403 here even though it
      sails through the consumption gates. See docs/api-auth.md (#1213).
    """
    host = request.client.host if request.client else None
    if is_loopback(host):
        return
    if _server_mode():
        if not _admin_credential_configured(request):
            return
        if _request_presents_admin_credential(request):
            return
    raise HTTPException(status_code=403, detail="loopback origin required")


def require_admin(request: Request) -> None:
    """Gate RCE/filesystem-capable admin routers.

    Desktop callers keep the loopback-only contract. Docker cannot reliably
    observe the host operator as loopback, so authenticated remote admin stays
    available there, but every state-changing request must present the long API
    key. An unconfigured server must never expose executable-path or filesystem
    settings to every client that can reach its published port.

    Read-only requests retain the bare-Docker bootstrap behaviour until an API
    key is configured. Share PINs and trusted CIDRs are consumption credentials;
    neither authorizes this gate.
    """
    host = request.client.host if request.client else None
    if is_loopback(host):
        return
    if _server_mode():
        method = str(getattr(request, "method", "GET")).upper()
        read_only = method in {"GET", "HEAD", "OPTIONS"}
        if read_only and not os.environ.get("OMNIVOICE_API_KEY", "").strip():
            return
        if _request_presents_admin_credential(request):
            return
    raise HTTPException(status_code=403, detail="loopback origin or admin API key required")


def require_desktop(request: Request) -> None:
    """Gate capabilities that may select or execute host filesystem paths.

    An API key authorizes remote administration, not access to the desktop
    shell's native file-picker boundary.  These capabilities therefore remain
    strictly loopback-only even when server mode is enabled.
    """
    host = request.client.host if request.client else None
    if is_loopback(host):
        return
    raise HTTPException(status_code=403, detail="desktop origin required")


def require_local(request: Request) -> None:
    """Reject any request whose client.host is not loopback OR on a configured
    trusted network. The consumption-tier companion to :func:`require_loopback`:
    use on routes a trusted-network client (LAN/proxy) should reach without a PIN
    or API key — e.g. the dictation model/prefs endpoints that pair with the
    dictation WebSocket. Admin routes stay on :func:`require_loopback`.

    In server mode the gate is a no-op (same as :func:`require_loopback`)."""
    host = request.client.host if request.client else None
    if is_local_host(host):
        return
    if _server_mode():
        return
    raise HTTPException(status_code=403, detail="loopback origin required")


def require_native_access(request: Request) -> None:
    """Protect capabilities that read or write operator-chosen host paths.

    Docker server mode deliberately relaxes the ordinary admin gate because a
    bridge makes even local traffic appear remote. That exception is unsafe for
    native file pickers: a remote API caller must never probe or overwrite an
    arbitrary path on the backend host, even with the server API key.
    """
    host = request.client.host if request.client else None
    if not is_loopback(host):
        raise HTTPException(status_code=403, detail="native filesystem access requires loopback origin")


def remote_api_key() -> str | None:
    """The remote-backend bearer key (Wave 2.3), or None when remote mode is
    off. Read at call time so tests can monkeypatch the env."""
    return os.environ.get("OMNIVOICE_API_KEY") or None


def ws_remote_authorized(websocket) -> bool:
    """Whether a WebSocket handshake presents the remote API key.

    Browser WebSockets cannot set an Authorization header, so the key may
    arrive as ``?api_key=`` or via the ``ov_key`` cookie that the bearer
    middleware sets on the first authenticated HTTP request. Returns False
    when remote mode is off — callers keep their loopback-only behavior.
    """
    key = remote_api_key()
    if not key:
        return False
    auth = websocket.headers.get("authorization", "")
    supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not supplied:
        supplied = (
            websocket.query_params.get("api_key")
            or websocket.cookies.get("ov_key")
            or ""
        )
    return secrets.compare_digest(supplied, key)
