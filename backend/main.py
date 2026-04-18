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

warnings.filterwarnings("ignore", category=UserWarning)
torchaudio.set_audio_backend("soundfile")

logging.basicConfig(
    level=os.environ.get("OMNIVOICE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("omnivoice.api")

import asyncio
import time
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import traceback

_crash_log_lock = threading.Lock()

from core.db import init_db
from core.config import OUTPUTS_DIR, VOICES_DIR, CRASH_LOG_PATH
from core.tasks import task_manager
from services.model_manager import idle_worker

from api.routers import system, profiles, exports, generation, dub_core, dub_generate, dub_export, dub_translate, projects

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    idle_task = asyncio.create_task(idle_worker())
    worker_task = asyncio.create_task(task_manager.worker())
    yield
    idle_task.cancel()
    worker_task.cancel()

app = FastAPI(title="OmniVoice Studio API", version="0.4.0", lifespan=lifespan)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    try:
        # Serialize writes so concurrent unhandled exceptions don't interleave frames.
        with _crash_log_lock, open(CRASH_LOG_PATH, "a") as f:
            f.write(f"\n--- {time.strftime('%Y-%m-%dT%H:%M:%S')} ---\n")
            f.write(f"Request: {request.url}\n")
            f.write(traceback.format_exc())
    except Exception:
        logger.exception("Failed to write crash log")
    logger.exception("Unhandled exception for %s", request.url)
    return JSONResponse({"detail": str(exc)}, status_code=500)

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
