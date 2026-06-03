"""
Shared FastAPI dependencies.

These are intentionally tiny — one concern per dependency — so they can be
composed at the route or router level without surprises.

Currently exposed:
- `require_loopback`: 403 unless the request came from a loopback origin
  (bypassed in explicit server mode — see `_server_mode`).
"""

import os

from fastapi import HTTPException, Request


# IPv4 + IPv6 loopback literals + the conventional `localhost` hostname.
# `request.client.host` carries an address, not a hostname, so the literal
# "localhost" entry is defensive — some upstream wrappers (TestClient with
# a custom client tuple, certain reverse-proxy headers) may pass strings
# rather than parsed addresses. We accept the broader set without weakening
# the guard: nothing here matches a non-loopback origin.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})

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

    In server mode (Docker, see `_server_mode`) the gate is a no-op: the
    loopback origin is unenforceable there and exposure is governed by the
    deployment's port mapping + the optional share PIN instead.
    """
    host = request.client.host if request.client else None
    if host in _LOOPBACK_HOSTS:
        return
    if _server_mode():
        return
    raise HTTPException(status_code=403, detail="loopback origin required")
