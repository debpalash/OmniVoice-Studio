"""MCP session-manager start must never wedge backend startup (#632).

On Apple-Silicon M1 the FastMCP Streamable-HTTP session manager could *hang* on
its anyio task group during lifespan startup. Because that enter is awaited
before `yield`, the hang meant "Application startup complete" never fired and the
whole backend was unreachable with no error. The start is now timeout-bounded:
a hang becomes a logged warning + a backend that still serves (without MCP).
"""
import asyncio
import contextlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from main import _enter_mcp_session_manager, _mcp_start_timeout_s  # noqa: E402


class _CM:
    def __init__(self, hang):
        self.hang = hang

    async def __aenter__(self):
        if self.hang:
            await asyncio.sleep(60)  # never completes within the test timeout
        return self

    async def __aexit__(self, *a):
        return False


class _SM:
    def __init__(self, hang):
        self.hang = hang

    def run(self):
        return _CM(self.hang)


def _run(sm, timeout):
    async def go():
        async with contextlib.AsyncExitStack() as stack:
            return await _enter_mcp_session_manager(stack, sm, timeout=timeout)
    return asyncio.run(go())


def test_hang_times_out_and_continues():
    # The whole point: a hanging manager returns False fast, never raises.
    assert _run(_SM(hang=True), 0.2) is False


def test_healthy_manager_mounts():
    assert _run(_SM(hang=False), 5.0) is True


def test_none_manager_is_noop():
    assert _run(None, 5.0) is False


def test_timeout_env_override(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_MCP_START_TIMEOUT_S", "12.5")
    assert _mcp_start_timeout_s() == 12.5
    monkeypatch.delenv("OMNIVOICE_MCP_START_TIMEOUT_S", raising=False)
    assert _mcp_start_timeout_s() == 30.0
    monkeypatch.setenv("OMNIVOICE_MCP_START_TIMEOUT_S", "garbage")
    assert _mcp_start_timeout_s() == 30.0  # invalid → safe default
