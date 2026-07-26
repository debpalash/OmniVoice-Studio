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
    # v1 surface: speak, clone, transcribe, and the read-only listers.
    assert {"generate_speech", "clone_voice", "transcribe", "list_voices", "list_personalities",
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


# ── clone_voice input helpers (#1195 review) ────────────────────────────────
# Pure helpers, no MCP SDK needed: agents commonly prepend data URIs, and the
# stored ref clip's extension must match the actual container.

def test_decode_ref_audio_strips_data_uri_prefix():
    import base64 as b64
    from mcp_server import _decode_ref_audio
    body = b64.b64encode(b"RIFFxxxxWAVE").decode()
    assert _decode_ref_audio(f"data:audio/wav;base64,{body}") == b"RIFFxxxxWAVE"
    assert _decode_ref_audio(body) == b"RIFFxxxxWAVE"


def test_decode_ref_audio_rejects_garbage_without_raising():
    from mcp_server import _decode_ref_audio
    assert _decode_ref_audio("not!!valid@@base64") is None
    assert _decode_ref_audio("data:audio/wav;base64,%%%") is None


@pytest.mark.parametrize("raw,ext", [
    (b"RIFFxxxxWAVEfmt ", ".wav"),
    (b"fLaC\x00\x00\x00\x22", ".flac"),
    (b"ID3\x04rest-of-mp3", ".mp3"),
    (b"\xff\xfb\x90\x00mp3-frame", ".mp3"),
    (b"OggS\x00vorbis", ".ogg"),
    (b"\x00\x00\x00 ftypM4A ", ".m4a"),
    (b"???unknown-container", ".wav"),  # documented default
])
def test_sniff_audio_ext_matches_magic_bytes(raw, ext):
    from mcp_server import _sniff_audio_ext
    assert _sniff_audio_ext(raw) == ext


def test_mcp_allowed_hosts_env_extends_allowlist(monkeypatch):
    """OMNIVOICE_MCP_ALLOWED_HOSTS must extend the transport-security allowlist."""
    from mcp_server import create_mcp_server

    monkeypatch.setenv("OMNIVOICE_MCP_ALLOWED_HOSTS", "host.containers.internal:*,10.0.0.1:*")
    server = create_mcp_server()
    allowed = server.settings.transport_security.allowed_hosts
    assert "host.containers.internal:*" in allowed
    assert "10.0.0.1:*" in allowed
    origins = server.settings.transport_security.allowed_origins
    assert "http://host.containers.internal:*" in origins
    assert "https://host.containers.internal:*" in origins
