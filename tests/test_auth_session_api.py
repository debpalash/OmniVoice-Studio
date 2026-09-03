"""HTTP contract for exchanging the durable master key for UI credentials."""

from __future__ import annotations

import pytest


MASTER = "MASTER_DO_NOT_LEAK_7d29"
CSRF_HEADERS = {
    "Origin": "http://voice.test",
    "X-VoiceStudio-CSRF": "1",
}


@pytest.fixture(autouse=True)
def auth_environment(monkeypatch):
    from api.routers.auth import _exchange_attempt_limiter
    from services.admin_sessions import admin_session_store

    admin_session_store.clear()
    _exchange_attempt_limiter.reset()
    monkeypatch.setenv("OMNIVOICE_API_KEY", MASTER)
    monkeypatch.setenv("OMNIVOICE_SERVER_MODE", "1")
    monkeypatch.delenv("OMNIVOICE_TRUSTED_NETWORKS", raising=False)
    yield
    admin_session_store.clear()
    _exchange_attempt_limiter.reset()


def _client(*, https: bool = False, loopback: bool = False, host: str | None = None):
    from fastapi.testclient import TestClient
    from main import app

    scheme = "https" if https else "http"
    client_host = host or ("127.0.0.1" if loopback else "10.0.0.5")
    return TestClient(app, base_url=f"{scheme}://voice.test", client=(client_host, 1))


def _master_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {MASTER}"}


def _issue_cookie(client, *, headers: dict[str, str] | None = None):
    return client.post(
        "/api/auth/session",
        json={"transport": "cookie"},
        headers=headers or _master_headers(),
    )


def _issue_bearer(client):
    return client.post(
        "/api/auth/session",
        json={"transport": "bearer"},
        headers=_master_headers(),
    )


def test_session_exchange_fails_closed_when_master_is_not_configured(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_API_KEY", raising=False)

    response = _client().post(
        "/api/auth/session",
        json={"transport": "bearer"},
        headers={"Authorization": f"Bearer {MASTER}"},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "API key required"}
    assert response.headers["cache-control"] == "no-store"


def test_cookie_session_issuance_is_no_content_and_never_reflects_master():
    client = _client()

    response = _issue_cookie(client)

    assert response.status_code == 204
    assert response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert MASTER not in repr(dict(response.headers))
    assert MASTER not in response.text
    assert client.cookies.get("ov_session", domain="voice.test")
    assert client.cookies.get("ov_key", domain="voice.test") is None


def test_http_cookie_has_strict_bounded_attributes_without_domain_or_secure():
    response = _issue_cookie(_client())
    cookie = response.headers["set-cookie"]

    assert "ov_session=" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=strict" in cookie
    assert "Path=/" in cookie
    assert "Max-Age=28800" in cookie
    assert "expires=" in cookie.lower()
    assert "Domain=" not in cookie
    assert "Secure" not in cookie


def test_https_cookie_is_secure():
    response = _issue_cookie(_client(https=True))

    assert response.status_code == 204
    assert "Secure" in response.headers["set-cookie"]


def test_cookie_behind_tls_terminating_proxy_is_secure():
    # Tailscale Serve / reverse proxy (docs/remote-gpu.md): TLS terminates at
    # the proxy, the backend hop is plain http with X-Forwarded-Proto: https.
    response = _issue_cookie(
        _client(),
        headers={**_master_headers(), "X-Forwarded-Proto": "https"},
    )

    assert response.status_code == 204
    assert "Secure" in response.headers["set-cookie"]


def test_spoofed_forwarded_proto_cannot_strip_secure_on_real_https():
    response = _issue_cookie(
        _client(https=True),
        headers={**_master_headers(), "X-Forwarded-Proto": "http"},
    )

    assert response.status_code == 204
    assert "Secure" in response.headers["set-cookie"]


def test_https_origin_behind_tls_terminating_proxy_can_logout():
    # Exact-origin CSRF must compare against the browser-facing https origin,
    # not the plain-http backend hop, or every proxied logout 403s.
    client = _client()
    assert _issue_cookie(client).status_code == 204

    response = client.delete(
        "/api/auth/session",
        headers={
            "Origin": "https://voice.test",
            "X-VoiceStudio-CSRF": "1",
            "X-Forwarded-Proto": "https",
        },
    )

    assert response.status_code == 204


def test_bearer_transport_returns_only_short_lived_session():
    response = _issue_bearer(_client())
    payload = response.json()

    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    assert payload["token"].startswith("ovs_admin_session_")
    assert isinstance(payload["expires_at"], float)
    assert payload["expires_in"] == 8 * 60 * 60
    assert MASTER not in response.text
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong"},
        {"Authorization": "Bearer    "},
        {"X-OmniVoice-Pin": "123456"},
    ],
)
def test_missing_wrong_or_nonmaster_credential_cannot_issue_session(headers):
    response = _client().post(
        "/api/auth/session",
        json={"transport": "cookie"},
        headers=headers,
    )

    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers


