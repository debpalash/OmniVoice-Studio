import asyncio
import errno
import logging
import os
import shutil

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
    if env_path and os.path.isfile(env_path):
        return env_path
    # 2. imageio-ffmpeg bundled static binary
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:
        logger.warning(f"imageio_ffmpeg unavailable: {e}")
    # 3. Well-known system paths + PATH lookup
    for path in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]:
        if shutil.which(path):
            return path
    logger.warning("ffmpeg not found in env, imageio, or system PATH")
    return None


def find_ffprobe():
    """Locate an ffprobe binary.

    Resolution order:
      1. ``FFPROBE_PATH`` env var (set by Tauri when a sidecar is bundled).
      2. Derived from ``find_ffmpeg()`` path by replacing ``ffmpeg`` → ``ffprobe``.
      3. System ``PATH``.
    """
    env_path = os.environ.get("FFPROBE_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path
    try:
        ffmpeg_path = find_ffmpeg()
        candidate = ffmpeg_path.replace("ffmpeg", "ffprobe")
        if os.path.isfile(candidate):
            return candidate
    except Exception:
        pass
    system_probe = shutil.which("ffprobe")
    if system_probe:
        return system_probe
    return None


async def _spawn_with_retry(cmd, **kwargs):
    """Spawn a subprocess, retrying briefly on EAGAIN (posix_spawn resource pressure)."""
    delay = 0.1
    last_err = None
    for _ in range(5):
        try:
            return await asyncio.create_subprocess_exec(*cmd, **kwargs)
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
