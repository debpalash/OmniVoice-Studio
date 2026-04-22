import os
import sys

try:
    import dotenv
    dotenv.load_dotenv()
except ImportError:
    pass

# Route HF/Torch caches to a single external directory when requested.
_cache_dir = os.environ.get("OMNIVOICE_CACHE_DIR")
if _cache_dir:
    os.makedirs(_cache_dir, exist_ok=True)
    os.environ["HF_HOME"] = _cache_dir
    os.environ["HF_HUB_CACHE"] = _cache_dir
    os.environ["TORCH_HOME"] = _cache_dir

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
            "t":     self.formatTime(record, datefmt="%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "name":  record.name,
            "msg":   record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return _json.dumps(payload, ensure_ascii=False)


_json_logs = os.environ.get("OMNIVOICE_JSON_LOGS") == "1"
logging.basicConfig(
    level=os.environ.get("OMNIVOICE_LOG_LEVEL", "INFO"),
    format=_LOG_FMT,
)
if _json_logs:
    # Replace every existing handler's formatter with the JSON one.
    for _h in logging.getLogger().handlers:
        _h.setFormatter(_JsonFormatter())

# Rolling file handler so the Settings UI > Logs > Backend tab has something to read.
# Attached to root so uvicorn, fastapi, and every `omnivoice.*` namespace land here.
# Not attached under _disable_file_log to keep CI/headless tests quiet.
if not os.environ.get("OMNIVOICE_DISABLE_FILE_LOG"):
    from core.config import LOG_PATH as _LOG_PATH  # local import — avoids circular import at module top
    try:
        _file_handler = RotatingFileHandler(
            _LOG_PATH, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8",
        )
        _file_handler.setLevel(logging.INFO)
        _file_handler.setFormatter(_JsonFormatter() if _json_logs else logging.Formatter(_LOG_FMT))
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
import traceback

_crash_log_lock = threading.Lock()

from core.db import init_db
from core.config import OUTPUTS_DIR, VOICES_DIR, CRASH_LOG_PATH
from core.tasks import task_manager
from core import job_store
from services.model_manager import idle_worker

from api.routers import system, profiles, exports, generation, dub_core, dub_generate, dub_export, dub_translate, projects, glossary, engines, tools, setup
from utils import hf_progress

# Install the HuggingFace tqdm patch early — every downstream library import
# that triggers `hf_hub_download` (transformers, mlx_whisper, etc.) must see
# the patched class, not the original.
hf_progress.install()

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
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
    yield
    idle_task.cancel()
    worker_task.cancel()

app = FastAPI(title="OmniVoice Studio API", version="0.4.0", lifespan=lifespan)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Client disconnected mid-stream (browser canceled a <video>/range fetch).
    # The response is already partially sent — trying to wrap it in a 500 just
    # produces a second protocol error. Log a one-liner and bail.
    exc_name = type(exc).__name__
    if exc_name in ("LocalProtocolError", "ClientDisconnect") or "Content-Length" in str(exc):
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
    "http://localhost:5173,http://127.0.0.1:5173,tauri://localhost,http://tauri.localhost",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _allowed if o.strip()],
    allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

app.mount("/audio", StaticFiles(directory=OUTPUTS_DIR), name="audio")
app.mount("/voice_audio", StaticFiles(directory=VOICES_DIR), name="voice_audio")

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

frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
else:
    @app.get("/")
    def _dev_fallback():
        return RedirectResponse(url="http://localhost:5173")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
