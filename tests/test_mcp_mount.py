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


def _mount_paths(app) -> set[str]:
    from starlette.routing import Mount
    return {r.path for r in app.routes if isinstance(r, Mount)}


def test_main_mounts_mcp_route(monkeypatch):
    """Importing main wires the /mcp mount.

    Inspect app.routes rather than driving a TestClient — running the app
    lifespan starts the FastMCP session manager, which binds asyncio queues
    to the test's event loop and contaminates later lifespan-running tests
    ("bound to a different event loop"). The mount happens at import time.

    Reload main with the disable flag cleared so this is independent of any
    earlier test that reloaded main (e.g. with OMNIVOICE_MCP_DISABLE set).
    """
    monkeypatch.delenv("OMNIVOICE_MCP_DISABLE", raising=False)
    import importlib
    import main as _main
    importlib.reload(_main)
    assert "/mcp" in _mount_paths(_main.app)


def test_mcp_disable_env_skips_mount(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_MCP_DISABLE", "1")
    import importlib
    import main as _main
    importlib.reload(_main)
    try:
        assert "/mcp" not in _mount_paths(_main.app)
    finally:
        # Restore the default app so other tests see /mcp mounted again.
        monkeypatch.delenv("OMNIVOICE_MCP_DISABLE", raising=False)
        importlib.reload(_main)
