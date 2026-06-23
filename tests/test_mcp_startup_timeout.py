"""MCP session-manager start must never wedge backend startup (#632).

On Apple-Silicon M1 the FastMCP Streamable-HTTP session manager could *hang* on
its anyio task group during lifespan startup. Because that enter was awaited
before `yield`, the hang meant "Application startup complete" never fired and the
whole backend was unreachable with no error. MCP now runs in its own task (it
owns the anyio enter→exit itself — task-affinity) and startup only *optionally*
waits, with a timeout, on a ready signal: a hang → a logged warning + a backend
that still serves without MCP.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from main import _start_mcp_session_manager, _mcp_start_timeout_s  # noqa: E402


class _CM:
    def __init__(self, hang, raise_on_enter=False):
        self.hang = hang
        self.raise_on_enter = raise_on_enter

    async def __aenter__(self):
        if self.raise_on_enter:
            raise RuntimeError("boom")
        if self.hang:
            await asyncio.sleep(60)  # never completes within the test timeout
        return self

    async def __aexit__(self, *a):
        return False


class _SM:
    def __init__(self, hang=False, raise_on_enter=False):
        self._cm = _CM(hang, raise_on_enter)

    def run(self):
        return self._cm


def _drive(sm, timeout):
    """Run _start_mcp_session_manager, then clean up the task; return `mounted`."""
    async def go():
        task, stop, mounted = await _start_mcp_session_manager(sm, timeout=timeout)
        stop.set()
        if task is not None:
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        return mounted
    return asyncio.run(go())


def test_hang_does_not_block_startup():
    # The crux: a hanging manager returns fast with mounted=False (no raise).
    assert _drive(_SM(hang=True), 0.2) is False


def test_healthy_manager_mounts():
    assert _drive(_SM(hang=False), 5.0) is True


def test_broken_manager_is_not_mounted():
    # An exception during enter → not mounted, startup still proceeds.
    assert _drive(_SM(raise_on_enter=True), 5.0) is False


def test_none_manager_is_noop():
    assert _drive(None, 5.0) is False


def test_timeout_env_override(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_MCP_START_TIMEOUT_S", "12.5")
    assert _mcp_start_timeout_s() == 12.5
    monkeypatch.delenv("OMNIVOICE_MCP_START_TIMEOUT_S", raising=False)
    assert _mcp_start_timeout_s() == 30.0
    monkeypatch.setenv("OMNIVOICE_MCP_START_TIMEOUT_S", "garbage")
    assert _mcp_start_timeout_s() == 30.0  # invalid → safe default
