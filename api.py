import io
import os
import uuid
import json
import shutil
import sqlite3
import tempfile
import asyncio
import subprocess
import logging
import time
from contextlib import asynccontextmanager
from typing import Optional, List
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import soundfile as sf
import torch
import torchaudio
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from omnivoice.models.omnivoice import OmniVoice

logger = logging.getLogger("omnivoice.api")

# ═══════════════════════════════════════════════════════════════════════
# PATHS & GLOBALS
# ═══════════════════════════════════════════════════════════════════════

DATA_DIR = os.path.join(os.path.dirname(__file__), "omnivoice_data")
VOICES_DIR = os.path.join(DATA_DIR, "voices")       # Reference audio for profiles
OUTPUTS_DIR = os.path.join(DATA_DIR, "outputs")      # Generated audio files
DUB_DIR = os.path.join(DATA_DIR, "dub_jobs")
DB_PATH = os.path.join(DATA_DIR, "omnivoice.db")

for d in [DATA_DIR, VOICES_DIR, OUTPUTS_DIR, DUB_DIR]:
    os.makedirs(d, exist_ok=True)

# Ensure ffmpeg is on PATH for Whisper and other subprocesses
for _fpath in ["/opt/homebrew/bin", "/usr/local/bin"]:
    if _fpath not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _fpath + ":" + os.environ.get("PATH", "")

model: Optional[OmniVoice] = None
_inference_pool = ThreadPoolExecutor(max_workers=1)
_dub_jobs = {}


# ═══════════════════════════════════════════════════════════════════════
# SQLITE DATABASE
# ═══════════════════════════════════════════════════════════════════════