def test_query_master_cannot_issue_session():
    response = _client().post(
        f"/api/auth/session?api_key={MASTER}",
        json={"transport": "cookie"},
    )

    assert response.status_code == 401
    assert "set-cookie" not in response.headers


def test_failed_exchange_is_rate_limited_per_client_without_locking_out_valid_master():
    client = _client()
    request = {
        "json": {"transport": "bearer"},
        "headers": {"Authorization": "Bearer wrong"},
    }

    for _attempt in range(10):
        assert client.post("/api/auth/session", **request).status_code == 401
    limited = client.post("/api/auth/session", **request)

    assert limited.status_code == 429
    assert 1 <= int(limited.headers["retry-after"]) <= 60
    assert limited.headers["cache-control"] == "no-store"
    assert _issue_bearer(client).status_code == 201
    assert client.post("/api/auth/session", **request).status_code == 401


def test_failed_exchange_limit_does_not_cross_client_boundaries():
    request = {
        "json": {"transport": "bearer"},
        "headers": {"Authorization": "Bearer wrong"},
    }
    first = _client(host="10.0.0.5")
    for _attempt in range(11):
        response = first.post("/api/auth/session", **request)
    assert response.status_code == 429

    assert _client(host="10.0.0.6").post("/api/auth/session", **request).status_code == 401


def test_exchange_limiter_expires_failures_on_a_monotonic_clock():
    from api.routers.auth import _ExchangeAttemptLimiter

    now = [100.0]
    limiter = _ExchangeAttemptLimiter(
        monotonic=lambda: now[0],
        limit=2,
        window_seconds=60,
        max_clients=4,
    )

    assert limiter.register_failure("client") is None
    assert limiter.register_failure("client") is None
    assert limiter.register_failure("client") == 60
    now[0] += 60
    assert limiter.register_failure("client") is None


def test_exchange_limiter_bounds_clients_and_each_failure_window():
    from api.routers.auth import _ExchangeAttemptLimiter

    limiter = _ExchangeAttemptLimiter(
        monotonic=lambda: 100.0,
        limit=2,
        window_seconds=60,
        max_clients=2,
    )

    for _attempt in range(20):
        assert limiter.register_failure("first") in (None, 60)
    limiter.register_failure("second")
    limiter.register_failure("third")

    assert list(limiter._attempts) == ["second", "third"]
    assert all(len(failures) <= 2 for failures in limiter._attempts.values())


@pytest.mark.parametrize("invalid_bound", [0, -1])
def test_exchange_limiter_rejects_nonpositive_bounds(invalid_bound):
    from api.routers.auth import _ExchangeAttemptLimiter

    with pytest.raises(ValueError, match="rate-limit bounds must be positive"):
        _ExchangeAttemptLimiter(limit=invalid_bound)


def test_loopback_still_requires_master_to_issue_session():
    response = _client(loopback=True).post(
        "/api/auth/session",
        json={"transport": "cookie"},
    )

    assert response.status_code == 401


