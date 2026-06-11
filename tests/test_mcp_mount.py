"""MCP server mount + tool surface (Wave 2.2).

The build/tool-surface checks need only the FastMCP server (no `main`, so no
torch — these run locally). The mount-on-main check imports `main` and is
validated in CI (local torch/Triton segfault on main-importing tests).
"""
import asyncio
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest

mcp_pkg = pytest.importorskip("mcp")  # skip cleanly if the optional dep is absent


def test_server_builds_with_expected_tools():
    from mcp_server import create_mcp_server

    server = create_mcp_server()
    names = {t.name for t in asyncio.run(server.list_tools())}
    # v1 surface: speak, transcribe, and the read-only listers.
    assert {"generate_speech", "transcribe", "list_voices", "list_personalities",
            "list_languages", "check_health"} <= names


def test_streamable_app_serves_at_root_for_submounting():
    from mcp_server import create_mcp_server

    server = create_mcp_server()
    app = server.streamable_http_app()
    # streamable_http_path was set to "/" so a mount at "/mcp" lands at "/mcp"
    # (not the double-prefixed "/mcp/mcp").
    paths = [getattr(r, "path", None) for r in app.routes]
    assert "/" in paths
    assert server.session_manager is not None


def test_main_mounts_mcp_route():
    """Importing main wires /mcp; a GET returns a transport error, not 404."""
    from fastapi.testclient import TestClient
    from main import app

    with TestClient(app) as client:
        r = client.get("/mcp")
        # 404 would mean the mount didn't happen. The streamable transport
        # answers a bare GET with 4xx (needs session negotiation) — that's a
        # live route.
        assert r.status_code != 404


def test_mcp_disable_env_skips_mount(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_MCP_DISABLE", "1")
    import importlib
    import main as _main
    importlib.reload(_main)
    from fastapi.testclient import TestClient
    with TestClient(_main.app) as client:
        assert client.get("/mcp").status_code == 404  # not mounted
    # Re-import without the flag so other tests see the default app again.
    monkeypatch.delenv("OMNIVOICE_MCP_DISABLE", raising=False)
    importlib.reload(_main)
