"""Windows --reload subprocess regression (issue #122 "Extract: Unknown Error").

uvicorn forces the SelectorEventLoop on Windows when use_subprocess=True
(`--reload` / multi-worker), where `asyncio.create_subprocess_exec` raises
NotImplementedError. `spawn_subprocess` must transparently fall back to a
thread-based subprocess so ffmpeg/yt-dlp/ffprobe spawns still work.
"""
from __future__ import annotations

import asyncio
import os
import sys

from services import ffmpeg_utils


def _force_notimplemented(monkeypatch):
    async def _boom(*a, **k):
        raise NotImplementedError("no subprocess on this loop (simulated Windows SelectorEventLoop)")
    monkeypatch.setattr(ffmpeg_utils.asyncio, "create_subprocess_exec", _boom)


def test_spawn_subprocess_falls_back_to_thread_on_notimplemented(monkeypatch):
    _force_notimplemented(monkeypatch)

    async def run():
        proc = await ffmpeg_utils.spawn_subprocess(
            sys.executable, "-c", "import sys; sys.stdout.write('ok')",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        return proc.returncode, out

    rc, out = asyncio.run(run())
    assert rc == 0
    assert out == b"ok"


def test_spawn_subprocess_fallback_forwards_cwd(monkeypatch, tmp_path):
    # sonitranslate's pip install passes cwd= — the thread fallback must honor it.
    _force_notimplemented(monkeypatch)

    async def run():
        proc = await ffmpeg_utils.spawn_subprocess(
            sys.executable, "-c", "import os,sys; sys.stdout.write(os.getcwd())",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=str(tmp_path),
        )
        out, _ = await proc.communicate()
        return out

    out = asyncio.run(run())
    assert os.path.realpath(out.decode()) == os.path.realpath(str(tmp_path))


def test_spawn_subprocess_fallback_passes_stdin_input(monkeypatch):
    # dub_generate's atempo pipes audio bytes via stdin → communicate(input=...).
    _force_notimplemented(monkeypatch)

    async def run():
        proc = await ffmpeg_utils.spawn_subprocess(
            sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate(input=b"abc123")
        return proc.returncode, out

    rc, out = asyncio.run(run())
    assert rc == 0
    assert out == b"abc123"


def test_spawn_subprocess_native_path_when_loop_supports_it():
    # On a loop WITH subprocess support (posix / Windows Proactor) the native
    # asyncio path is used unchanged — no behavior change off the broken loop.
    async def run():
        proc = await ffmpeg_utils.spawn_subprocess(
            sys.executable, "-c", "print('hi')",
            stdout=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        return proc.returncode, out

    rc, out = asyncio.run(run())
    assert rc == 0
    assert b"hi" in out
