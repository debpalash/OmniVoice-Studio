import os
import sys

try:
    import dotenv

    dotenv.load_dotenv()
    # Also load the durable per-user config so env vars set once survive
    # Tauri/Finder launches that don't inherit a shell environment.
    _user_env = os.path.expanduser("~/.config/omnivoice/env")
    if os.path.isfile(_user_env):
        dotenv.load_dotenv(_user_env, override=False)
except ImportError:
    pass

# ── cuDNN 8 library preload ─────────────────────────────────────────────
# CTranslate2 (used by faster-whisper / WhisperX) requires cuDNN 8, but
# PyTorch 2.8+ pulls cuDNN 9. scripts/setup_cudnn.py installs cuDNN 8
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


# Prevent torchaudio from lazy-importing torchcodec (broken on some installs).
# Proper fix = exclude torchcodec in pyproject.toml; this is a belt-and-braces guard.
os.environ.setdefault("TORCHAUDIO_USE_TORCHCODEC", "0")
sys.modules.setdefault("torchcodec", None)

import soundfile as sf
import torch
import torchaudio
import warnings
import logging
from logging.handlers import RotatingFileHandler

warnings.filterwarnings("ignore", category=UserWarning)
torchaudio.set_audio_backend("soundfile")

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
        _file_handler = RotatingFileHandler(
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
    except Exception as _e:  # disk full, permission denied, etc. — don't block startup
        logging.getLogger("omnivoice.api").warning("Runtime log file disabled: %s", _e)

logger = logging.getLogger("omnivoice.api")

import asyncio
import time
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from scalar_fastapi import get_scalar_api_reference
import traceback

_crash_log_lock = threading.Lock()

from core.db import init_db
from core.config import OUTPUTS_DIR, VOICES_DIR, CRASH_LOG_PATH
from core.tasks import task_manager
from core import job_store
from services.model_manager import idle_worker, preload_model

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
    setup,
    gallery,
    batch,
    watermark,
    events,
    capture,
    capture_ws,
    openai_compat,
    tts_stream,
    marketplace,
)
from utils import hf_progress

# Install the HuggingFace tqdm patch early — every downstream library import
# that triggers `hf_hub_download` (transformers, mlx_whisper, etc.) must see
# the patched class, not the original.
hf_progress.install()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
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
    idle_task = asyncio.create_task(idle_worker())
    worker_task = asyncio.create_task(task_manager.worker())
    # Warm the TTS model in the background so first /generate is instant.
    preload_task = asyncio.create_task(preload_model())
    # Warm the capture ASR engine (MLX Whisper Turbo on Apple Silicon) so
    # first dictation is instant. Without this, first capture takes ~25s
    # just to load the model.
    async def _preload_capture_asr():
        try:
            from services.model_manager import _gpu_pool, _loading_detail
            loop = asyncio.get_event_loop()
            def _warm():
                from services.asr_backend import get_capture_asr_backend
                _loading_detail["sub_stage"] = "loading_asr"
                _loading_detail["detail"] = "Warming up ASR engine…"
                backend = get_capture_asr_backend()
                logger.info("Capture ASR backend selected: %s", backend.id)
                # Actually load model weights into memory — without this the
                # first dictation still takes ~25s for weight loading.
                if hasattr(backend, 'warmup'):
                    _loading_detail["detail"] = f"Loading {backend.display_name}…"
                    backend.warmup()
                _loading_detail["sub_stage"] = "ready"
                _loading_detail["detail"] = "ASR engine ready"
            await loop.run_in_executor(_gpu_pool, _warm)
        except Exception as e:
            logger.warning("Capture ASR preload skipped: %s", e)
    capture_preload_task = asyncio.create_task(_preload_capture_asr())
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


app = FastAPI(
    title="OmniVoice Studio API",
    version="0.4.0",
    lifespan=lifespan,
    docs_url=None,       # Disabled — replaced by Scalar at /docs
    redoc_url=None,      # Disabled — Scalar covers this
)


@app.get("/docs", include_in_schema=False)
async def scalar_docs():
    """Interactive API documentation powered by Scalar."""
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
    # CORSMiddleware doesn't always get a shot at `exception_handler`-created
    # responses, which leaves the browser reporting every 500 as a bare CORS
    # error. Attach the headers manually so the real `detail` bubbles up.
    origin = request.headers.get("origin", "")
    headers: dict[str, str] = {}
    if origin and (origin in _allowed or "*" in _allowed):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Vary"] = "Origin"
    return JSONResponse({"detail": str(exc)}, status_code=500, headers=headers)


_allowed = os.environ.get(
    "OMNIVOICE_ALLOWED_ORIGINS",
    "http://localhost:3901,http://127.0.0.1:3901,tauri://localhost,http://tauri.localhost",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _allowed if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

app.mount("/audio", StaticFiles(directory=OUTPUTS_DIR), name="audio")
app.mount("/voice_audio", StaticFiles(directory=VOICES_DIR), name="voice_audio")


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

    return {"status": "ok", "device": device}


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
app.include_router(setup.router)
app.include_router(gallery.router)
app.include_router(batch.router)
app.include_router(watermark.router)
app.include_router(events.router)
app.include_router(capture.router)
app.include_router(capture_ws.router)
app.include_router(openai_compat.router)
app.include_router(tts_stream.router)
app.include_router(marketplace.router)

frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
else:

    @app.get("/")
    def _dev_fallback():
        return RedirectResponse(url="http://localhost:3901")


if __name__ == "__main__":
    import uvicorn

    # Port 3900 picked to dodge common 8000 conflicts (Django/Rails/Jupyter).
    # Rust sidecar launcher in lib.rs::BACKEND_PORT must stay in sync.
    uvicorn.run(app, host="0.0.0.0", port=3900)