def test_existing_session_cannot_mint_another_session():
    client = _client()
    assert _issue_cookie(client).status_code == 204

    response = client.post(
        "/api/auth/session",
        json={"transport": "cookie"},
    )

    assert response.status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"transport": "jwt"},
        {"transport": ""},
        {},
        {"transport": None},
    ],
)
def test_invalid_session_request_is_422_and_never_issues(body):
    response = _client().post(
        "/api/auth/session",
        json=body,
        headers=_master_headers(),
    )

    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers


def test_multiple_issuances_are_unique():
    client = _client()
    first = _issue_bearer(client).json()["token"]
    second = _issue_bearer(client).json()["token"]

    assert first != second


def test_cookie_session_authorizes_remote_consumption_and_admin(monkeypatch):
    from services import mcp_bindings

    monkeypatch.setattr(mcp_bindings, "list_bindings", lambda: [])
    client = _client()
    assert _issue_cookie(client).status_code == 204

    consumption = client.get("/v1/audio/voices")
    admin = client.get("/api/mcp/bindings")

    assert consumption.status_code == 200
    assert admin.status_code == 200


def test_logout_revokes_session_expires_cookie_and_is_idempotent():
    client = _client()
    assert _issue_cookie(client).status_code == 204

    first = client.delete("/api/auth/session", headers=CSRF_HEADERS)
    second = client.delete("/api/auth/session", headers=CSRF_HEADERS)

    assert first.status_code == 204
    assert second.status_code == 204
    assert first.headers["cache-control"] == "no-store"
    assert "ov_session=" in first.headers["set-cookie"]
    assert "Max-Age=0" in first.headers["set-cookie"]
    assert client.get("/v1/audio/voices").status_code == 401


def test_cookie_logout_rejects_wrong_missing_and_null_origin():
    for origin in (None, "null", "http://voice.test.evil.test"):
        client = _client()
        assert _issue_cookie(client).status_code == 204
        headers = {"X-VoiceStudio-CSRF": "1"}
        if origin is not None:
            headers["Origin"] = origin

        response = client.delete("/api/auth/session", headers=headers)

        assert response.status_code == 403


def test_cookie_logout_requires_csrf_marker():
    client = _client()
    assert _issue_cookie(client).status_code == 204

    response = client.delete(
        "/api/auth/session",
        headers={"Origin": "http://voice.test"},
    )

    assert response.status_code == 403


