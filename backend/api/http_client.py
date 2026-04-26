"""Shared HTTP client for outbound calls (HuggingFace, etc).

Import the singleton ``http`` wherever you need to make external HTTP calls:

    from api.http_client import http
    resp = await http.get("https://huggingface.co/api/...")

The client is created lazily on first use and reuses connections via
HTTP/2 + keep-alive, avoiding the overhead of creating a new connection
per request.
"""
from __future__ import annotations

import httpx

# Singleton — created lazily, shared across all async endpoints.
_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    """Return the shared httpx client, creating it on first call."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            limits=httpx.Limits(
                max_connections=20,
                max_keepalive_connections=10,
                keepalive_expiry=30.0,
            ),
            follow_redirects=True,
            http2=False,  # HuggingFace Hub doesn't support h2 consistently
        )
    return _client


async def close_http_client() -> None:
    """Close the shared client. Call during app shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


# Convenience alias
http = property(lambda self: get_http_client())
