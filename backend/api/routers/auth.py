"""Short-lived credentials for the first-party remote administration UI."""

from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from core.auth import (
    CredentialTransport,
    PrincipalKind,
    authorization_credential_present,
    legacy_master_cookie_valid,
    master_header_valid,
    principal_for,
    remote_api_key,
)
from core.csrf import cookie_csrf_allowed, effective_scheme
from services.admin_sessions import (
    SESSION_TTL_SECONDS,
    WS_TICKET_TTL_SECONDS,
    admin_session_store,
)


router = APIRouter(prefix="/api/auth", tags=["auth"])

_FAILED_EXCHANGE_LIMIT = 10
_FAILED_EXCHANGE_WINDOW_SECONDS = 60
_MAX_TRACKED_CLIENTS = 1024


class _ExchangeAttemptLimiter:
    """Bounded per-client sliding window for failed pre-auth exchanges."""

    def __init__(
        self,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        limit: int = _FAILED_EXCHANGE_LIMIT,
        window_seconds: int = _FAILED_EXCHANGE_WINDOW_SECONDS,
        max_clients: int = _MAX_TRACKED_CLIENTS,
    ) -> None:
        if limit <= 0 or window_seconds <= 0 or max_clients <= 0:
            raise ValueError("rate-limit bounds must be positive")
        self._monotonic = monotonic
        self._limit = limit
        self._window_seconds = window_seconds
        self._max_clients = max_clients
        self._attempts: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def register_failure(self, client_id: str) -> int | None:
        now = self._monotonic()
        cutoff = now - self._window_seconds
        with self._lock:
            failures = self._attempts.setdefault(client_id, deque())
            while failures and failures[0] <= cutoff:
                failures.popleft()
            self._attempts.move_to_end(client_id)
            while len(self._attempts) > self._max_clients:
                self._attempts.popitem(last=False)
            if len(failures) >= self._limit:
                return max(
                    1,
                    math.ceil(self._window_seconds - (now - failures[0])),
                )
            failures.append(now)
            return None

    def clear(self, client_id: str) -> None:
        with self._lock:
            self._attempts.pop(client_id, None)

    def reset(self) -> None:
        with self._lock:
            self._attempts.clear()


_exchange_attempt_limiter = _ExchangeAttemptLimiter()


class SessionRequest(BaseModel):
    transport: Literal["cookie", "bearer"]


class WebSocketTicketRequest(BaseModel):
    path: str


def _secure_cookie(request: Request) -> bool:
    # Same effective-scheme logic as the exact-origin CSRF check: the resolved
    # scope first (uvicorn's trusted-proxy rewrite), upgraded — never
    # downgraded — by X-Forwarded-Proto for TLS-terminating proxies uvicorn
    # doesn't trust (Tailscale Serve into Docker, etc.). Spoofing the header on
    # a plain-http hop can only ADD the Secure flag, which fails safe: the
    # browser drops such a cookie, so the spoofer only breaks their own
    # session. See core.csrf.effective_scheme for the full analysis.
    return effective_scheme(request) == "https"


def _set_session_cookie(response: Response, request: Request, token: str, expires_at: float) -> None:
    response.set_cookie(
        "ov_session",
        token,
        max_age=SESSION_TTL_SECONDS,
        expires=datetime.fromtimestamp(expires_at, tz=UTC),
        path="/",
        secure=_secure_cookie(request),
        httponly=True,
        samesite="strict",
    )


def _expire_cookie(response: Response, request: Request, name: str) -> None:
    response.delete_cookie(
        name,
        path="/",
        secure=_secure_cookie(request),
        httponly=name == "ov_session",
        samesite="strict",
    )


def _client_id(request: Request) -> str:
    host = request.client.host if request.client else "unknown"
    return str(host).strip().lower()[:255] or "unknown"


def _reject_master_exchange(request: Request) -> None:
    retry_after = _exchange_attempt_limiter.register_failure(_client_id(request))
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail="Too many authentication attempts",
            headers={"Retry-After": str(retry_after)},
        )
    raise HTTPException(status_code=401, detail="API key required")


@router.post("/session")
def create_session(payload: SessionRequest, request: Request) -> Response:
    configured = remote_api_key()
    if not configured:
        raise HTTPException(status_code=401, detail="API key required")

    authorization_present = authorization_credential_present(request)
    header_authorized = master_header_valid(request)
    legacy_authorized = legacy_master_cookie_valid(request)
    migrating_legacy = False

    if authorization_present:
        if not header_authorized:
            _reject_master_exchange(request)
    elif legacy_authorized:
        if payload.transport != "cookie" or not cookie_csrf_allowed(request):
            raise HTTPException(status_code=403, detail="browser origin rejected")
        migrating_legacy = True
    else:
        _reject_master_exchange(request)

    _exchange_attempt_limiter.clear(_client_id(request))
    issued = admin_session_store.issue(configured)
    if payload.transport == "bearer":
        return JSONResponse(
            {
                "token": issued.token,
                "expires_at": issued.expires_at,
                "expires_in": SESSION_TTL_SECONDS,
            },
            status_code=201,
        )

    response = Response(status_code=204)
    _set_session_cookie(response, request, issued.token, issued.expires_at)
    if migrating_legacy or request.cookies.get("ov_key"):
        _expire_cookie(response, request, "ov_key")
    return response


@router.delete("/session", status_code=204)
def delete_session(request: Request) -> Response:
    principal = principal_for(request)
    if principal.kind is PrincipalKind.ADMIN_SESSION:
        if (
            principal.transport is CredentialTransport.COOKIE
            and not cookie_csrf_allowed(request)
        ):
            raise HTTPException(status_code=403, detail="browser origin rejected")
        admin_session_store.revoke_by_credential(principal.credential_id)
    response = Response(status_code=204)
    _expire_cookie(response, request, "ov_session")
    return response


@router.post("/ws-ticket")
def create_ws_ticket(payload: WebSocketTicketRequest, request: Request) -> JSONResponse:
    principal = principal_for(request)
    if principal.kind is not PrincipalKind.ADMIN_SESSION:
        raise HTTPException(status_code=403, detail="admin session required")
    if (
        principal.transport is CredentialTransport.COOKIE
        and not cookie_csrf_allowed(request)
    ):
        raise HTTPException(status_code=403, detail="browser origin rejected")
    try:
        ticket = admin_session_store.issue_ws_ticket_for_credential(
            principal.credential_id,
            payload.path,
            remote_api_key(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except PermissionError:
        raise HTTPException(status_code=401, detail="admin session required") from None
    return JSONResponse(
        {
            "ticket": ticket.token,
            "expires_at": ticket.expires_at,
            "expires_in": WS_TICKET_TTL_SECONDS,
        },
        status_code=201,
    )