def test_bearer_session_logout_does_not_require_browser_origin():
    client = _client()
    token = _issue_bearer(client).json()["token"]

    response = client.delete(
        "/api/auth/session",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 204
    assert client.get(
        "/v1/audio/voices",
        headers={"Authorization": f"Bearer {token}"},
    ).status_code == 401


def test_key_rotation_rejects_session_on_next_request(monkeypatch):
    client = _client()
    token = _issue_bearer(client).json()["token"]

    monkeypatch.setenv("OMNIVOICE_API_KEY", "rotated")

    response = client.get(
        "/v1/audio/voices",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401


def test_legacy_cookie_migrates_once_with_same_origin_csrf():
    client = _client()
    client.cookies.set("ov_key", MASTER, domain="voice.test")

    response = _issue_cookie(client, headers=CSRF_HEADERS)

    assert response.status_code == 204
    cookies = response.headers.get_list("set-cookie")
    assert any(value.startswith("ov_session=") for value in cookies)
    assert any(value.startswith("ov_key=") and "Max-Age=0" in value for value in cookies)
    assert all(MASTER not in value for value in cookies)
    assert client.cookies.get("ov_key", domain="voice.test") is None


def test_empty_bearer_channel_does_not_block_legacy_cookie_migration():
    client = _client()
    client.cookies.set("ov_key", MASTER, domain="voice.test")

    response = _issue_cookie(
        client,
        headers={**CSRF_HEADERS, "Authorization": "Bearer    "},
    )

    assert response.status_code == 204
    assert client.cookies.get("ov_session", domain="voice.test") is not None
    assert client.cookies.get("ov_key", domain="voice.test") is None


def test_explicit_invalid_authorization_blocks_legacy_cookie_migration():
    client = _client()
    client.cookies.set("ov_key", MASTER, domain="voice.test")

    response = _issue_cookie(
        client,
        headers={**CSRF_HEADERS, "Authorization": "Basic not-a-master"},
    )

    assert response.status_code == 401
    assert client.cookies.get("ov_session", domain="voice.test") is None
    assert client.cookies.get("ov_key", domain="voice.test") == MASTER


@pytest.mark.parametrize("origin", [None, "null", "http://evil.test"])
def test_legacy_cookie_migration_fails_without_exact_origin(origin):
    client = _client()
    client.cookies.set("ov_key", MASTER, domain="voice.test")
    headers = {"X-VoiceStudio-CSRF": "1"}
    if origin is not None:
        headers["Origin"] = origin

    response = _issue_cookie(client, headers=headers)

    assert response.status_code == 403
    assert not any(
        value.startswith("ov_session=")
        for value in response.headers.get_list("set-cookie")
    )


@pytest.mark.parametrize(
    "path",
    ["/ws/events", "/ws/transcribe", "/ws/tts", "/v1/audio/transcriptions/stream"],
)
def test_session_can_mint_path_bound_ws_ticket(path):
    client = _client()
    token = _issue_bearer(client).json()["token"]

    response = client.post(
        "/api/auth/ws-ticket",
        json={"path": path},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["ticket"].startswith("ovs_ws_ticket_")
    assert response.json()["expires_in"] == 30
    assert token not in response.text
    assert MASTER not in response.text


def test_master_key_cannot_mint_ws_ticket():
    response = _client().post(
        "/api/auth/ws-ticket",
        json={"path": "/ws/transcribe"},
        headers=_master_headers(),
    )

    assert response.status_code == 403


@pytest.mark.parametrize(
    "path",
    ["/system/info", "ws/transcribe", "/ws/transcribe?x=1", "//evil/ws/events"],
)
def test_ws_ticket_rejects_nonallowlisted_path(path):
    client = _client()
    token = _issue_bearer(client).json()["token"]

    response = client.post(
        "/api/auth/ws-ticket",
        json={"path": path},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 422


def test_cookie_session_requires_csrf_for_ws_ticket():
    client = _client()
    assert _issue_cookie(client).status_code == 204

    missing = client.post(
        "/api/auth/ws-ticket",
        json={"path": "/ws/events"},
    )
    allowed = client.post(
        "/api/auth/ws-ticket",
        json={"path": "/ws/events"},
        headers=CSRF_HEADERS,
    )

    assert missing.status_code == 403
    assert allowed.status_code == 201


def test_cookie_session_csrf_guard_covers_all_unsafe_routes(monkeypatch):
    from api.routers import settings
    from services import token_resolver

    writes: list[str] = []
    monkeypatch.setattr(token_resolver, "save_app_token", writes.append)
    monkeypatch.setattr(settings, "_state_response", lambda: {"source": "app"})
    client = _client()
    assert _issue_cookie(client).status_code == 204

    missing = client.post("/api/settings/hf-token", json={"token": "hf_test"})
    wrong_origin = client.post(
        "/api/settings/hf-token",
        json={"token": "hf_test"},
        headers={"Origin": "http://voice.test.evil.test", "X-VoiceStudio-CSRF": "1"},
    )
    allowed = client.post(
        "/api/settings/hf-token",
        json={"token": "hf_test"},
        headers=CSRF_HEADERS,
    )

    assert missing.status_code == 403
    assert wrong_origin.status_code == 403
    assert allowed.status_code == 200
    assert writes == ["hf_test"]


def test_bearer_session_is_not_subject_to_browser_csrf_headers(monkeypatch):
    from api.routers import settings
    from services import token_resolver

    writes: list[str] = []
    monkeypatch.setattr(token_resolver, "save_app_token", writes.append)
    monkeypatch.setattr(settings, "_state_response", lambda: {"source": "app"})
    client = _client()
    token = _issue_bearer(client).json()["token"]

    response = client.post(
        "/api/settings/hf-token",
        json={"token": "hf_test"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert writes == ["hf_test"]
