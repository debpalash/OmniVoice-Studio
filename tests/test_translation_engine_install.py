"""The engine Install chip must target the interpreter the backend runs under.

#529/#527: the desktop spawns `<venv>/bin/python -m uvicorn` WITHOUT exporting
VIRTUAL_ENV, so bare `uv pip install` finds no venv and 500s with "No virtual
environment found". run_pip must pass `--python sys.executable`.
"""
import asyncio
import sys

from services import translation_engines as te


class _FakeProc:
    returncode = 0

    async def communicate(self):
        return (b"ok", b"")


def _run_capturing(monkeypatch, args):
    """Force the uv branch + capture the spawned argv; return (rc, argv)."""
    captured = {}
    monkeypatch.setattr(te.shutil, "which", lambda name: "/usr/bin/uv" if name == "uv" else None)

    async def fake_exec(*argv, **kwargs):
        captured["argv"] = list(argv)
        return _FakeProc()

    monkeypatch.setattr(te.asyncio, "create_subprocess_exec", fake_exec)
    rc, _out = asyncio.run(te.run_pip(args))
    return rc, captured.get("argv", [])


def test_run_pip_pins_uv_install_to_sys_executable(monkeypatch):
    rc, argv = _run_capturing(monkeypatch, ["install", "deep_translator"])
    assert rc == 0
    assert argv[:3] == ["uv", "pip", "install"], argv
    assert "--python" in argv, argv
    assert argv[argv.index("--python") + 1] == sys.executable


def test_run_pip_pins_uv_uninstall_to_sys_executable(monkeypatch):
    _rc, argv = _run_capturing(monkeypatch, ["uninstall", "deep_translator"])
    assert "--python" in argv, argv
    assert argv[argv.index("--python") + 1] == sys.executable
