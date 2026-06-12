import asyncio
import errno
import logging
import os
import shutil
import subprocess

# Leaf module (stdlib-only) — safe to import at module top, unlike
# services.dub_pipeline which imports this module and would cycle.
from services.proc_registry import register_proc, unregister_proc

logger = logging.getLogger("omnivoice.api")

# Cap concurrent ffmpeg jobs so macOS posix_spawn can't hit EAGAIN under load.
_FFMPEG_SEMAPHORE: "asyncio.Semaphore | None" = None
_FFMPEG_CONCURRENCY = 2


def _get_semaphore() -> asyncio.Semaphore:
    global _FFMPEG_SEMAPHORE
    if _FFMPEG_SEMAPHORE is None:
        _FFMPEG_SEMAPHORE = asyncio.Semaphore(_FFMPEG_CONCURRENCY)
    return _FFMPEG_SEMAPHORE


# Candidate paths that exist but won't run (validated once per process).
# Windows users hit this as `[WinError 193] %1 is not a valid Win32
# application` (#360/#361/#362): a corrupt/wrong-arch imageio-ffmpeg
# download or a WindowsApps alias stub passes `os.path.isfile` / `which`
# but explodes at spawn. Probe each candidate with `-version` and fall
# through to the next source instead of returning a time bomb.
_BINARY_OK: dict[str, bool] = {}


