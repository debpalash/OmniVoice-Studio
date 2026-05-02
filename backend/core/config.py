import os
import sys

def get_app_data_dir():
    custom_dir = os.environ.get("OMNIVOICE_DATA_DIR")
    if custom_dir:
        return custom_dir
        
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/OmniVoice")
    elif sys.platform == "win32":
        return os.path.join(os.environ.get("APPDATA", ""), "OmniVoice")
    else:
        return os.path.expanduser("~/.omnivoice")


def _ensure_short_hf_cache_on_windows():
    """Redirect HuggingFace cache to a short path on Windows.

    The default ``~/.cache/huggingface/hub/models--org--name/snapshots/<hash>/…``
    path regularly exceeds the 260-char MAX_PATH limit on NTFS, causing
    ``FileNotFoundError`` or truncated downloads on first install.  We shorten
    it to ``%LOCALAPPDATA%\\OmniVoice\\hf_cache`` (~40 chars) so even the
    deepest blob path stays well under the limit.

    Respects any explicit override the user already set via
    ``OMNIVOICE_CACHE_DIR``, ``HF_HOME``, or ``HF_HUB_CACHE``.
    """
    if sys.platform != "win32":
        return
    # Don't override if the user (or main.py's OMNIVOICE_CACHE_DIR block)
    # already pointed the cache somewhere specific.
    if os.environ.get("OMNIVOICE_CACHE_DIR") or os.environ.get("HF_HOME") or os.environ.get("HF_HUB_CACHE"):
        return
    local_app = os.environ.get("LOCALAPPDATA", "")
    if not local_app:
        return
    short_cache = os.path.join(local_app, "OmniVoice", "hf_cache")
    os.makedirs(short_cache, exist_ok=True)
    os.environ["HF_HOME"] = short_cache
    os.environ["HF_HUB_CACHE"] = short_cache

_ensure_short_hf_cache_on_windows()


DATA_DIR = get_app_data_dir()
VOICES_DIR = os.path.join(DATA_DIR, "voices")       # Reference audio for profiles
OUTPUTS_DIR = os.path.join(DATA_DIR, "outputs")      # Generated audio files
DUB_DIR = os.path.join(DATA_DIR, "dub_jobs")
DB_PATH = os.path.join(DATA_DIR, "omnivoice.db")
PREVIEW_DIR = os.path.join(DATA_DIR, "preview")
CRASH_LOG_PATH = os.path.join(DATA_DIR, "crash_log.txt")   # only written on unhandled exceptions
LOG_PATH = os.path.join(DATA_DIR, "omnivoice.log")          # rolling runtime log — what the Settings UI reads

IDLE_TIMEOUT_SECONDS = int(os.environ.get("OMNIVOICE_IDLE_TIMEOUT", "900"))
CPU_POOL_WORKERS = int(os.environ.get("OMNIVOICE_CPU_POOL", "0")) or min(8, (os.cpu_count() or 4))

def ensure_dirs():
    for d in [DATA_DIR, VOICES_DIR, OUTPUTS_DIR, DUB_DIR, PREVIEW_DIR]:
        os.makedirs(d, exist_ok=True)

ensure_dirs()

# Ensure ffmpeg is on PATH for Whisper and other subprocesses (mostly relevant for Mac/Linux)
if sys.platform != "win32":
    for _fpath in ["/opt/homebrew/bin", "/usr/local/bin"]:
        if _fpath not in os.environ.get("PATH", "") and os.path.exists(_fpath):
            os.environ["PATH"] = _fpath + os.pathsep + os.environ.get("PATH", "")
