"""
Dub-pipeline service — Phase 2.4 (ROADMAP.md).

Extracts the non-HTTP business logic out of the 889-line `dub_core.py` router
so the router can stay thin (HTTP concerns only) and this module can be
imported cleanly by other routers (dub_generate, dub_translate, dub_export)
and future callers (the Tools page, the headless CLI, tests).

What's here
-----------
* **Job state** — `_dub_jobs` in-memory dict + `get_job` / `save_job` that
  hydrate from `dub_history.job_data` on cache miss.
* **Content-hash cache lookup** — `compute_file_hash`, `find_cached_job`.
* **Safe path resolution** — `safe_job_dir`.
* **Process lifecycle** — ffmpeg/demucs subprocess tracking + `kill_job_procs`
  so `POST /dub/abort/{id}` can tear down in-flight work.
* **SSE helpers** — `sse_event`, `prep_event`.

What stays in the router
------------------------
The route decorators + request-body validation + response shaping. The big
ingest/transcribe generators still live there for now — they're tightly
coupled to FastAPI's `StreamingResponse`/async-generator contract, and
moving them is a follow-up.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import threading
import time
from typing import AsyncIterator, Optional

import soundfile as sf

from core.config import DUB_DIR
from fastapi import HTTPException
from services.ffmpeg_utils import find_ffmpeg, _get_semaphore, _spawn_with_retry
from services.model_manager import get_best_device
from core.db import db_conn, get_db

logger = logging.getLogger("omnivoice.dub_pipeline")

# ── Module-level state ──────────────────────────────────────────────────────
# These used to live in dub_core.py. The router now re-exports them for
# backward compat during the transition.

_dub_jobs: dict[str, dict] = {}
_active_procs: dict[str, list] = {}
_active_procs_lock = threading.Lock()

_DUB_DIR_REAL = os.path.realpath(DUB_DIR)
_HASH_BUF_SIZE = 1 << 18  # 256 KB chunks for hashing


# ── Pure helpers ────────────────────────────────────────────────────────────


def compute_file_hash(path: str) -> str:
    """SHA-256 digest of a file, streamed in 256 KB chunks."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(_HASH_BUF_SIZE)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def safe_job_dir(job_id: str) -> Optional[str]:
    """Resolve a job directory under DUB_DIR, rejecting traversal."""
    if not job_id or "/" in job_id or "\\" in job_id or job_id in (".", ".."):
        return None
    candidate = os.path.realpath(os.path.join(DUB_DIR, job_id))
    if not candidate.startswith(_DUB_DIR_REAL + os.sep):
        return None
    return candidate


def sse_event(event: str, payload) -> bytes:
    """Encode one Server-Sent Event frame. UTF-8 bytes, ready to yield."""
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def prep_event(event_type: str, **fields) -> str:
    """Build a `data:` SSE line for the ingest pipeline (plain `data: {...}`)."""
    return f"data: {json.dumps({'type': event_type, **fields})}\n\n"


# ── Content-hash cache lookup ───────────────────────────────────────────────


def find_cached_job(content_hash: str, exclude_job_id: str) -> Optional[dict]:
    """Find a previous job with the same content hash that has the heavy
    artifacts (vocals/no-vocals/scene cuts) still on disk. Returns a dict
    of paths + metadata the caller can shallow-copy into the new job, or
    None if no usable cache exists.
    """
    if not content_hash:
        return None
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, job_data FROM dub_history WHERE content_hash=? AND id!=? ORDER BY created_at DESC LIMIT 5",
            (content_hash, exclude_job_id),
        ).fetchall()
    finally:
        conn.close()
    for row in rows:
        try:
            job = json.loads(row["job_data"])
        except (json.JSONDecodeError, TypeError):
            continue
        cached_dir = safe_job_dir(row["id"])
        if not cached_dir or not os.path.isdir(cached_dir):
            continue
        vocals = job.get("vocals_path") or os.path.join(cached_dir, "vocals.wav")
        if not os.path.isfile(vocals):
            continue
        return {
            "job_dir": cached_dir,
            "job_id": row["id"],
            "vocals_path": vocals,
            "no_vocals_path": job.get("no_vocals_path"),
            "scene_cuts": job.get("scene_cuts") or [],
            "thumb_path": job.get("thumb_path"),
            "duration": job.get("duration", 0.0),
        }
    return None


