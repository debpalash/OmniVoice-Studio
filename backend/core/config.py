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

DATA_DIR = get_app_data_dir()
VOICES_DIR = os.path.join(DATA_DIR, "voices")       # Reference audio for profiles
OUTPUTS_DIR = os.path.join(DATA_DIR, "outputs")      # Generated audio files
DUB_DIR = os.path.join(DATA_DIR, "dub_jobs")
DB_PATH = os.path.join(DATA_DIR, "omnivoice.db")
PREVIEW_DIR = os.path.join(DATA_DIR, "preview")
CRASH_LOG_PATH = os.path.join(DATA_DIR, "crash_log.txt")

IDLE_TIMEOUT_SECONDS = int(os.environ.get("OMNIVOICE_IDLE_TIMEOUT", "300"))
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
