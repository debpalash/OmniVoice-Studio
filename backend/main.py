import os
import sys

# Ensure `backend/` is on sys.path so bare imports like `from core.config`
# work regardless of how uvicorn is invoked:
#   - `uvicorn main:app`           (cwd = backend/)
#   - `uvicorn backend.main:app`   (cwd = /app, Docker)
_backend_dir = os.path.dirname(os.path.abspath(__file__))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

# #564: also make the project's OWN `omnivoice` package importable from source
# when the venv's editable install is missing/broken (interrupted/offline
# `uv sync`, antivirus-quarantined `_editable_impl_omnivoice.pth`, …). Without
# this the backend boots fine and only fails at the first model call with
# `No module named 'omnivoice'`. The bootstrap now gates on omnivoice being
# importable too (re-syncing to re-lay the editable install); this is the
# runtime safety net. See core/omnivoice_path.py for the full rationale.
from core.omnivoice_path import ensure_omnivoice_importable
ensure_omnivoice_importable(_backend_dir)

# Triton is unavailable on Windows — disable torch.compile / dynamo / inductor
# to prevent TritonMissing errors at inference time. Must be set before torch
# is imported (it is lazily imported in services/model_manager.py). Uses
# setdefault so an explicit user-set value is never overridden, and is guarded
# to win32 so cross-platform default behavior is unchanged.
if sys.platform == "win32":
    os.environ.setdefault("TORCH_COMPILE_DISABLE", "1")
    os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
    os.environ.setdefault("TORCHINDUCTOR_DISABLE", "1")

# The backend's stdout/stderr are pipes owned by the desktop shell that
# spawned it. If that shell exits while the backend survives (crash,
# relaunch, orphan), the pipes close — and the next write raises
# BrokenPipeError. transformers' tqdm weight-loading bar writes constantly,
# so an orphaned backend couldn't load the model at all (caught in the wild
# by the in-app diagnostic report). Wrap stdio so EPIPE is swallowed
# process-wide: logs are best-effort for a server, model loading is not.
# (utils.hf_progress.SafeFileWrapper — same wrapper the patched hub tqdm
# already uses for its own fp.)
from utils.hf_progress import SafeFileWrapper as _SafeStdio  # noqa: E402

if not getattr(sys.stdout, "_is_safe_wrapper", False):
    sys.stdout = _SafeStdio(sys.stdout)
if not getattr(sys.stderr, "_is_safe_wrapper", False):
    sys.stderr = _SafeStdio(sys.stderr)

try:
    import dotenv

    dotenv.load_dotenv()
    # Also load .env from the project root (parent of backend/)
    _project_env = os.path.join(os.path.dirname(_backend_dir), ".env")
    if os.path.isfile(_project_env):
        dotenv.load_dotenv(_project_env, override=False)
    # Load the durable per-user config (the in-app Settings source of truth) so
    # env vars set once survive Tauri/Finder launches that don't inherit a shell
    # environment. This OVERRIDES launcher-injected defaults: the desktop app
    # injects a stale OMNIVOICE_CACHE_DIR from its own config before startup, so
    # without override a models dir changed in Settings was ignored forever (#480).
    from core.user_env import load_into_environ as _load_user_env
    _load_user_env()
except ImportError:
    pass

# ── cuDNN 8 library preload ─────────────────────────────────────────────
# CTranslate2 (used by faster-whisper / WhisperX) requires cuDNN 8, but
# PyTorch 2.8+ pulls cuDNN 9. scripts/setup.py installs cuDNN 8
# side-by-side into cudnn8_compat/ (survives `uv sync`). We preload all
# cuDNN 8 libs via ctypes so CTranslate2's dlopen/LoadLibrary finds them.
if sys.platform != "darwin":  # macOS has no CUDA
    _project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _pyver = f"python{sys.version_info.major}.{sys.version_info.minor}"
    if sys.platform == "win32":
        _cudnn8_lib = os.path.join(
            _project_root, ".venv", "Lib", "site-packages",
            "cudnn8_compat", "nvidia", "cudnn", "bin",
        )
        _cudnn8_glob = "cudnn*64_8.dll"
    else:
        _cudnn8_lib = os.path.join(
            _project_root, ".venv", "lib", _pyver, "site-packages",
            "cudnn8_compat", "nvidia", "cudnn", "lib",
        )
        _cudnn8_glob = "libcudnn*.so.8"
    if os.path.isdir(_cudnn8_lib):
        try:
            import ctypes, glob
            _mode = 0 if sys.platform == "win32" else ctypes.RTLD_GLOBAL
            for _so in sorted(glob.glob(os.path.join(_cudnn8_lib, _cudnn8_glob))):
                try:
                    ctypes.CDLL(_so, mode=_mode)
                except OSError:
                    pass
        except Exception:
            pass