# ── Process lifecycle ───────────────────────────────────────────────────────


def register_proc(job_id: str, proc) -> None:
    """Track an in-flight subprocess so /dub/abort can kill it."""
    with _active_procs_lock:
        _active_procs.setdefault(job_id, []).append(proc)


def unregister_proc(job_id: str, proc) -> None:
    with _active_procs_lock:
        lst = _active_procs.get(job_id)
        if lst and proc in lst:
            lst.remove(proc)
        if lst is not None and not lst:
            _active_procs.pop(job_id, None)


def kill_job_procs(job_id: str) -> None:
    """Kill every subprocess still running under a given job id. Idempotent."""
    with _active_procs_lock:
        procs = list(_active_procs.get(job_id, []))
    for proc in procs:
        try:
            if proc.returncode is None:
                proc.kill()
        except ProcessLookupError:
            pass
        except Exception as e:
            logger.warning("Failed to kill subprocess for %s: %s", job_id, e)
    with _active_procs_lock:
        _active_procs.pop(job_id, None)


def has_active_procs(job_id: str) -> bool:
    with _active_procs_lock:
        return bool(_active_procs.get(job_id))


# ── Job state (in-memory + SQLite fallback) ────────────────────────────────


def get_job(job_id: str) -> Optional[dict]:
    """Look up a job. Checks the in-memory cache first, then falls back to
    `dub_history.job_data` so saved projects still resolve after restart.
    """
    if job_id in _dub_jobs:
        return _dub_jobs[job_id]
    conn = get_db()
    try:
        row = conn.execute("SELECT job_data FROM dub_history WHERE id=?", (job_id,)).fetchone()
    finally:
        conn.close()
    if row and row["job_data"]:
        try:
            job = json.loads(row["job_data"])
            _dub_jobs[job_id] = job
            return job
        except json.JSONDecodeError as e:
            logger.error("Failed to decode dub_history.job_data for %s: %s", job_id, e)
    return None


def put_job(job_id: str, job: dict) -> None:
    """Insert / replace the in-memory job record. Does NOT persist."""
    _dub_jobs[job_id] = job


def save_job(job_id: str, job: dict, filename: str = "", duration: float = 0.0, content_hash: str = "") -> None:
    """Persist dub job state to SQLite so it survives restarts. Uses UPSERT
    on `id` so repeated saves in a session keep the latest snapshot.
    """
    try:
        segments = job.get("segments") or []
        tracks = list((job.get("dubbed_tracks") or {}).keys())
        with db_conn() as conn:
            conn.execute(
                """INSERT INTO dub_history
                   (id, filename, duration, segments_count, language, language_code, tracks, job_data, content_hash, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     filename=excluded.filename,
                     duration=excluded.duration,
                     segments_count=excluded.segments_count,
                     tracks=excluded.tracks,
                     job_data=excluded.job_data,
                     content_hash=CASE WHEN excluded.content_hash != '' THEN excluded.content_hash ELSE dub_history.content_hash END""",
                (job_id, filename or job.get("filename", ""),
                 duration or job.get("duration", 0.0),
                 len(segments), job.get("language", ""), job.get("language_code", ""),
                 json.dumps(tracks), json.dumps(job, default=str), content_hash or "", time.time()),
            )
    except Exception as e:
        logger.error("Failed to persist dub job %s: %s", job_id, e)


# ── Ingest pipeline (download → extract → demucs → scene → thumb) ──────────