def _get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _init_db():
    conn = _get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS voice_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ref_audio_path TEXT,
            ref_text TEXT DEFAULT '',
            instruct TEXT DEFAULT '',
            language TEXT DEFAULT 'Auto',
            created_at REAL
        );
        CREATE TABLE IF NOT EXISTS generation_history (
            id TEXT PRIMARY KEY,
            text TEXT,
            mode TEXT,
            language TEXT,
            instruct TEXT,
            profile_id TEXT,
            audio_path TEXT,
            duration_seconds REAL,
            generation_time REAL,
            created_at REAL,
            FOREIGN KEY (profile_id) REFERENCES voice_profiles(id)
        );
        CREATE TABLE IF NOT EXISTS dub_history (
            id TEXT PRIMARY KEY,
            filename TEXT,
            duration REAL,
            segments_count INTEGER,
            language TEXT,
            language_code TEXT,
            tracks TEXT DEFAULT '[]',
            job_data TEXT,
            created_at REAL
        );
    """)
    conn.commit()
    conn.close()


# ═══════════════════════════════════════════════════════════════════════
# APP LIFECYCLE
# ═══════════════════════════════════════════════════════════════════════

def get_best_device():
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    _init_db()
    device = get_best_device()
    print(f"Loading OmniVoice model on device: {device}...")
    checkpoint = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
    model = OmniVoice.from_pretrained(
        checkpoint, device_map=device, dtype=torch.float16, load_asr=True,
    )

    # Skip MPS warmup — it consumes too much memory on Apple Silicon
    # and the first real inference will warm things up naturally

    # Only apply torch.compile on CUDA (MPS compile causes GPU thrashing)
    try:
        if device == "cuda":
            model.llm = torch.compile(model.llm, mode="reduce-overhead")
            print("torch.compile applied.")
    except Exception as e:
        print(f"torch.compile skipped: {e}")

    print("OmniVoice model loaded successfully.")
    yield
    model = None


from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="OmniVoice Studio API", version="0.4.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

# Serve generated audio files statically
app.mount("/audio", StaticFiles(directory=OUTPUTS_DIR), name="audio")
app.mount("/voice_audio", StaticFiles(directory=VOICES_DIR), name="voice_audio")


# ═══════════════════════════════════════════════════════════════════════
# VOICE PROFILES (SQLite + disk)
# ═══════════════════════════════════════════════════════════════════════

@app.get("/profiles")
async def list_profiles():
    conn = _get_db()
    rows = conn.execute("SELECT * FROM voice_profiles ORDER BY created_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/profiles")
async def create_profile(
    name: str = Form(...),
    ref_audio: UploadFile = File(...),
    ref_text: str = Form(""),
    instruct: str = Form(""),
    language: str = Form("Auto"),
):
    profile_id = str(uuid.uuid4())[:8]
    ext = os.path.splitext(ref_audio.filename or ".wav")[1]
    audio_filename = f"{profile_id}{ext}"
    audio_path = os.path.join(VOICES_DIR, audio_filename)

    with open(audio_path, "wb") as f:
        f.write(await ref_audio.read())

    conn = _get_db()
    conn.execute(
        "INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, instruct, language, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (profile_id, name, audio_filename, ref_text, instruct, language, time.time())
    )
    conn.commit()
    conn.close()

    return {"id": profile_id, "name": name}


@app.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str):
    conn = _get_db()
    row = conn.execute("SELECT ref_audio_path FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if row and row["ref_audio_path"]:
        path = os.path.join(VOICES_DIR, row["ref_audio_path"])
        if os.path.exists(path):
            os.remove(path)
    conn.execute("DELETE FROM voice_profiles WHERE id=?", (profile_id,))
    conn.commit()
    conn.close()
    return {"deleted": profile_id}


# ═══════════════════════════════════════════════════════════════════════
# GENERATION HISTORY (SQLite + disk)
# ═══════════════════════════════════════════════════════════════════════

@app.get("/history")
async def list_history():
    conn = _get_db()
    rows = conn.execute("SELECT * FROM generation_history ORDER BY created_at DESC LIMIT 50").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.delete("/history")
async def clear_history():
    conn = _get_db()
    rows = conn.execute("SELECT audio_path FROM generation_history").fetchall()
    for r in rows:
        if r["audio_path"]:
            p = os.path.join(OUTPUTS_DIR, r["audio_path"])
            if os.path.exists(p):
                os.remove(p)
    conn.execute("DELETE FROM generation_history")
    conn.commit()
    conn.close()
    return {"cleared": True}


@app.get("/dub/history")
async def list_dub_history():
    conn = _get_db()
    rows = conn.execute("SELECT * FROM dub_history ORDER BY created_at DESC LIMIT 30").fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════════════
# TTS GENERATION
# ═══════════════════════════════════════════════════════════════════════

def _run_inference(
    text, language, ref_audio_path, ref_text, instruct, duration,
    num_step, guidance_scale, speed, t_shift, denoise,
    postprocess_output, layer_penalty_factor, position_temperature,
    class_temperature,
):
    audios = model.generate(
        text=text, language=language, ref_audio=ref_audio_path,
        ref_text=ref_text, instruct=instruct, duration=duration,
        num_step=num_step, guidance_scale=guidance_scale, speed=speed,
        t_shift=t_shift, denoise=denoise, postprocess_output=postprocess_output,
        layer_penalty_factor=layer_penalty_factor,
        position_temperature=position_temperature,
        class_temperature=class_temperature,
    )
    return audios[0]  # shape (1, T)


@app.post("/generate")
async def generate_speech(
    text: str = Form(...),
    language: Optional[str] = Form(None),
    ref_audio: Optional[UploadFile] = File(None),
    ref_text: Optional[str] = Form(None),
    instruct: Optional[str] = Form(None),
    duration: Optional[float] = Form(None),
    num_step: int = Form(16),
    guidance_scale: float = Form(2.0),
    speed: float = Form(1.0),
    t_shift: float = Form(0.1),
    denoise: bool = Form(True),
    postprocess_output: bool = Form(True),
    layer_penalty_factor: float = Form(5.0),
    position_temperature: float = Form(5.0),
    class_temperature: float = Form(0.0),
    profile_id: Optional[str] = Form(None),
):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    ref_audio_path = None
    cleanup_ref = False

    # Load from voice profile if specified
    if profile_id:
        conn = _get_db()
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        conn.close()
        if row:
            ref_audio_path = os.path.join(VOICES_DIR, row["ref_audio_path"])
            if not ref_text:
                ref_text = row["ref_text"]
            if not instruct:
                instruct = row["instruct"]
            if not language or language == "Auto":
                language = row["language"] if row["language"] != "Auto" else None
    elif ref_audio is not None:
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:
                f.write(await ref_audio.read())
                ref_audio_path = f.name
                cleanup_ref = True
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    start_time = time.time()
    try:
        loop = asyncio.get_event_loop()
        audio_tensor = await loop.run_in_executor(
            _inference_pool, _run_inference,
            text, language, ref_audio_path, ref_text, instruct, duration,
            num_step, guidance_scale, speed, t_shift, denoise,
            postprocess_output, layer_penalty_factor, position_temperature,
            class_temperature,
        )
        gen_time = round(time.time() - start_time, 2)

        # Save to disk + DB
        audio_id = str(uuid.uuid4())[:8]
        audio_filename = f"{audio_id}.wav"
        audio_path = os.path.join(OUTPUTS_DIR, audio_filename)
        torchaudio.save(audio_path, audio_tensor, model.sampling_rate)

        audio_dur = round(audio_tensor.shape[-1] / model.sampling_rate, 2)

        conn = _get_db()
        conn.execute(
            "INSERT INTO generation_history (id, text, mode, language, instruct, profile_id, audio_path, duration_seconds, generation_time, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (audio_id, text[:200], "clone" if ref_audio_path else "design",
             language or "Auto", instruct or "", profile_id or "",
             audio_filename, audio_dur, gen_time, time.time())
        )
        conn.commit()
        conn.close()

        # Also return the WAV bytes for immediate playback
        buffer = io.BytesIO()
        torchaudio.save(buffer, audio_tensor, model.sampling_rate, format="wav")
        buffer.seek(0)
        return Response(
            content=buffer.read(), media_type="audio/wav",
            headers={"X-Audio-Id": audio_id, "X-Gen-Time": str(gen_time), "X-Audio-Path": audio_filename}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")
    finally:
        if cleanup_ref and ref_audio_path and os.path.exists(ref_audio_path):
            os.remove(ref_audio_path)


# ═══════════════════════════════════════════════════════════════════════
# VIDEO DUBBING PIPELINE
# ═══════════════════════════════════════════════════════════════════════

def _find_ffmpeg():
    for path in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"]:
        if shutil.which(path):
            return path
    raise RuntimeError("ffmpeg not found")


def _find_ffprobe():
    for path in ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "ffprobe"]:
        if shutil.which(path):
            return path
    raise RuntimeError("ffprobe not found")


@app.post("/dub/upload")
async def dub_upload(video: UploadFile = File(...)):
    job_id = str(uuid.uuid4())[:8]
    job_dir = os.path.join(DUB_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    ext = os.path.splitext(video.filename or "video.mp4")[1]
    video_path = os.path.join(job_dir, f"original{ext}")
    with open(video_path, "wb") as f:
        f.write(await video.read())

    audio_path = os.path.join(job_dir, "audio.wav")
    ffmpeg = _find_ffmpeg()
    try:
        subprocess.run([
            ffmpeg, "-i", video_path, "-vn", "-acodec", "pcm_s16le",
            "-ar", "16000", "-ac", "1", audio_path, "-y"
        ], check=True, capture_output=True, timeout=120)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg failed: {e.stderr.decode()}")

    ffprobe = _find_ffprobe()
    try:
        result = subprocess.run([
            ffprobe, "-v", "error", "-show_entries", "format=duration",
            "-of", "json", video_path
        ], capture_output=True, text=True, timeout=30)
        dur = float(json.loads(result.stdout)["format"]["duration"])
    except Exception:
        dur = 0.0

    # Run demucs to isolate vocals vs background music
    vocals_path = os.path.join(job_dir, "vocals.wav")
    no_vocals_path = os.path.join(job_dir, "no_vocals.wav")
    try:
        # Run demucs CLI to strictly output 2 stems
        subprocess.run([
            "uv", "run", "demucs", "--two-stems", "vocals", "-n", "htdemucs", "-d", "mps",
            audio_path, "-o", job_dir
        ], check=True, capture_output=True, timeout=300)
        
        # Demucs creates an output structure: htdemucs/audio/vocals.wav
        demucs_out = os.path.join(job_dir, "htdemucs", "audio")
        if os.path.exists(os.path.join(demucs_out, "vocals.wav")):
            import shutil
            shutil.move(os.path.join(demucs_out, "vocals.wav"), vocals_path)
            shutil.move(os.path.join(demucs_out, "no_vocals.wav"), no_vocals_path)
            # Remove demucs temp dir
            shutil.rmtree(os.path.join(job_dir, "htdemucs"))
    except Exception as e:
        logger.warning(f"Demucs failed, falling back to mixed audio. {e}")
        vocals_path = audio_path
        no_vocals_path = None

    _dub_jobs[job_id] = {
        "video_path": video_path, 
        "audio_path": audio_path,
        "vocals_path": vocals_path,
        "no_vocals_path": no_vocals_path,
        "duration": dur, "filename": video.filename,
        "segments": None, "dubbed_tracks": {},
    }
    return {"job_id": job_id, "duration": round(dur, 2), "filename": video.filename}


def _get_job(job_id: str):
    if job_id in _dub_jobs:
        return _dub_jobs[job_id]
    conn = _get_db()
    row = conn.execute("SELECT job_data FROM dub_history WHERE id=?", (job_id,)).fetchone()
    conn.close()
    if row and row["job_data"]:
        try:
            job = json.loads(row["job_data"])
            _dub_jobs[job_id] = job
            return job
        except:
            pass
    return None

@app.post("/dub/transcribe/{job_id}")
async def dub_transcribe(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if model is None or model._asr_pipe is None:
        raise HTTPException(status_code=503, detail="ASR not loaded")

    def _transcribe():
        import re
        # Load pure vocal audio as numpy array for vastly improved Whisper accuracy
        asr_audio_target = job.get("vocals_path", job.get("audio_path"))
        audio_np, sr = sf.read(asr_audio_target, dtype="float32")
        if audio_np.ndim > 1:
            audio_np = audio_np.mean(axis=1)
        audio_input = {"array": audio_np, "sampling_rate": sr}

        # Use chunk-level timestamps (lightweight on MPS) then split into sentences
        result = model._asr_pipe(
            audio_input, return_timestamps=True,
            chunk_length_s=15, batch_size=1,
        )

        # Split chunks into sentences using punctuation
        sentence_enders = re.compile(r'(?<=[.!?。？！])\s+')
        segments = []

        if "chunks" in result:
            for chunk in result["chunks"]:
                ts = chunk.get("timestamp", (0, 0))
                chunk_start = ts[0] if ts[0] is not None else 0.0
                chunk_end = ts[1] if ts[1] is not None else chunk_start + 1.0
                chunk_text = chunk.get("text", "").strip()

                if not chunk_text:
                    continue

                # Split this chunk into sentences
                sentences = sentence_enders.split(chunk_text)
                sentences = [s.strip() for s in sentences if s.strip()]

                if len(sentences) <= 1:
                    segments.append({
                        "start": round(chunk_start, 2),
                        "end": round(chunk_end, 2),
                        "text": chunk_text,
                    })
                else:
                    # Distribute time proportionally across sentences
                    total_chars = sum(len(s) for s in sentences)
                    chunk_dur = chunk_end - chunk_start
                    t = chunk_start
                    for sent in sentences:
                        ratio = len(sent) / max(total_chars, 1)
                        sent_dur = chunk_dur * ratio
                        segments.append({
                            "start": round(t, 2),
                            "end": round(t + sent_dur, 2),
                            "text": sent,
                        })
                        t += sent_dur
        else:
            segments.append({"start": 0.0, "end": job["duration"], "text": result.get("text", "").strip()})

        # Store full transcript
        job["full_transcript"] = " ".join(s["text"] for s in segments)

        # Free MPS memory
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

        return segments

    loop = asyncio.get_event_loop()
    segments = await loop.run_in_executor(_inference_pool, _transcribe)
    job["segments"] = segments
    return {
        "job_id": job_id,
        "segments": segments,
        "full_transcript": job.get("full_transcript", ""),
    }


class DubSegment(BaseModel):
    start: float
    end: float
    text: str
    instruct: str = ""       # Per-segment voice override
    profile_id: str = ""     # Per-segment voice profile


class DubRequest(BaseModel):
    segments: List[DubSegment]
    language: str = "Auto"
    language_code: str = "und"  # ISO 639-1 for ffmpeg metadata (e.g. "es", "fr", "de")
    instruct: str = ""
    num_step: int = 16
    guidance_scale: float = 2.0
    speed: float = 1.0


@app.post("/dub/generate/{job_id}")
async def dub_generate(job_id: str, req: DubRequest):
    """Generate TTS per segment. Returns SSE progress stream."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def _stream():
        total = len(req.segments)
        all_segment_wavs = []

        for i, seg in enumerate(req.segments):
            yield f"data: {json.dumps({'type': 'progress', 'current': i, 'total': total, 'text': seg.text[:50]})}\n\n"

            seg_duration = seg.end - seg.start
            if seg_duration <= 0.05 or not seg.text.strip():
                sr = model.sampling_rate
                silence = torch.zeros(1, int(seg_duration * sr))
                all_segment_wavs.append((seg.start, seg.end, silence, sr))
                continue

            def _gen(text, lang, instruct_str, dur_s, nstep, cfg, spd, profile_id=None):
                ref_audio = None
                ref_text = None
                # Load per-segment voice profile if specified
                if profile_id:
                    conn = _get_db()
                    row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
                    conn.close()
                    if row:
                        ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                        ref_text = row["ref_text"]
                        if not instruct_str:
                            instruct_str = row["instruct"]
                return model.generate(
                    text=text, language=lang if lang != "Auto" else None,
                    ref_audio=ref_audio, ref_text=ref_text,
                    instruct=instruct_str if instruct_str else None,
                    duration=dur_s, num_step=nstep, guidance_scale=cfg,
                    speed=spd, denoise=True, postprocess_output=True,
                )[0]

            # Use per-segment instruct/profile if set, otherwise fall back to request-level
            seg_instruct = seg.instruct or req.instruct
            seg_profile = seg.profile_id or None

            loop = asyncio.get_event_loop()
            try:
                audio_tensor = await loop.run_in_executor(
                    _inference_pool, _gen,
                    seg.text, req.language, seg_instruct, seg_duration,
                    req.num_step, req.guidance_scale, req.speed, seg_profile,
                )
                # Save individual segment WAV for preview
                seg_wav_path = os.path.join(DUB_DIR, job_id, f"seg_{i}.wav")
                torchaudio.save(seg_wav_path, audio_tensor, model.sampling_rate)
                all_segment_wavs.append((seg.start, seg.end, audio_tensor, model.sampling_rate))
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'segment': i, 'error': str(e)})}\n\n"
                sr = model.sampling_rate
                all_segment_wavs.append((seg.start, seg.end, torch.zeros(1, int(seg_duration * sr)), sr))

        yield f"data: {json.dumps({'type': 'assembling'})}\n\n"

        sr = model.sampling_rate
        total_samples = int(job["duration"] * sr)
        full_audio = torch.zeros(1, total_samples)

        for start, end, wav, _ in all_segment_wavs:
            s = int(start * sr)
            wl = wav.shape[-1]
            e = min(s + wl, total_samples)
            full_audio[:, s:e] = wav[:, :e - s]

        # Save this dubbed track with the language code
        lang_code = req.language_code or "und"
        track_path = os.path.join(DUB_DIR, job_id, f"dubbed_{lang_code}.wav")
        torchaudio.save(track_path, full_audio, sr)
        job["dubbed_tracks"][lang_code] = {
            "path": track_path,
            "language": req.language,
            "language_code": lang_code,
        }

        # Save to dub_history
        try:
            conn = _get_db()
            conn.execute(
                "INSERT OR REPLACE INTO dub_history (id, filename, duration, segments_count, language, language_code, tracks, job_data, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (job_id, job.get("filename", ""), job.get("duration", 0), total,
                 req.language, lang_code, json.dumps(list(job["dubbed_tracks"].keys())),
                 json.dumps(job, default=str), time.time())
            )
            conn.commit()
            conn.close()
        except Exception as e:
            logger.error(f"Failed to save dub history: {e}")

        yield f"data: {json.dumps({'type': 'done', 'segments_processed': total, 'language_code': lang_code, 'tracks': list(job['dubbed_tracks'].keys())})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")