# Route HF/Torch caches to a single external directory when requested.
_cache_dir = os.environ.get("OMNIVOICE_CACHE_DIR")
if _cache_dir:
    os.makedirs(_cache_dir, exist_ok=True)
    os.environ["HF_HOME"] = _cache_dir
    os.environ["HF_HUB_CACHE"] = _cache_dir
    os.environ["TORCH_HOME"] = _cache_dir

# ── Windows symlink fix ─────────────────────────────────────────────────────
# HuggingFace Hub creates NTFS symlinks in its cache to deduplicate blobs
# across model revisions.  On Windows, symlink creation requires either
# Developer Mode enabled or an elevated (Administrator) shell.  Without
# either, `snapshot_download` / `hf_hub_download` raises:
#   OSError: [WinError 1314] A required privilege is not held by the client
# Setting HF_HUB_DISABLE_SYMLINKS_WARNING silences the console spam, and the
# newer HF_HUB_DISABLE_SYMLINKS (huggingface_hub ≥ 0.21) forces file copies
# instead — slightly more disk but always works on first install.
if sys.platform == "win32":
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

# ── HF Xet → legacy LFS fallback ────────────────────────────────────────────
# huggingface_hub ≥ 1.5 routes large file downloads through the Xet content-
# addressed protocol (hf_xet runtime), which has its own internal progress
# reporting that bypasses our `tqdm` monkey-patch in `utils.hf_progress`.
# As a result the SetupWizard install rows show no byte progress while the
# download is actually running. Force the legacy LFS path until we add a
# proper hf_xet progress hook — this still streams via the standard tqdm
# wrapper that our patch intercepts. Override-able by the user.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

# ── HF network timeouts ─────────────────────────────────────────────────────
# Bound HF network ops so a stalled metadata HEAD or a dead download socket
# RAISES (and surfaces as an error) instead of hanging the model-load worker
# forever — the root cause of the "demo voice spins forever, no error" report
# (most often hit on Windows behind a proxy / firewall / antivirus that wedges
# the multi-GB legacy-LFS transfer). HF_HUB_DOWNLOAD_TIMEOUT is a *per-read*
# timeout: it resets on every received chunk, so a slow-but-progressing
# download is never punished — only a genuinely dead socket trips it. Both are
# user-overridable for unusually slow links. Set before huggingface_hub is
# imported so its constants pick them up.
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "15")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")


# Prevent torchaudio from lazy-importing torchcodec (broken on some installs).
# Proper fix = exclude torchcodec in pyproject.toml; this is a belt-and-braces guard.
os.environ.setdefault("TORCHAUDIO_USE_TORCHCODEC", "0")
sys.modules.setdefault("torchcodec", None)

import torchaudio
import warnings
import logging
from logging.handlers import RotatingFileHandler

# ── Restore persisted env vars from prefs.json ────────────────────────────
# Settings saved via Settings UI (proxy, FFMPEG_PATH, HF_TOKEN, etc.) are
# written to prefs.json so they survive backend restarts. Read them back
# here — before any user code reads os.environ — so the values are available
# from startup.
_PERSISTED_ENV_PREFIX = "env."
try:
    from core.prefs import _load as _load_all_prefs
    _prefs = _load_all_prefs()
    for _k, _v in _prefs.items():
        if _k.startswith(_PERSISTED_ENV_PREFIX) and _v:
            _env_key = _k[len(_PERSISTED_ENV_PREFIX):]
            # Do not override an explicitly-set env var (shell > prefs)
            os.environ.setdefault(_env_key, str(_v))
except Exception:
    pass  # prefs.json missing or broken — fine on first run

warnings.filterwarnings("ignore", category=UserWarning)
torchaudio.set_audio_backend("soundfile")


class _WindowsSafeRotatingFileHandler(RotatingFileHandler):
    def doRollover(self):
        _log = logging.getLogger("omnivoice.api")
        try:
            super().doRollover()
        except PermissionError:
            for i in range(self.backupCount - 1, 0, -1):
                sfn = self.rotation_filename("%s.%d" % (self.baseFilename, i))
                dfn = self.rotation_filename("%s.%d" % (self.baseFilename, i + 1))
                if os.path.exists(sfn):
                    try:
                        os.replace(sfn, dfn)
                    except OSError as e:
                        _log.warning("log rotation rename failed: %s", e)
            dfn = self.rotation_filename(self.baseFilename + ".1")
            if os.path.exists(dfn):
                try:
                    os.remove(dfn)
                except OSError as e:
                    _log.warning("log rotation remove failed: %s", e)
            try:
                self.rotate(self.baseFilename, dfn)
            except PermissionError:
                _log.warning("log rotation rotate failed (PermissionError)")
            if self.stream:
                try:
                    self.stream.close()
                except Exception:
                    pass
                self.stream = self._open()