def _binary_runs(path: str) -> bool:
    cached = _BINARY_OK.get(path)
    if cached is not None:
        return cached
    try:
        subprocess.run(
            [path, "-version"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=10, check=False,
        )
        ok = True
    except (OSError, subprocess.TimeoutExpired, subprocess.SubprocessError) as e:
        logger.warning(
            "Rejecting non-runnable ffmpeg/ffprobe candidate %s: %s",
            os.path.basename(str(path)), e,
        )
        ok = False
    _BINARY_OK[path] = ok
    return ok


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
        if resolved and _binary_runs(resolved):
            return resolved
    # 2. imageio-ffmpeg bundled static binary
    try:
        import imageio_ffmpeg
        candidate = imageio_ffmpeg.get_ffmpeg_exe()
        if candidate and os.path.isfile(candidate) and _binary_runs(candidate):
            return candidate
        logger.debug("imageio_ffmpeg binary not usable at %s", candidate)
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
        resolved = shutil.which(path)
        if resolved and _binary_runs(resolved):
            return resolved
    logger.warning("ffmpeg not found (or not runnable) in env, imageio, or system PATH")
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
        if os.path.isfile(path) and _binary_runs(path):
            return path
        resolved = shutil.which(path)
        if resolved and _binary_runs(resolved):
            return resolved

    system_probe = shutil.which("ffprobe")
    if system_probe and _binary_runs(system_probe):
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
        except Exception:
            raise
    raise last_err if last_err else RuntimeError("spawn failed")


def _atempo_chain(ratio: float) -> str:
    """Build an `atempo=…,atempo=…` filter chain for arbitrary ratios.

    ffmpeg's atempo filter is limited to [0.5, 2.0] per stage. Chaining
    multiple stages multiplies the effective ratio while keeping each
    individual stage inside the well-behaved range. Pitch is preserved
    (WSOLA-style time-domain stretching). ratio > 1 speeds up, < 1
    slows down.
    """
    stages: list[str] = []
    remaining = ratio
    while remaining > 2.0:
        stages.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        stages.append("atempo=0.5")
        remaining /= 0.5
    stages.append(f"atempo={remaining:.6f}")
    return ",".join(stages)


async def _pitch_preserving_stretch(wav, target_samples: int, sr: int):
    """Time-stretch a (1, samples) tensor to `target_samples` while
    preserving pitch, by piping the audio through `ffmpeg atempo`.

    Async so it never blocks the event loop: it's awaited from the dub
    generate `_stream` generator, and each ffmpeg call is ~50-100 ms — a
    synchronous ``subprocess.run`` here froze health-checks / SSE / every
    concurrent request for the whole multi-segment job.

    Returns a (1, target_samples) tensor on the same device as input.
    Raises RuntimeError when ffmpeg fails — callers should fall back to
    naive linear interpolation, accepting the pitch shift, to ensure the
    output isn't silent.
    """
    # Lazy imports keep this module importable in torch-free contexts
    # (setup scripts, smoke probes) — only the stretch path needs them.
    import numpy as np
    import torch

    wl = int(wav.shape[-1])
    if target_samples <= 0 or wl == target_samples:
        return wav
    ratio = wl / target_samples
    filter_str = _atempo_chain(ratio)

    # Mono float32 via stdin → ffmpeg → stdout. One subprocess per segment,
    # run off the event loop so concurrent requests stay responsive.
    arr = wav.detach().cpu().to(torch.float32).numpy().reshape(-1).astype(np.float32, copy=False)
    proc = await spawn_subprocess(
        find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
        "-af", filter_str,
        "-f", "f32le", "-ar", str(sr), "-ac", "1", "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate(input=arr.tobytes())
    if proc.returncode != 0 or not stdout:
        raise RuntimeError(
            (stderr.decode(errors="replace") or "atempo failed")[:200]
        )
    out_arr = np.frombuffer(stdout, dtype=np.float32)
    # atempo rarely lands exactly on the integer sample count, so
    # pad/trim to the requested slot length.
    if len(out_arr) < target_samples:
        pad = np.zeros(target_samples - len(out_arr), dtype=np.float32)
        out_arr = np.concatenate([out_arr, pad])
    elif len(out_arr) > target_samples:
        out_arr = out_arr[:target_samples]
    return torch.from_numpy(out_arr.copy()).unsqueeze(0).to(wav.device)


async def probe_duration(path: str) -> float | None:
    """Return a media file's duration in seconds via ffprobe, or None.

    Used by the Smart Fit pipeline to sanity-check source/track lengths
    without loading the media. Never raises — probing is best-effort.
    """
    ffprobe = find_ffprobe()
    if not ffprobe or not os.path.isfile(path):
        return None
    try:
        proc = await spawn_subprocess(
            ffprobe, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            return None
        return float(stdout.decode().strip())
    except Exception as e:
        logger.debug("probe_duration failed for %s: %s", os.path.basename(str(path)), e)
        return None


async def probe_frame_rates(path: str) -> "tuple[str, str] | None":
    """Return (r_frame_rate, avg_frame_rate) strings for the first video
    stream (e.g. ``("30000/1001", "2997/100")``), or None on any failure.

    A mismatch between the two is the practical VFR signature — used by the
    Smart Fit retime pipeline to decide whether to normalise with ``fps=``
    before trim/setpts. Never raises — probing is best-effort.
    """
    ffprobe = find_ffprobe()
    if not ffprobe or not os.path.isfile(path):
        return None
    try:
        proc = await spawn_subprocess(
            ffprobe, "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=r_frame_rate,avg_frame_rate",
            "-of", "csv=p=0",
            path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            return None
        parts = stdout.decode().strip().split(",")
        if len(parts) < 2:
            return None
        return parts[0].strip(), parts[1].strip()
    except Exception as e:
        logger.debug("probe_frame_rates failed for %s: %s", os.path.basename(str(path)), e)
        return None


async def run_ffmpeg(cmd, timeout: float = 1800.0, capture: bool = True,
                     job_id: "str | None" = None):
    """Run an ffmpeg subprocess with concurrency cap, timeout, and proper cleanup.

    Returns (returncode, stdout_bytes, stderr_bytes). Raises asyncio.TimeoutError
    on hard timeout (after killing + reaping the process).

    ``job_id`` (optional) registers the process with the dub pipeline's
    process tracker (``services.proc_registry``) so ``/dub/abort`` can kill
    long export encodes (used by the Smart Fit batched retime).

    Path-injection note: every filesystem path placed in ``cmd`` by callers
    is realpath-normalised and containment-checked against its workspace
    root (e.g. DUB_DIR) at the call site before the argv is assembled —
    see api.routers.dub_export and services.video_retime.
    """
    stdout = asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL
    stderr = asyncio.subprocess.PIPE
    async with _get_semaphore():
        proc = await _spawn_with_retry(cmd, stdout=stdout, stderr=stderr)
        if job_id:
            try:
                register_proc(job_id, proc)
            except Exception as e:
                # Newline-strip the id inline — it can originate from a path
                # param, and the log stream must stay one-event-per-line.
                logger.debug("register_proc failed for %s: %s",
                             job_id.replace("\n", " ").replace("\r", " "), e)
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
            if job_id:
                try:
                    unregister_proc(job_id, proc)
                except Exception as e:
                    logger.debug("unregister_proc failed for %s: %s",
                                 job_id.replace("\n", " ").replace("\r", " "), e)
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