@app.get("/dub/tracks/{job_id}")
async def dub_list_tracks(job_id: str):
    """List all dubbed language tracks for a job."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"tracks": job.get("dubbed_tracks", {})}


@app.get("/dub/download/{job_id}")
@app.get("/dub/download/{job_id}/{filename}")
async def dub_download(job_id: str, preserve_bg: bool = Query(True, description="Mix background noise into dubbed tracks"), make_default: bool = Query(True)):
    """Mux ALL dubbed language tracks into the video.
    If preserve_bg=true, mixes isolated background noise seamlessly into each dubbed string.
    If make_default=true, sets the FIRST dubbed language track as the default audio track."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    tracks = job.get("dubbed_tracks", {})
    if not tracks:
        raise HTTPException(status_code=400, detail="No dubbed tracks generated yet")

    video_path = job["video_path"]
    output_path = os.path.join(DUB_DIR, job_id, "dubbed_video_final.mp4")
    ffmpeg = _find_ffmpeg()

    cmd = [ffmpeg, "-i", video_path]
    input_idx = 1
    
    bg_audio = job.get("no_vocals_path") if preserve_bg else None
    bg_idx = None
    if bg_audio and os.path.exists(bg_audio):
        cmd += ["-i", bg_audio]
        bg_idx = input_idx
        input_idx += 1

    tracks_to_process = []
    for lang_code, track_info in tracks.items():
        cmd += ["-i", track_info["path"]]
        tracks_to_process.append({"lang_code": lang_code, "idx": input_idx, "info": track_info})
        input_idx += 1

    # Map original video and original audio
    cmd += ["-map", "0:v:0", "-map", "0:a:0"]

    if bg_idx is not None:
        filters = []
        for i, t in enumerate(tracks_to_process):
            out_label = f"[aout{i}]"
            # Normalize mixing so neither drops off unexpectedly
            filters.append(f"[{bg_idx}:a][{t['idx']}:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=0.8 1.2{out_label}")
            t["out_label"] = out_label
        cmd += ["-filter_complex", ";".join(filters)]
        for t in tracks_to_process:
            cmd += ["-map", t["out_label"]]
    else:
        for t in tracks_to_process:
            cmd += ["-map", f"{t['idx']}:a:0"]

    if bg_idx is not None:
        cmd += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]
        
    cmd += ["-metadata:s:a:0", "language=und", "-metadata:s:a:0", "title=Original"]

    for idx, t in enumerate(tracks_to_process):
        stream_idx = idx + 1
        cmd += [
            f"-metadata:s:a:{stream_idx}", f"language={t['lang_code']}",
            f"-metadata:s:a:{stream_idx}", f"title={t['info']['language']}"
        ]

    # Explicit default audio tracks handling
    if make_default and tracks_to_process:
        cmd += ["-disposition:a:0", "0"] # Remove default from original
        cmd += ["-disposition:a:1", "default"] # Give default to first dub track
    else:
        cmd += ["-disposition:a:0", "default"]

    cmd += ["-shortest", output_path, "-y"]

    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=300)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg mux failed: {e.stderr.decode()}")

    base_name = os.path.splitext(job.get('filename', 'output'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'output'
    dl_name = f"dubbed_{safe_name}.mp4"
    return FileResponse(
        output_path, media_type="video/mp4",
        headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
    )


# ═══════════════════════════════════════════════════════════════════════
# TRANSLATION
# ═══════════════════════════════════════════════════════════════════════

# Google Translate language codes for common dub targets
TRANSLATE_CODES = {
    "en": "en", "es": "es", "fr": "fr", "de": "de", "it": "it", "pt": "pt",
    "ru": "ru", "ja": "ja", "ko": "ko", "zh": "zh-CN", "ar": "ar", "hi": "hi",
    "tr": "tr", "pl": "pl", "nl": "nl", "sv": "sv", "th": "th", "vi": "vi",
    "id": "id", "uk": "uk",
}


class TranslateRequest(BaseModel):
    segments: List[dict]  # [{"id": 0, "text": "..."}]
    target_lang: str  # ISO 639-1 code like "es", "fr"


@app.post("/dub/translate")
async def dub_translate(req: TranslateRequest):
    """Translate all segment texts to the target language using Google Translate."""
    from deep_translator import GoogleTranslator

    lang_code = TRANSLATE_CODES.get(req.target_lang, req.target_lang)

    def _translate():
        translator = GoogleTranslator(source="auto", target=lang_code)
        results = []
        for seg in req.segments:
            try:
                translated = translator.translate(seg["text"])
                results.append({"id": seg["id"], "text": translated or seg["text"]})
            except Exception as e:
                results.append({"id": seg["id"], "text": seg["text"], "error": str(e)})
        return results

    loop = asyncio.get_event_loop()
    translated = await loop.run_in_executor(None, _translate)
    return {"translated": translated, "target_lang": req.target_lang}


# ═══════════════════════════════════════════════════════════════════════
# SEGMENT PREVIEW
# ═══════════════════════════════════════════════════════════════════════

@app.get("/dub/preview/{job_id}/{segment_index}")
async def dub_preview_segment(job_id: str, segment_index: int):
    """Return the WAV for a single dubbed segment (generated during /dub/generate)."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    seg_path = os.path.join(DUB_DIR, job_id, f"seg_{segment_index}.wav")
    if not os.path.exists(seg_path):
        raise HTTPException(status_code=404, detail="Segment not generated yet")
    return FileResponse(seg_path, media_type="audio/wav")


# ═══════════════════════════════════════════════════════════════════════
# AUDIO-ONLY DOWNLOAD (timestamp-synced)
# ═══════════════════════════════════════════════════════════════════════

@app.get("/dub/download-audio/{job_id}")
@app.get("/dub/download-audio/{job_id}/{filename}")
async def dub_download_audio(job_id: str, lang: str = Query(None), preserve_bg: bool = Query(True)):
    """Download just the dubbed audio track (WAV). Timestamp-synced with original video."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    
    tracks = job.get("dubbed_tracks", {})

    if lang and lang in tracks:
        wav_path = tracks[lang]["path"]
    elif tracks:
        # Return first available track
        wav_path = list(tracks.values())[0]["path"]
    else:
        raise HTTPException(status_code=400, detail="No dubbed audio track generated yet")

    if not os.path.exists(wav_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    lang_label = lang or list(tracks.keys())[0]
    base_name = os.path.splitext(job.get('filename', 'audio'))[0]
    
    bg_audio = job.get("no_vocals_path") if preserve_bg else None
    if bg_audio and os.path.exists(bg_audio):
        ffmpeg = _find_ffmpeg()
        final_audio_path = os.path.join(DUB_DIR, job_id, f"mixed_dub_{lang_label}.wav")
        cmd = [
            ffmpeg, "-i", bg_audio, "-i", wav_path,
            "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=0.8 1.2[aout]",
            "-map", "[aout]", "-c:a", "pcm_s16le", "-y", final_audio_path
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            wav_path = final_audio_path
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to mix audio: {e.stderr.decode()}")
            
    base_name = os.path.splitext(job.get('filename', 'audio'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'audio'
    dl_name = f"dubbed_audio_{lang_label}_{safe_name}.wav"
    return FileResponse(
        wav_path, media_type="audio/wav",
        headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
    )


# ═══════════════════════════════════════════════════════════════════════
# SRT SUBTITLE EXPORT
# ═══════════════════════════════════════════════════════════════════════

def _format_srt_time(seconds):
    """Format seconds as SRT timestamp: HH:MM:SS,mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


@app.get("/dub/srt/{job_id}")
@app.get("/dub/srt/{job_id}/{filename}")
async def dub_export_srt(job_id: str):
    """Export transcript segments as an SRT subtitle file."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    
    segments = job.get("segments", [])
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript segments available")

    srt_lines = []
    for i, seg in enumerate(segments):
        start_ts = _format_srt_time(seg["start"])
        end_ts = _format_srt_time(seg["end"])
        srt_lines.append(f"{i + 1}")
        srt_lines.append(f"{start_ts} --> {end_ts}")
        srt_lines.append(seg["text"])
        srt_lines.append("")

    srt_content = "\n".join(srt_lines)

    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    return Response(
        content=srt_content,
        media_type="text/plain",
        headers={
            "Content-Disposition": f'attachment; filename="subtitles_{base_name}.srt"',
        },
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