_LOG_FMT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"


class _JsonFormatter(logging.Formatter):
    """Single-line JSON-per-record formatter. Opt in with `OMNIVOICE_JSON_LOGS=1`.

    Keeps every field unquoted-string-safe so downstream log shippers
    (Vector, Fluent Bit, grep) can stream without extra parsing.
    """

    def format(self, record: logging.LogRecord) -> str:
        import json as _json

        payload = {
            "t": self.formatTime(record, datefmt="%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "name": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return _json.dumps(payload, ensure_ascii=False)


_json_logs = os.environ.get("OMNIVOICE_JSON_LOGS") == "1"
logging.basicConfig(
    level=os.environ.get("OMNIVOICE_LOG_LEVEL", "INFO"),
    format=_LOG_FMT,
)

# Phase 1 AUTH-05 / threat T-01-02: install the HF-token redactor on the
# root logger BEFORE any handler-attaching code runs. Every handler then
# inherits the filter, so even handler-formatted output (file, stream,
# JSON) strips real HF tokens. Cheap (regex on each record) and
# idempotent — extra calls are no-ops.
from core.logging_filter import install_redaction_filter  # noqa: E402
install_redaction_filter()

class AsyncioExceptionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno == logging.WARNING and "socket.send() raised exception" in record.getMessage():
            return False
        return True

logging.getLogger("asyncio").addFilter(AsyncioExceptionFilter())

# Silence HF Hub unauthenticated warnings unless specifically requested.
logging.getLogger("huggingface_hub.utils._http").setLevel(logging.ERROR)
# Silence httpx INFO — every HF Hub API call logs a line; the SSE stream
# already surfaces download progress to the UI.
logging.getLogger("httpx").setLevel(logging.WARNING)
if _json_logs:
    # Replace every existing handler's formatter with the JSON one.
    for _h in logging.getLogger().handlers:
        _h.setFormatter(_JsonFormatter())

# Rolling file handler so the Settings UI > Logs > Backend tab has something to read.
# Attached to root so uvicorn, fastapi, and every `omnivoice.*` namespace land here.
# Not attached under _disable_file_log to keep CI/headless tests quiet.
if not os.environ.get("OMNIVOICE_DISABLE_FILE_LOG"):
    from core.config import (
        LOG_PATH as _LOG_PATH,
    )  # local import — avoids circular import at module top

    try:
        _file_handler = _WindowsSafeRotatingFileHandler(
            _LOG_PATH,
            maxBytes=2 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        _file_handler.setLevel(logging.INFO)
        _file_handler.setFormatter(
            _JsonFormatter() if _json_logs else logging.Formatter(_LOG_FMT)
        )
        logging.getLogger().addHandler(_file_handler)
        # Re-install the redactor so the new file handler picks up the
        # filter too (install_redaction_filter is idempotent).
        install_redaction_filter()
    except Exception as _e:  # disk full, permission denied, etc. — don't block startup
        logging.getLogger("omnivoice.api").warning("Runtime log file disabled: %s", _e)

logger = logging.getLogger("omnivoice.api")

import asyncio
import secrets
import time
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.datastructures import MutableHeaders
# Docs-only dependency: a venv created before scalar-fastapi entered the
# dependency set must still boot the backend (#307) — /docs degrades instead.
try:
    from scalar_fastapi import get_scalar_api_reference
except ImportError:
    get_scalar_api_reference = None
import traceback

_crash_log_lock = threading.Lock()

from core.db import init_db
from core.config import OUTPUTS_DIR, VOICES_DIR, CRASH_LOG_PATH
from core.tasks import task_manager
from core import job_store
from services.model_manager import idle_worker, preload_model
from services import network_share

from api.routers import (
    system,
    profiles,
    exports,
    generation,
    dub_core,
    dub_generate,
    dub_export,
    dub_translate,
    projects,
    glossary,
    engines,
    tools,
    stories,
    setup,
    gallery,
    archetypes,
    describe_voice,
    community,
    batch,
    watermark,
    events,
    capture,
    capture_ws,
    openai_compat,
    tts_stream,
    marketplace,
    personas,
    sonitranslate,
    audiobook,
    longform_jobs,
    settings as settings_router,  # Phase 1 AUTH-03: HF token save/clear/state
)
from utils import hf_progress

# Install the HuggingFace tqdm patch early — every downstream library import
# that triggers `hf_hub_download` (transformers, mlx_whisper, etc.) must see
# the patched class, not the original.
hf_progress.install()

# Wire the overall download aggregator's byte sink onto the patched tqdm so
# parallel per-file updates feed one accurate overall bar (FDL-06).
try:
    from utils import download_aggregator
    download_aggregator.install()
except Exception:
    pass

# Log the download-acceleration state once at startup (FDL-03) so a slow
# download report can be triaged from the logs without reproducing. Note: the
# app sets HF_HUB_DISABLE_XET=1 above by default (legacy LFS for byte progress),
# so xet_active is normally False even though hf_xet is installed.
try:
    from api.routers.system import _fast_download_status as _fd_status
    _fd = _fd_status()
    _xet_ver = f" {_fd['xet_version']}" if _fd.get("xet_version") else ""
    logging.getLogger("omnivoice.model").info(
        "downloads: Xet %s (hf_xet%s installed=%s), high_perf=%s",
        "ACTIVE" if _fd["xet_active"] else "disabled → legacy LFS",
        _xet_ver, _fd["xet_installed"], _fd["high_performance"],
    )
except Exception:
    pass


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Network sharing is loopback-only by default; the PIN middleware stays
    # inert until enable() sets a PIN. Seed the (disabled) state so the
    # middleware and /system/network/state always have something to read.
    app.state.network_share = network_share.get_state()
    from api.routers.gallery import _init_gallery_db

    _init_gallery_db()
    # Seed a demo voice profile on first run (empty DB only).
    from core.onboarding import seed_sample_project
    seed_sample_project()
    # Any job still in pending/running at startup is orphaned — a previous
    # process didn't finish it. Flip to failed with a clear message so the
    # UI doesn't show a fake spinner.
    try:
        swept = job_store.sweep_orphans_on_startup()
        if swept:
            logger.info("Startup: marked %d orphaned job(s) as failed.", swept)
    except Exception:
        logger.exception("Startup job-sweep failed (non-fatal).")
    # Phase 1 Wave 3 — macOS Gatekeeper quarantine probe (#54).
    # Detection is informational: we log a structured warning and broadcast
    # an event so the React ErrorBoundary can render the docs deeplink. We
    # do NOT auto-run `xattr -cr` — the app cannot clear its own quarantine
    # state (per Anti-Pattern in 01-RESEARCH.md).
    try:
        from core import event_bus, gatekeeper_detect
        status = gatekeeper_detect.quarantine_status()
        if status.get("quarantined"):
            logger.warning(
                "Gatekeeper quarantine detected on app bundle %s — "
                "users must run `xattr -cr <bundle>` once. error_class=%s",
                status.get("bundle_path"),
                status.get("error_class"),
            )
            event_bus.emit(
                "system_error",
                {
                    "error_class": status.get("error_class"),
                    "bundle_path": status.get("bundle_path"),
                },
            )
    except Exception:
        logger.exception("Gatekeeper probe failed (non-fatal).")
    idle_task = asyncio.create_task(idle_worker())
    worker_task = asyncio.create_task(task_manager.worker())
    # Warm the TTS model in the background so first /generate is instant.
    preload_task = asyncio.create_task(preload_model())
    # Capture ASR is useful to keep warm, but it is another large model in
    # unified memory on Apple Silicon. Keep launch lean by default; users who
    # prefer instant dictation can opt in with OMNIVOICE_PRELOAD_CAPTURE_ASR=1.
    if _env_flag("OMNIVOICE_PRELOAD_CAPTURE_ASR"):
        async def _preload_capture_asr():
            loading_detail = None
            prev_loading_detail = None
            try:
                from services.model_manager import _gpu_pool, _loading_detail
                loading_detail = _loading_detail
                prev_loading_detail = dict(loading_detail)
                loop = asyncio.get_running_loop()
                def _warm():
                    from services.asr_backend import get_capture_asr_backend
                    loading_detail["sub_stage"] = "loading_asr"
                    loading_detail["detail"] = "Warming up ASR engine…"
                    backend = get_capture_asr_backend()
                    logger.info("Capture ASR backend selected: %s", backend.id)
                    if hasattr(backend, 'warmup'):
                        loading_detail["detail"] = f"Loading {backend.display_name}…"
                        backend.warmup()
                    loading_detail["sub_stage"] = "ready"
                    loading_detail["detail"] = "ASR engine ready"
                await loop.run_in_executor(_gpu_pool, _warm)
            except Exception as e:
                if loading_detail is not None and loading_detail.get("sub_stage") == "loading_asr":
                    loading_detail.clear()
                    loading_detail.update(prev_loading_detail or {})
                logger.warning("Capture ASR preload skipped: %s", e)
        capture_preload_task = asyncio.create_task(_preload_capture_asr())
    else:
        logger.info("Capture ASR preload disabled; dictation ASR will load on first use.")

    # ── MCP session manager (Wave 2.2) ────────────────────────────────────
    # FastMCP's Streamable-HTTP transport needs its session manager running
    # for the lifetime of the app. It's created lazily by streamable_http_app()
    # (called in mount_mcp below), so we stack its `run()` context into ours
    # via AsyncExitStack rather than replacing this lifespan. Best-effort: a
    # missing/broken MCP layer must never stop the rest of the backend.
    from contextlib import AsyncExitStack
    async with AsyncExitStack() as _mcp_stack:
        _sm = getattr(app.state, "mcp_session_manager", None)
        if _sm is not None:
            try:
                await _mcp_stack.enter_async_context(_sm.run())
                logger.info("MCP server mounted at /mcp")
            except Exception as e:
                logger.warning("MCP session manager failed to start: %s", e)
        yield
    # ── Graceful shutdown (SIGTERM from Tauri, Ctrl+C, etc.) ────────────
    logger.info("Shutdown: cleaning up…")
    idle_task.cancel()
    worker_task.cancel()
    # Wait for tasks to finish their current iteration
    for t in (idle_task, worker_task):
        try:
            await asyncio.wait_for(t, timeout=3.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    # Unload the model and free GPU memory
    try:
        import services.model_manager as mm
        if mm.model is not None:
            mm.model = None
            logger.info("Shutdown: model unloaded.")
        mm.free_vram()
    except Exception:
        pass
    # Run GC to release any remaining references
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    # Close shared httpx connection pool
    try:
        from api.http_client import close_http_client
        await close_http_client()
    except Exception:
        pass
    logger.info("Shutdown: done.")


from core.version import APP_VERSION  # single source of truth (pyproject metadata)

app = FastAPI(
    title="OmniVoice Studio API",
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url=None,       # Disabled — replaced by Scalar at /docs
    redoc_url=None,      # Disabled — Scalar covers this
)


@app.get("/docs", include_in_schema=False)
async def scalar_docs():
    """Interactive API documentation powered by Scalar."""
    if get_scalar_api_reference is None:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "API docs unavailable: scalar-fastapi is not installed "
                          "in the backend environment (#307)."
            },
        )
    return get_scalar_api_reference(
        openapi_url=app.openapi_url,
        title=app.title,
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Client disconnected mid-stream (browser canceled a <video>/range fetch).
    # The response is already partially sent — trying to wrap it in a 500 just
    # produces a second protocol error. Log a one-liner and bail.
    exc_name = type(exc).__name__
    if exc_name in (
        "LocalProtocolError",
        "ClientDisconnect",
    ) or "Content-Length" in str(exc):
        logger.info("Client disconnect during %s (%s)", request.url, exc_name)
        return Response(status_code=499)
    try:
        # Serialize writes so concurrent unhandled exceptions don't interleave frames.
        with _crash_log_lock, open(CRASH_LOG_PATH, "a") as f:
            f.write(f"\n--- {time.strftime('%Y-%m-%dT%H:%M:%S')} ---\n")
            f.write(f"Request: {request.url}\n")
            f.write(traceback.format_exc())
    except Exception:
        logger.exception("Failed to write crash log")
    logger.exception("Unhandled exception for %s", request.url)
    # Structured journal entry (dedup + error_class) — feeds /system/errors/
    # recent, the diagnostic bundle, and the bug-report pipeline. record()
    # never raises; a journal failure must not shadow the real error.
    from core import error_journal
    _entry = error_journal.record(
        exc, route=str(request.url.path), trace=traceback.format_exc()
    )
    # CORSMiddleware doesn't always get a shot at `exception_handler`-created
    # responses, which leaves the browser reporting every 500 as a bare CORS
    # error. Attach the headers manually so the real `detail` bubbles up.
    origin = request.headers.get("origin", "")
    headers: dict[str, str] = {}
    if origin and (origin in _allowed or "*" in _allowed):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Vary"] = "Origin"
    return JSONResponse(
        {"detail": str(exc), "error_class": _entry.get("error_class")},
        status_code=500,
        headers=headers,
    )


_LOOPBACK_CLIENTS = {"127.0.0.1", "::1"}
_SHELL_PATHS = {"/", "/index.html", "/favicon.ico", "/health"}


class NetworkAccessMiddleware:
    """When a share PIN is set, require it for non-loopback clients on API
    routes. Inert when no PIN (default + docker deploys). Loopback (incl.
    Tailscale-proxied) always bypasses; the SPA shell is always served so the
    PIN gate UI can load.

    Pure ASGI (not BaseHTTPMiddleware) so it never buffers the response body.
    BaseHTTPMiddleware collects StreamingResponse/SSE bodies before forwarding,
    which makes PIN'd LAN clients on streaming endpoints (dictation SSE, tts
    streaming, /system/logs/stream) laggy. As a plain ASGI app we forward
    `send` untouched on the pass-through paths and only wrap it to inject the
    Set-Cookie header — the body still streams chunk-by-chunk."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        from starlette.requests import Request

        request = Request(scope, receive=receive)
        ns = getattr(request.app.state, "network_share", None)
        pin = getattr(ns, "pin", None) if ns else None
        if not pin:
            return await self.app(scope, receive, send)
        client = scope["client"][0] if scope.get("client") else None
        if client in _LOOPBACK_CLIENTS:
            return await self.app(scope, receive, send)
        path = scope["path"]
        if path in _SHELL_PATHS or path.startswith("/assets/") or path.startswith("/favicon"):
            return await self.app(scope, receive, send)
        supplied = (
            request.headers.get("x-omnivoice-pin")
            or request.query_params.get("pin")
            or request.cookies.get("ov_pin")
            or ""
        )
        if not secrets.compare_digest(supplied, pin):
            resp = JSONResponse({"detail": "PIN required"}, status_code=401)
            return await resp(scope, receive, send)
        # Valid PIN. Set the cookie by wrapping send to inject Set-Cookie on the
        # http.response.start message — without ever materialising the body.
        if request.cookies.get("ov_pin") != pin:
            async def send_with_cookie(message):
                if message["type"] == "http.response.start":
                    headers = MutableHeaders(scope=message)
                    headers.append("set-cookie", f"ov_pin={pin}; Path=/; SameSite=Lax")
                await send(message)

            return await self.app(scope, receive, send_with_cookie)
        return await self.app(scope, receive, send)


class BearerKeyMiddleware:
    """When OMNIVOICE_API_KEY is set, non-loopback clients must present it on
    every HTTP + WebSocket request: ``Authorization: Bearer <key>``,
    ``?api_key=<key>`` (browser WebSockets cannot set headers), or the
    ``ov_key`` cookie (set on the first successful HTTP auth). Loopback
    always bypasses — the desktop default is unchanged — and the SPA shell
    paths stay reachable so a remote UI can load and show what's wrong.

    Inert when the env var is unset (the default). Pure ASGI for the same
    no-buffering reason as NetworkAccessMiddleware above. Plain-HTTP caveat
    is documented in docs/remote-gpu.md: the key is sniffable outside a
    WireGuard (Tailscale) or TLS (tailscale serve) transport.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        key = os.environ.get("OMNIVOICE_API_KEY") or ""
        if not key:
            return await self.app(scope, receive, send)
        client = scope["client"][0] if scope.get("client") else None
        if client in _LOOPBACK_CLIENTS:
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if scope["type"] == "http" and (
            path in _SHELL_PATHS or path.startswith("/assets/") or path.startswith("/favicon")
        ):
            return await self.app(scope, receive, send)

        from starlette.requests import HTTPConnection

        conn = HTTPConnection(scope)
        auth = conn.headers.get("authorization", "")
        supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not supplied:
            supplied = conn.query_params.get("api_key") or conn.cookies.get("ov_key") or ""

        if not secrets.compare_digest(supplied, key):
            if scope["type"] == "websocket":
                # Reject the handshake; 1008 = policy violation.
                await receive()  # consume websocket.connect
                await send({"type": "websocket.close", "code": 1008})
                return
            resp = JSONResponse({"detail": "API key required"}, status_code=401)
            return await resp(scope, receive, send)

        if scope["type"] == "http" and conn.cookies.get("ov_key") != key:
            async def send_with_cookie(message):
                if message["type"] == "http.response.start":
                    headers = MutableHeaders(scope=message)
                    headers.append(
                        "set-cookie", f"ov_key={key}; Path=/; SameSite=Lax"
                    )
                await send(message)

            return await self.app(scope, receive, send_with_cookie)
        return await self.app(scope, receive, send)


# UI dev-server port — single-sourced from OMNIVOICE_UI_PORT so a user who
# moves the Vite dev server off 3901 still gets a matching CORS allow-list.
def _ui_port() -> int:
    raw = os.environ.get("OMNIVOICE_UI_PORT")
    if raw is None:
        return 3901
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 3901


_ui = _ui_port()
_allowed = os.environ.get(
    "OMNIVOICE_ALLOWED_ORIGINS",
    f"http://localhost:{_ui},http://127.0.0.1:{_ui},tauri://localhost,http://tauri.localhost",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _allowed if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

# Registered AFTER CORS so CORS remains the outermost layer (CORS headers are
# applied even to the 401 PIN-required responses). Inert unless a PIN is set.
app.add_middleware(NetworkAccessMiddleware)

# Remote-backend bearer gate (parity program Wave 2.3 / §R2). Inert unless
# OMNIVOICE_API_KEY is set. Distinct from the PIN gate above: the PIN guards
# casual LAN-share guests for one session; the API key is the durable
# credential for running this backend remotely (Tailscale / Docker GPU box).
# Covers WebSockets too — the PIN gate never did, because every WS endpoint
# carried its own loopback guard; remote mode is exactly the case where a
# keyed non-loopback client must reach them.
app.add_middleware(BearerKeyMiddleware)

# Register canonical audio MIME types before any StaticFiles mount.
# Python's `mimetypes.guess_type()` returns `audio/x-wav` for `.wav` and
# `audio/x-flac` for `.flac` on most platforms — these are vendor-experimental
# (x- prefix, never IANA-registered). macOS Chrome/Safari MIME-sniff leniently
# via CoreAudio so playback works there, but Linux Chrome/Firefox (FFmpeg) and
# Android Chrome (ExoPlayer) strictly honor the declared type and treat the
# x- variants as download-only — manifesting as the play button silently
# doing nothing in the browser app while working in the Tauri desktop shell.
# `audio/wav` / `audio/flac` are the IANA-canonical types.
# Ref: https://www.iana.org/assignments/media-types/media-types.xhtml#audio
import mimetypes as _mimetypes
_mimetypes.add_type("audio/wav",  ".wav")
_mimetypes.add_type("audio/flac", ".flac")

app.mount("/audio", StaticFiles(directory=OUTPUTS_DIR), name="audio")
app.mount("/voice_audio", StaticFiles(directory=VOICES_DIR), name="voice_audio")

# Bundled demo assets — clone reference + pre-rendered output, voice-design
# preset previews, dictation samples. Read-only, ships with the app, no
# network. See scripts/build_demos.sh for how the WAVs are generated.
_DEMO_ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets", "samples")
if os.path.isdir(_DEMO_ASSETS_DIR):
    app.mount("/demo_audio", StaticFiles(directory=_DEMO_ASSETS_DIR), name="demo_audio")


# ── Health check ────────────────────────────────────────────────────────
# Used by Docker health checks, load balancers, and the Tauri desktop shell.
@app.get("/health")
def health():
    import torch

    device = "cpu"
    if torch.cuda.is_available():
        device = f"cuda ({torch.cuda.get_device_name(0)})"
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"

    return {"status": "ok", "device": device, "version": APP_VERSION}


app.include_router(system.router)
app.include_router(profiles.router)
app.include_router(exports.router)
app.include_router(generation.router)
app.include_router(dub_core.router)
app.include_router(dub_generate.router)
app.include_router(dub_export.router)
app.include_router(dub_translate.router)
app.include_router(projects.router)
app.include_router(glossary.router)
app.include_router(engines.router)
app.include_router(tools.router)
app.include_router(stories.router)
app.include_router(setup.router)
app.include_router(gallery.router)
app.include_router(archetypes.router)
app.include_router(describe_voice.router)  # issue #317: free-text voice design
app.include_router(community.router)
app.include_router(batch.router)
app.include_router(watermark.router)
app.include_router(events.router)
app.include_router(capture.router)
app.include_router(capture_ws.router)
app.include_router(openai_compat.router)
app.include_router(tts_stream.router)
app.include_router(marketplace.router)
app.include_router(personas.router)
app.include_router(sonitranslate.router)
app.include_router(audiobook.router)
app.include_router(longform_jobs.router)
app.include_router(settings_router.router)  # Phase 1 AUTH-03 endpoints
from api.routers import mcp_bindings as _mcp_bindings_router  # noqa: E402
app.include_router(_mcp_bindings_router.router)  # Wave 2.2 per-agent voice bindings

# ── Mount the MCP server (Wave 2.2) ───────────────────────────────────────
# FastMCP's Streamable-HTTP app is sub-mounted at /mcp; its session manager is
# stashed on app.state for the lifespan above to run. Opt-out via
# OMNIVOICE_MCP_DISABLE=1; best-effort so a missing mcp package or a build
# without it never breaks startup.
if os.environ.get("OMNIVOICE_MCP_DISABLE", "").strip().lower() not in ("1", "true", "yes", "on"):
    try:
        from mcp_server import create_mcp_server

        _mcp = create_mcp_server()
        _mcp_app = _mcp.streamable_http_app()
        app.state.mcp_session_manager = _mcp.session_manager
        app.mount("/mcp", _mcp_app)
        logging.getLogger("omnivoice.api").info("MCP app mounted at /mcp")
    except Exception as _mcp_err:  # noqa: BLE001
        logging.getLogger("omnivoice.api").info(
            "MCP server not mounted (%s); /mcp disabled.", _mcp_err
        )

frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.exists(frontend_path):
    # ── Runtime API-base override (Docker / reverse-proxy deployments) ──────
    # When OMNIVOICE_PUBLIC_API_BASE is set we inject it into index.html as
    # `window.__OMNIVOICE_API_BASE__`, which the SPA's API resolver reads first.
    # Unset (the default) → StaticFiles serves index.html untouched: same-origin,
    # zero overhead, no behavior change. See core/spa_inject.py.
    from core.spa_inject import is_valid_public_api_base, inject_api_base

    _public_api_base = os.environ.get("OMNIVOICE_PUBLIC_API_BASE", "").strip().rstrip("/")
    _index_path = os.path.join(frontend_path, "index.html")
    if _public_api_base and not is_valid_public_api_base(_public_api_base):
        logging.getLogger("omnivoice.api").warning(
            "OMNIVOICE_PUBLIC_API_BASE=%r is not a valid http(s) URL; ignoring.",
            _public_api_base,
        )
        _public_api_base = ""

    if _public_api_base and os.path.isfile(_index_path):
        from fastapi.responses import HTMLResponse

        def _index_with_api_base() -> "HTMLResponse":
            with open(_index_path, "r", encoding="utf-8") as _fh:
                return HTMLResponse(inject_api_base(_fh.read(), _public_api_base))

        @app.get("/", include_in_schema=False)
        def _index_root():
            return _index_with_api_base()

        @app.get("/index.html", include_in_schema=False)
        def _index_html():
            return _index_with_api_base()

    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
else:

    @app.get("/")
    def _dev_fallback():
        return RedirectResponse(url="http://localhost:3901")


if __name__ == "__main__":
    import argparse
    import sys
    import threading
    import time
    import urllib.request
    import uvicorn

    parser = argparse.ArgumentParser(prog="omnivoice-backend")
    parser.add_argument(
        "--health-check",
        action="store_true",
        help="Boot the server, poll /health, exit 0 on success / 1 on timeout. "
             "Used by the release-time installer smoke step in .github/workflows/release.yml.",
    )
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Run the self-check suite (device, ffmpeg, HF token, disk, engines, "
             "network) without starting the server. Exit 0 if healthy, 1 if any "
             "check fails. Output is scrubbed — safe to paste into a GitHub issue.",
    )
    parser.add_argument(
        "--deep",
        action="store_true",
        help="With --diagnose: also load the active TTS engine and synthesize a "
             "short utterance. Catches 'installed but broken'. May cold-load the "
             "model (minutes + a large download on a fresh install).",
    )
    args, _unknown = parser.parse_known_args()

    if args.diagnose:
        from core.diagnose import run_diagnostics, format_text

        _report = run_diagnostics(deep=args.deep)
        print(format_text(_report), flush=True)
        sys.exit(0 if _report["summary"]["ok"] else 1)

    # Single-sourced from OMNIVOICE_PORT so the bare `python main.py` path and
    # `--health-check` agree with the Rust sidecar / uvicorn-CLI `--port`.
    _port = network_share.backend_port()

    if args.health_check:
        HEALTH_URL = f"http://127.0.0.1:{_port}/health"
        TIMEOUT_S = 60
        INTERVAL_S = 5

        def _serve():
            # log_level="warning" silences the per-request access log spam
            # so the smoke output stays readable in GH Actions.
            uvicorn.run(app, host="127.0.0.1", port=_port, log_level="warning")

        t = threading.Thread(target=_serve, daemon=True)
        t.start()

        elapsed = 0
        while elapsed < TIMEOUT_S:
            try:
                with urllib.request.urlopen(HEALTH_URL, timeout=2) as resp:
                    if resp.status == 200:
                        print(f"OK — /health responded 200 after {elapsed}s", flush=True)
                        sys.exit(0)
            except Exception:
                pass
            time.sleep(INTERVAL_S)
            elapsed += INTERVAL_S

        print(
            f"FAIL — /health did not respond 200 within {TIMEOUT_S}s",
            file=sys.stderr, flush=True,
        )
        sys.exit(1)

    # Port 3900 picked to dodge common 8000 conflicts (Django/Rails/Jupyter).
    # Rust sidecar launcher in lib.rs::BACKEND_PORT must stay in sync.
    #
    # SECURITY: default to loopback (127.0.0.1) so the API isn't reachable
    # from the LAN out of the box. OmniVoice ships no authentication; binding
    # to 0.0.0.0 by default would expose every router on this process to any
    # host on the user's network. Docker images that need to publish the port
    # set OMNIVOICE_BIND_HOST=0.0.0.0 explicitly (see deploy/docker-compose.yml)
    # — the host-side port mapping is what enforces 127.0.0.1-only there.
    _bind_host = os.environ.get("OMNIVOICE_BIND_HOST", "127.0.0.1")
    uvicorn.run(app, host=_bind_host, port=_port)
