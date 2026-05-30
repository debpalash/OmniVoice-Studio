import asyncio
import errno
import logging
import os
import shutil
import subprocess

logger = logging.getLogger("omnivoice.api")

# Cap concurrent ffmpeg jobs so macOS posix_spawn can't hit EAGAIN under load.
_FFMPEG_SEMAPHORE: "asyncio.Semaphore | None" = None
_FFMPEG_CONCURRENCY = 2


def _get_semaphore() -> asyncio.Semaphore:
    global _FFMPEG_SEMAPHORE
    if _FFMPEG_SEMAPHORE is None:
        _FFMPEG_SEMAPHORE = asyncio.Semaphore(_FFMPEG_CONCURRENCY)
    return _FFMPEG_SEMAPHORE


def find_ffmpeg():
    """Locate an ffmpeg binary.

    Resolution order:
      1. ``FFMPEG_PATH`` env var (set by Tauri when a sidecar is bundled).
      2. ``imageio-ffmpeg`` pip package (ships a static binary per platform).
      3. Common system paths / ``PATH``.

    Returns the path string, or ``None`` if nothing found.
    """
    # 1. Env var injected by Tauri host
    env_path = os.environ.get("FFMPEG_PATH")
    if env_path:
        resolved = shutil.which(env_path)
        if resolved:
            return resolved
    # 2. imageio-ffmpeg bundled static binary
    try:
        import imageio_ffmpeg
        candidate = imageio_ffmpeg.get_ffmpeg_exe()
        if candidate and os.path.isfile(candidate):
            return candidate
        logger.debug("imageio_ffmpeg binary not found at %s", candidate)
    except Exception as e:
        logger.debug("imageio_ffmpeg unavailable: %s", e)
    # 3. Well-known system paths + PATH lookup
    common = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        "D:\\ffmpeg\\bin\\ffmpeg.exe",
        "ffmpeg",
    ]
    for path in common:
        if shutil.which(path):
            return path
    logger.warning("ffmpeg not found in env, imageio, or system PATH")
    return None


def resolve_ffprobe() -> str | None:
    """Resolve an ffprobe binary path.

    Resolution order (per issue #76 and 01-03-PLAN.md must_haves):
      1. ``OMNIVOICE_FFPROBE_PATH`` env var — the canonical, namespaced path
         injected by Tauri pointing at the bundled sidecar (e.g.
         ``/usr/lib/omnivoice-studio/bin/ffprobe`` on .deb installs).
      2. ``FFPROBE_PATH`` env var — legacy alias kept for backward
         compatibility with older Tauri shells / dev environments.
      3. ``shutil.which("ffprobe")`` — system ``PATH`` fallback.

    Returns the resolved path string, or ``None`` if nothing found. Callers
    that need a hard failure should use :func:`find_ffprobe` instead.
    """
    for env_key in ("OMNIVOICE_FFPROBE_PATH", "FFPROBE_PATH"):
        path = os.environ.get(env_key)
        if not path:
            continue
        # The env var may carry either an absolute path to a file OR a bare
        # command name (legacy). Accept both shapes — file first.
        if os.path.isfile(path):
            return path
        resolved = shutil.which(path)
        if resolved:
            return resolved

    system_probe = shutil.which("ffprobe")
    if system_probe:
        return system_probe
    return None


def find_ffprobe():
    """Locate an ffprobe binary (legacy wrapper around :func:`resolve_ffprobe`).

    Falls back to deriving the path from ``find_ffmpeg()`` so the
    co-located ffprobe in an ffmpeg-bundle download (e.g. BtbN, evermeet.cx)
    is still picked up when only ffmpeg has been resolved.
    """
    resolved = resolve_ffprobe()
    if resolved:
        return resolved
    try:
        ffmpeg_path = find_ffmpeg()
        if ffmpeg_path:
            candidate = ffmpeg_path.replace("ffmpeg", "ffprobe")
            if os.path.isfile(candidate):
                return candidate
    except Exception:
        pass
    return None