def run_proc_factory(job_id: str):
    """Return an async `run_proc` helper bound to this job_id.

    Spawns subprocesses under the shared ffmpeg semaphore, tracks them so
    `kill_job_procs(job_id)` can terminate them, raises HTTP 504 on timeout.
    """
    async def run_proc(cmd, timeout: float = 900.0):
        async with _get_semaphore():
            p = await _spawn_with_retry(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            register_proc(job_id, p)
            try:
                try:
                    stdout, stderr = await asyncio.wait_for(p.communicate(), timeout=timeout)
                except asyncio.TimeoutError:
                    try:
                        p.kill()
                    except ProcessLookupError:
                        pass
                    try:
                        await asyncio.wait_for(p.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        pass
                    raise HTTPException(status_code=504, detail=f"subprocess timed out after {timeout}s")
                return p, stdout, stderr
            finally:
                unregister_proc(job_id, p)
                if p.returncode is None:
                    try:
                        p.kill()
                    except ProcessLookupError:
                        pass
                    try:
                        await asyncio.wait_for(p.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        pass
    return run_proc


def yt_download_sync(
    url: str,
    job_dir: str,
    *,
    fetch_subs: bool = False,
    sub_langs: list[str] | None = None,
) -> tuple[str, str, list[str]]:
    """Blocking yt-dlp download into `job_dir`.

    Returns (video_path, title, downloaded_sub_files).

    When `fetch_subs` is True we also ask yt-dlp to download both
    manually-uploaded (`writesubtitles=True`) and auto-generated / auto-
    translated captions (`writeautomaticsub=True`). This is how we pull
    YouTube's free machine translations without needing a Google API key —
    yt-dlp talks to the same public endpoints the YouTube player does.
    `sub_langs` controls which language tracks to ask for; default `['all']`
    grabs whatever the uploader / auto-translator makes available.
    """
    import glob
    import yt_dlp
    outtmpl = os.path.join(job_dir, "original.%(ext)s")
    ydl_opts: dict = {
        "outtmpl": outtmpl,
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "socket_timeout": 30,
    }
    if fetch_subs:
        ydl_opts.update({
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": list(sub_langs) if sub_langs else ["all"],
            "subtitlesformat": "vtt",
        })
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = ydl.prepare_filename(info)
        root, _ = os.path.splitext(path)
        mp4 = root + ".mp4"
        if os.path.exists(mp4):
            video_path = mp4
        else:
            video_path = path
    sub_files: list[str] = []
    if fetch_subs:
        # yt-dlp names captions "<base>.<lang>.vtt"; scoop them all.
        base = os.path.splitext(video_path)[0]
        sub_files = sorted(glob.glob(base + ".*.vtt"))
    return video_path, info.get("title") or os.path.basename(video_path), sub_files


def parse_vtt_segments(vtt_path: str) -> list[dict]:
    """Very small WEBVTT parser → list of {start, end, text}.

    Purpose: turn yt-dlp's downloaded caption track into the same segment
    shape the dub pipeline's transcript step produces, so the UI can seed
    its editor from YouTube captions instead of running Whisper. We don't
    care about positioning cues or styling — just the timed text.
    """
    try:
        with open(vtt_path, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return []

    def _ts(s: str) -> float:
        # Format: HH:MM:SS.mmm or MM:SS.mmm
        parts = s.strip().split(":")
        try:
            parts = [float(p.replace(",", ".")) for p in parts]
        except ValueError:
            return 0.0
        if len(parts) == 3:
            h, m, sec = parts
        elif len(parts) == 2:
            h, m, sec = 0.0, parts[0], parts[1]
        else:
            return 0.0
        return h * 3600.0 + m * 60.0 + sec

    segments: list[dict] = []
    blocks = raw.replace("\r\n", "\n").split("\n\n")
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() and not ln.startswith("WEBVTT") and not ln.startswith("NOTE")]
        if not lines:
            continue
        # Skip numeric cue ID line if present
        if "-->" not in lines[0] and len(lines) > 1:
            lines = lines[1:]
        if not lines or "-->" not in lines[0]:
            continue
        ts_line = lines[0]
        try:
            left, right = ts_line.split("-->")
            # Drop any settings after the right timestamp ("00:01.000 align:left line:0%")
            right = right.strip().split(" ")[0]
            start = _ts(left)
            end = _ts(right)
        except Exception:
            continue
        text = " ".join(ln.strip() for ln in lines[1:]).strip()
        # Strip inline styling like <c.colorE5E5E5>foo</c> or <00:00:01.200>
        import re as _re
        text = _re.sub(r"<[^>]+>", "", text)
        if text:
            segments.append({"start": start, "end": end, "text": text})
    return segments


async def ingest_pipeline(
    job_id: str,
    job_dir: str,
    source: dict,
    filename_hint: Optional[str] = None,
) -> AsyncIterator[str]:
    """Async generator: emit SSE events per processing stage.

    Stages: download_start, download_done, extract_start, extract_done,
    demucs_start, demucs_done, scene_start, scene_done, ready, error, cancelled.
    """
    youtube_subs_by_lang: dict[str, list[dict]] = {}
    try:
        if source.get("kind") == "url":
            url = source["url"]
            fetch_subs = bool(source.get("fetch_subs"))
            sub_langs = source.get("sub_langs") or None
            yield prep_event("download_start", url=url)
            try:
                video_path, title, sub_files = await asyncio.to_thread(
                    yt_download_sync, url, job_dir,
                    fetch_subs=fetch_subs, sub_langs=sub_langs,
                )
            except Exception as e:
                yield prep_event("error", stage="download", error=str(e)[:300])
                shutil.rmtree(job_dir, ignore_errors=True)
                return
            filename = title or os.path.basename(video_path)
            try:
                size = os.path.getsize(video_path)
            except OSError:
                size = 0
            # Parse each downloaded .<lang>.vtt into a segment list we can
            # stash on the job. The router will merge this into the job dict
            # after ingest completes so /dub/transcribe-stream (or a future
            # "use-youtube-subs" toggle) can seed segments from it.
            for sf_path in sub_files:
                base = os.path.splitext(os.path.basename(sf_path))[0]
                # "original.en" → lang "en"; fallback to the trailing token.
                lang_tag = base.rsplit(".", 1)[-1] if "." in base else "und"
                segs = parse_vtt_segments(sf_path)
                if segs:
                    youtube_subs_by_lang[lang_tag] = segs
            yield prep_event(
                "download_done",
                title=title, size=size, filename=filename,
                youtube_subs=sorted(youtube_subs_by_lang.keys()),
            )
        else:
            video_path = source["path"]
            filename = filename_hint or os.path.basename(video_path)

        audio_path = os.path.join(job_dir, "audio.wav")
        ffmpeg = find_ffmpeg()
        run_proc = run_proc_factory(job_id)

        yield prep_event("extract_start")
        try:
            p, _, stderr = await run_proc([
                ffmpeg, "-i", video_path, "-vn", "-acodec", "pcm_s16le",
                "-ar", "16000", "-ac", "1", audio_path, "-y",
            ])
            if p.returncode != 0:
                raise Exception(stderr.decode(errors="replace")[:500])
        except asyncio.CancelledError:
            raise
        except Exception as e:
            yield prep_event("error", stage="extract", error=str(e)[:300])
            return

        try:
            dur = float(sf.info(audio_path).frames) / float(sf.info(audio_path).samplerate)
        except Exception:
            dur = 0.0

        # Content-hash cache: reuse artifacts from previous matching jobs.
        content_hash = await asyncio.to_thread(compute_file_hash, audio_path)
        cached = find_cached_job(content_hash, job_id)
        if cached:
            logger.info("Cache hit for job %s (hash %s) → reusing artifacts from %s",
                        job_id, content_hash[:12], cached["job_id"])
            vocals_path = os.path.join(job_dir, "vocals.wav")
            no_vocals_path = os.path.join(job_dir, "no_vocals.wav")
            thumb_path = os.path.join(job_dir, "thumb.jpg")

            if cached["vocals_path"] and os.path.isfile(cached["vocals_path"]):
                shutil.copy2(cached["vocals_path"], vocals_path)
            else:
                vocals_path = audio_path
            if cached["no_vocals_path"] and os.path.isfile(cached["no_vocals_path"]):
                shutil.copy2(cached["no_vocals_path"], no_vocals_path)
            else:
                no_vocals_path = None
            if cached["thumb_path"] and os.path.isfile(cached["thumb_path"]):
                shutil.copy2(cached["thumb_path"], thumb_path)
            else:
                thumb_path = None

            scene_cuts = cached["scene_cuts"] or []

            full_job = {
                "video_path": video_path,
                "audio_path": audio_path,
                "vocals_path": vocals_path,
                "no_vocals_path": no_vocals_path,
                "thumb_path": thumb_path if thumb_path and os.path.exists(thumb_path) else None,
                "duration": dur,
                "filename": filename,
                "segments": None,
                "dubbed_tracks": {},
                "scene_cuts": scene_cuts,
                "youtube_subs": youtube_subs_by_lang or None,
            }
            put_job(job_id, full_job)
            save_job(job_id, full_job, filename, dur, content_hash)
            yield prep_event("extract_done", job_id=job_id, duration=round(dur, 2), filename=filename)
            yield prep_event("cached",
                             has_bg=bool(no_vocals_path and os.path.exists(no_vocals_path)),
                             scene_count=len(scene_cuts))
            yield prep_event("ready", job_id=job_id, duration=round(dur, 2), filename=filename)

        else:
            # Full pipeline: demucs → scene → thumbnail.
            partial = {
                "video_path": video_path,
                "audio_path": audio_path,
                "vocals_path": audio_path,  # fallback until demucs completes
                "no_vocals_path": None,
                "thumb_path": None,
                "duration": dur,
                "filename": filename,
                "segments": None,
                "dubbed_tracks": {},
                "scene_cuts": [],
                "youtube_subs": youtube_subs_by_lang or None,
            }
            put_job(job_id, partial)
            save_job(job_id, partial, filename, dur, content_hash)
            yield prep_event("extract_done", job_id=job_id, duration=round(dur, 2), filename=filename)

            vocals_path = os.path.join(job_dir, "vocals.wav")
            no_vocals_path = os.path.join(job_dir, "no_vocals.wav")
            scene_cuts: list = []

            yield prep_event("demucs_start")
            try:
                demucs_cmd = [sys.executable, "-m", "demucs.separate",
                              "--two-stems", "vocals", "-n", "htdemucs", "-d", get_best_device(),
                              audio_path, "-o", job_dir]
                p, _, stderr = await run_proc(demucs_cmd, timeout=1800.0)
                if p.returncode != 0:
                    raise Exception(stderr.decode(errors="replace")[:500])
                demucs_out = os.path.join(job_dir, "htdemucs", "audio")
                if os.path.exists(os.path.join(demucs_out, "vocals.wav")):
                    shutil.move(os.path.join(demucs_out, "vocals.wav"), vocals_path)
                    shutil.move(os.path.join(demucs_out, "no_vocals.wav"), no_vocals_path)
                    shutil.rmtree(os.path.join(job_dir, "htdemucs"), ignore_errors=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Demucs failed for %s, falling back to mixed audio: %s", job_id, e)
                vocals_path = audio_path
                no_vocals_path = None
            yield prep_event("demucs_done",
                             has_bg=bool(no_vocals_path and os.path.exists(no_vocals_path)))

            yield prep_event("scene_start")
            try:
                p, _, stderr_scene = await run_proc([
                    ffmpeg, "-i", video_path, "-filter:v",
                    "select='gt(scene,0.3)',showinfo", "-f", "null", "-",
                ], timeout=600.0)
                matches = re.finditer(r"pts_time:([\d\.]+)", stderr_scene.decode(errors="replace"))
                scene_cuts = [float(m.group(1)) for m in matches]
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Scene detection failed for %s: %s", job_id, e)
            yield prep_event("scene_done", count=len(scene_cuts))

            thumb_path = os.path.join(job_dir, "thumb.jpg")
            offset = max(0.5, min(1.5, dur * 0.1)) if dur else 1.0
            try:
                await run_proc([
                    ffmpeg, "-y", "-ss", f"{offset:.2f}", "-i", video_path,
                    "-vframes", "1", "-vf", "scale=320:-2",
                    "-q:v", "4", thumb_path,
                ], timeout=30.0)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Thumbnail extraction failed for %s: %s", job_id, e)

            _dub_jobs[job_id].update({
                "vocals_path": vocals_path,
                "no_vocals_path": no_vocals_path,
                "thumb_path": thumb_path if os.path.exists(thumb_path) else None,
                "scene_cuts": scene_cuts,
            })
            save_job(job_id, _dub_jobs[job_id], filename, dur, content_hash)
            yield prep_event("ready", job_id=job_id, duration=round(dur, 2), filename=filename)

    except asyncio.CancelledError:
        logger.info("Dub prep cancelled for job %s; killing subprocesses and cleaning up", job_id)
        kill_job_procs(job_id)
        try:
            shutil.rmtree(job_dir, ignore_errors=True)
        finally:
            _dub_jobs.pop(job_id, None)
        yield prep_event("cancelled")
        raise
    finally:
        with _active_procs_lock:
            _active_procs.pop(job_id, None)
