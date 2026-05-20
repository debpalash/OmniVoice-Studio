"""
Shared FastAPI dependencies.

These are intentionally tiny — one concern per dependency — so they can be
composed at the route or router level without surprises.

Currently exposed:
- `require_loopback`: 403 unless the request came from a loopback origin.
"""

from fastapi import HTTPException, Request


# IPv4 + IPv6 loopback literals + the conventional `localhost` hostname.
# `request.client.host` carries an address, not a hostname, so the literal
# "localhost" entry is defensive — some upstream wrappers (TestClient with
# a custom client tuple, certain reverse-proxy headers) may pass strings
# rather than parsed addresses. We accept the broader set without weakening
# the guard: nothing here matches a non-loopback origin.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


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
    """
    host = request.client.host if request.client else None
    if host not in _LOOPBACK_HOSTS:
        raise HTTPException(status_code=403, detail="loopback origin required")