async def _spawn_async(cmd, **kwargs):
    """Try asyncio subprocess; fall back to thread-based subprocess on Windows
    where ProactorEventLoop may not be available (e.g. under uvicorn --reload)."""
    try:
        return await asyncio.create_subprocess_exec(*cmd, **kwargs)
    except NotImplementedError:
        logger.debug("asyncio subprocess not supported, falling back to thread-based subprocess")
        return await _spawn_thread_fallback(cmd, **kwargs)


async def _spawn_thread_fallback(cmd, **kwargs):
    """Run a subprocess synchronously in a thread via subprocess.Popen."""
    stdout = kwargs.pop("stdout", asyncio.subprocess.PIPE)
    stderr = kwargs.pop("stderr", asyncio.subprocess.PIPE)
    stdin = kwargs.pop("stdin", None)
    loop = asyncio.get_running_loop()

    def _run():
        return subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE if stdout == asyncio.subprocess.PIPE else stdout,
            stderr=subprocess.PIPE if stderr == asyncio.subprocess.PIPE else stderr,
            stdin=subprocess.PIPE if stdin == asyncio.subprocess.PIPE else stdin,
            **kwargs,  # forward cwd / env / etc. so the fallback matches the async call
        )

    proc = await loop.run_in_executor(None, _run)
    # Wrap the Popen process to match asyncio.subprocess.Process interface
    class _AsyncCompatProc:
        def __init__(self, popen):
            self._popen = popen
            self.returncode = popen.returncode
            self.stdin = popen.stdin
            self.stdout = popen.stdout
            self.stderr = popen.stderr
            self.pid = popen.pid

        async def communicate(self, input=None):
            out, err = await loop.run_in_executor(None, self._popen.communicate, input)
            self.returncode = self._popen.returncode
            return out, err

        async def wait(self):
            return await loop.run_in_executor(None, self._popen.wait)

        def kill(self):
            self._popen.kill()

        def terminate(self):
            self._popen.terminate()

    return _AsyncCompatProc(proc)


async def spawn_subprocess(*args, **kwargs):
    """Drop-in replacement for ``asyncio.create_subprocess_exec``.

    Falls back to a thread-based ``subprocess.Popen`` (wrapped to match the
    asyncio Process interface) on event loops without subprocess support —
    notably the Windows ``SelectorEventLoop`` that uvicorn forces under
    ``--reload``/multi-worker (``use_subprocess=True``), where the native call
    raises ``NotImplementedError`` (GH #122). Also inherits the EAGAIN retry.
    On loops that DO support subprocesses (Proactor, posix) the native path is
    used unchanged, so there is no behavior change off the broken loop.
    """
    return await _spawn_with_retry(list(args), **kwargs)


async def _spawn_with_retry(cmd, **kwargs):
    """Spawn a subprocess, retrying briefly on EAGAIN (posix_spawn resource pressure)."""
    delay = 0.1
    last_err = None
    for _ in range(5):
        try:
            return await _spawn_async(cmd, **kwargs)
        except BlockingIOError as e:
            last_err = e
            if e.errno != errno.EAGAIN:
                raise
            await asyncio.sleep(delay)
            delay *= 2
        except OSError as e:
            if e.errno == errno.EAGAIN:
                last_err = e
                await asyncio.sleep(delay)
                delay *= 2
                continue
            raise
        except Exception as e:
            raise
    raise last_err if last_err else RuntimeError("spawn failed")


async def run_ffmpeg(cmd, timeout: float = 1800.0, capture: bool = True):
    """Run an ffmpeg subprocess with concurrency cap, timeout, and proper cleanup.

    Returns (returncode, stdout_bytes, stderr_bytes). Raises asyncio.TimeoutError
    on hard timeout (after killing + reaping the process).
    """
    stdout = asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL
    stderr = asyncio.subprocess.PIPE
    async with _get_semaphore():
        proc = await _spawn_with_retry(cmd, stdout=stdout, stderr=stderr)
        try:
            try:
                out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    pass
                raise
            return proc.returncode, out, err
        finally:
            # Guarantee reaping — prevents zombie pileup under timeouts or errors.
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    pass
