import sys
import os
os.environ["PATH"] += os.pathsep + "/opt/homebrew/bin:/usr/local/bin"

try:
    from imageio_ffmpeg import get_ffmpeg_exe
    ffmpeg_path = get_ffmpeg_exe()
    os.environ["PATH"] = os.path.dirname(ffmpeg_path) + os.pathsep + os.environ.get("PATH", "")
except Exception as e:
    pass

import mlx_whisper
import time
import subprocess

audio_file = "/Users/user4/Desktop/voice-design/OmniVoice/data/preview/1c43531cb0ae.mov"

print("Starting transcription...", flush=True)
start = time.time()
result = mlx_whisper.transcribe(audio_file, path_or_hf_repo="mlx-community/whisper-large-v3-mlx")
transcript = result.get("text", "").strip()
trans_time = time.time() - start
print(f"Transcript ({trans_time:.2f}s):\n{transcript}\n")

# Baseline Google NMT
try:
    from deep_translator import GoogleTranslator
    print("Translating with Google NMT...", flush=True)
    start = time.time()
    google_tgt = GoogleTranslator(source="auto", target="bn")
    google_text = google_tgt.translate(transcript)
    google_time = time.time() - start
    print(f"Google Bengali ({google_time:.2f}s):\n{google_text}\n")
except Exception as e:
    print(f"Google Failed: {e}\n")

# APFEL
print("Translating with Apfel...", flush=True)
start = time.time()
try:
    prompt = f"You are a professional dubbing translator. Translate the following text into Bengali. Output ONLY the translated text.\n{transcript}"
    # Use login shell to ensure apfel alias/function is loaded
    prompt_esc = prompt.replace('"', '\\"')
    apfel_res = subprocess.run(["zsh", "-lc", f'apfel "{prompt_esc}"'], capture_output=True, text=True)
    apfel_time = time.time() - start
    if apfel_res.returncode == 0:
        print(f"Apfel Bengali ({apfel_time:.2f}s):\n{apfel_res.stdout.strip()}\n")
    else:
        print(f"Apfel CLI failed: {apfel_res.stderr}\n")
except Exception as e:
    print(f"Apfel Failed: {e}\n")
