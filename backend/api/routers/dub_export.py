import os
import io
import time
import uuid
import asyncio
import logging
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse, StreamingResponse

from core.db import get_db
from core.config import DUB_DIR
from core.tasks import task_manager
from api.routers.dub_core import _get_job
from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

router = APIRouter()
logger = logging.getLogger("omnivoice.api")


def _unique_stamp() -> str:
    """Return a short unique suffix like '20260415T142301-ab12cd34' for export files."""
    return f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"


def _native_save(source: str, destination: str, display_name: str, media_type: str):
    """Copy a generated export file to a user-chosen destination and return JSON."""
    import shutil
    dest = os.path.expanduser(destination)
    # Reject traversal against the user's home dir — Tauri save dialog returns abs path.
    if not os.path.isabs(dest):
        raise HTTPException(status_code=400, detail="save_path must be absolute")
    try:
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        shutil.copy2(source, dest)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=f"Permission denied: {e}")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Copy failed: {e}")
    if not os.path.exists(dest) or os.path.getsize(dest) == 0:
        raise HTTPException(status_code=500, detail="Copy produced empty file at destination")
    logger.info("Native save wrote %s (%d bytes)", dest, os.path.getsize(dest))
    return {
        "saved": True,
        "path": dest,
        "size": os.path.getsize(dest),
        "media_type": media_type,
        "display_name": display_name,
    }

@router.get("/tasks/stream/{task_id}")
async def stream_task(task_id: str):
    """Universal Server-Sent Event stream for background tasks."""
    if task_id not in task_manager.active_tasks:
        raise HTTPException(status_code=404, detail="Task not found")
        
    async def _reader():
        t = task_manager.active_tasks.get(task_id)
        if t is None:
            return
        q = asyncio.Queue()
        await task_manager.add_listener(task_id, q)

        try:
            for evt in t["history"]:
                yield evt

            if t["status"] in ("done", "failed"):
                return

            while True:
                evt = await q.get()
                if evt is None:
                    break
                yield evt
        finally:
            await task_manager.remove_listener(task_id, q)

    return StreamingResponse(_reader(), media_type="text/event-stream")

@router.post("/tasks/cancel/{task_id}")
async def cancel_task(task_id: str):
    """Cancel a running background task (e.g. dub generation)."""
    ok = task_manager.cancel_task(task_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"cancelled": True, "task_id": task_id}


@router.get("/dub/tracks/{job_id}")
async def dub_list_tracks(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"tracks": job.get("dubbed_tracks", {})}


@router.get("/dub/download/{job_id}")
@router.get("/dub/download/{job_id}/{filename}")
async def dub_download(
    job_id: str,
    preserve_bg: bool = Query(True, description="Mix background noise into dubbed tracks"),
    default_track: str = Query("original"),
    include_tracks: str = Query("", description="Comma-separated list of tracks to include (e.g. 'original,de,es'). Empty = include all."),
    save_path: str = Query("", description="Absolute destination path. If set, mux output is copied there and JSON returned instead of FileResponse."),
):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    tracks = job.get("dubbed_tracks", {})
    if not tracks:
        raise HTTPException(status_code=400, detail="No dubbed tracks generated yet")

    include_set = set(t.strip() for t in include_tracks.split(",") if t.strip()) if include_tracks else None
    include_original = include_set is None or "original" in include_set

    if include_set:
        filtered_tracks = {k: v for k, v in tracks.items() if k in include_set}
    else:
        filtered_tracks = dict(tracks)
    
    if not filtered_tracks and not include_original:
        raise HTTPException(status_code=400, detail="No tracks selected for export")

    video_path = job["video_path"]
    stamp = _unique_stamp()
    exports_dir = os.path.join(DUB_DIR, job_id, "exports")
    os.makedirs(exports_dir, exist_ok=True)
    output_path = os.path.join(exports_dir, f"dubbed_video_{stamp}.mp4")
    ffmpeg = find_ffmpeg()

    cmd = [ffmpeg, "-i", video_path]
    input_idx = 1
    
    bg_audio = job.get("no_vocals_path") if preserve_bg else None
    bg_idx = None
    if bg_audio and os.path.exists(bg_audio) and filtered_tracks:
        cmd += ["-i", bg_audio]
        bg_idx = input_idx
        input_idx += 1

    tracks_to_process = []
    for lang_code, track_info in filtered_tracks.items():
        cmd += ["-i", track_info["path"]]
        tracks_to_process.append({"lang_code": lang_code, "idx": input_idx, "info": track_info})
        input_idx += 1

    cmd += ["-map", "0:v:0"]
    if include_original:
        cmd += ["-map", "0:a:0"]

    if bg_idx is not None:
        filters = []
        for i, t in enumerate(tracks_to_process):
            out_label = f"[aout{i}]"
            filters.append(f"[{bg_idx}:a][{t['idx']}:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=0.8 1.2{out_label}")
            t["out_label"] = out_label
        cmd += ["-filter_complex", ";".join(filters)]
        for t in tracks_to_process:
            cmd += ["-map", t["out_label"]]
    else:
        for t in tracks_to_process:
            cmd += ["-map", f"{t['idx']}:a:0"]

    cmd += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]

    audio_stream_idx = 0
    if include_original:
        cmd += [f"-metadata:s:a:{audio_stream_idx}", "language=und", f"-metadata:s:a:{audio_stream_idx}", "title=Original"]
        audio_stream_idx += 1

    for t in tracks_to_process:
        cmd += [
            f"-metadata:s:a:{audio_stream_idx}", f"language={t['lang_code']}",
            f"-metadata:s:a:{audio_stream_idx}", f"title={t['info']['language']}"
        ]
        t["stream_idx"] = audio_stream_idx
        audio_stream_idx += 1

    total_audio = (1 if include_original else 0) + len(tracks_to_process)
    for i in range(total_audio):
        cmd += [f"-disposition:a:{i}", "0"]

    if default_track == "original" and include_original:
        cmd += ["-disposition:a:0", "default"]
    else:
        target_idx = 0
        for t in tracks_to_process:
            if t['lang_code'] == default_track:
                target_idx = t["stream_idx"]
                break
        cmd += [f"-disposition:a:{target_idx}", "default"]

    cmd += ["-shortest", output_path, "-y"]

    try:
        rc, _, stderr = await run_ffmpeg(cmd, timeout=1800.0)
        if rc != 0:
            raise Exception(stderr.decode(errors="replace") if stderr else "ffmpeg mux non-zero")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="ffmpeg mux timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg mux failed: {str(e)}")

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise HTTPException(status_code=500, detail="ffmpeg mux produced no output file")
    logger.info("Dub mux wrote %s (%d bytes)", output_path, os.path.getsize(output_path))

    base_name = os.path.splitext(job.get('filename', 'output'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'output'
    dl_name = f"dubbed_{safe_name}_{stamp}.mp4"

    if save_path:
        return _native_save(output_path, save_path, dl_name, media_type="video/mp4")

    return FileResponse(
        output_path, media_type="video/mp4",
        headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
    )


@router.get("/dub/media/{job_id}")
async def dub_get_media(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if not os.path.exists(job["video_path"]):
        raise HTTPException(status_code=404, detail="Media file not found")
    return FileResponse(job["video_path"])

@router.get("/dub/thumb/{job_id}")
async def dub_get_thumb(job_id: str):
    """Serve the extracted dub video thumbnail (jpg). 404 if not generated."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # Resolve under DUB_DIR to prevent traversal.
    thumb = os.path.join(DUB_DIR, job_id, "thumb.jpg")
    if not os.path.exists(thumb):
        raise HTTPException(status_code=404, detail="Thumbnail not available")
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})

@router.get("/dub/audio/{job_id}")
async def dub_get_audio(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    audio = job.get("audio_path")
    if not audio or not os.path.exists(audio):
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(audio, media_type="audio/wav")

@router.get("/dub/preview/{job_id}/{segment_index}")
async def dub_preview_segment(job_id: str, segment_index: int):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    seg_path = os.path.join(DUB_DIR, job_id, f"seg_{segment_index}.wav")
    if not os.path.exists(seg_path):
        raise HTTPException(status_code=404, detail="Segment not generated yet")
    return FileResponse(seg_path, media_type="audio/wav")


@router.get("/dub/download-audio/{job_id}")
@router.get("/dub/download-audio/{job_id}/{filename}")
async def dub_download_audio(job_id: str, lang: str = Query(None), preserve_bg: bool = Query(True), save_path: str = Query("")):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    if lang and lang in tracks:
        wav_path = tracks[lang]["path"]
    elif tracks:
        wav_path = list(tracks.values())[0]["path"]
    else:
        raise HTTPException(status_code=400, detail="No dubbed audio track generated yet")

    if not os.path.exists(wav_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    lang_label = lang or list(tracks.keys())[0]
    stamp = _unique_stamp()
    exports_dir = os.path.join(DUB_DIR, job_id, "exports")
    os.makedirs(exports_dir, exist_ok=True)

    bg_audio = job.get("no_vocals_path") if preserve_bg else None
    if bg_audio and os.path.exists(bg_audio):
        ffmpeg = find_ffmpeg()
        final_audio_path = os.path.join(exports_dir, f"mixed_dub_{lang_label}_{stamp}.wav")
        cmd = [
            ffmpeg, "-i", bg_audio, "-i", wav_path,
            "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=0.8 1.2[aout]",
            "-map", "[aout]", "-c:a", "pcm_s16le", "-y", final_audio_path
        ]
        try:
            rc, _, stderr = await run_ffmpeg(cmd, timeout=900.0)
            if rc != 0:
                raise Exception(stderr.decode(errors="replace") if stderr else "ffmpeg mix non-zero")
            if not os.path.exists(final_audio_path) or os.path.getsize(final_audio_path) == 0:
                raise Exception("ffmpeg mix produced no output file")
            wav_path = final_audio_path
            logger.info("Dub audio mix wrote %s (%d bytes)", final_audio_path, os.path.getsize(final_audio_path))
        except Exception as e:
            logger.error(f"Failed to mix audio: {str(e)}")

    base_name = os.path.splitext(job.get('filename', 'audio'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'audio'
    dl_name = f"dubbed_audio_{lang_label}_{safe_name}_{stamp}.wav"
    if save_path:
        return _native_save(wav_path, save_path, dl_name, media_type="audio/wav")
    return FileResponse(
        wav_path, media_type="audio/wav",
        headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
    )


def _format_srt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

@router.get("/dub/srt/{job_id}")
@router.get("/dub/srt/{job_id}/{filename}")
async def dub_export_srt(job_id: str):
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
        headers={"Content-Disposition": f'attachment; filename="subtitles_{base_name}.srt"'},
    )

def _format_vtt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"

@router.get("/dub/vtt/{job_id}")
@router.get("/dub/vtt/{job_id}/{filename}")
async def dub_export_vtt(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    segments = job.get("segments", [])
    if not segments:
        raise HTTPException(status_code=400, detail="No transcript segments available")

    vtt_lines = ["WEBVTT", ""]
    for i, seg in enumerate(segments):
        start_ts = _format_vtt_time(seg["start"])
        end_ts = _format_vtt_time(seg["end"])
        vtt_lines.append(str(i + 1))
        vtt_lines.append(f"{start_ts} --> {end_ts}")
        vtt_lines.append(seg["text"])
        vtt_lines.append("")

    vtt_content = "\n".join(vtt_lines)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    return Response(
        content=vtt_content,
        media_type="text/vtt",
        headers={"Content-Disposition": f'attachment; filename="subtitles_{base_name}.vtt"'},
    )


@router.get("/dub/export-segments/{job_id}")
async def dub_export_segments_zip(job_id: str):
    import zipfile
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    segments = job.get("segments", [])
    if not segments:
        raise HTTPException(status_code=400, detail="No segments available")

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, seg in enumerate(segments):
            seg_path = os.path.join(DUB_DIR, job_id, f"seg_{i}.wav")
            if os.path.exists(seg_path):
                speaker = seg.get("speaker_id", "Speaker1").replace(" ", "")
                start_str = f"{seg['start']:.2f}"
                end_str = f"{seg['end']:.2f}"
                arc_name = f"{i+1:03d}_{start_str}-{end_str}_{speaker}.wav"
                zf.write(seg_path, arc_name)

    zip_buffer.seek(0)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'segments'
    return Response(
        content=zip_buffer.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="segments_{safe_name}.zip"'},
    )

@router.get("/dub/download-mp3/{job_id}")
@router.get("/dub/download-mp3/{job_id}/{filename}")
async def dub_download_mp3(job_id: str, lang: str = Query(None), preserve_bg: bool = Query(True), save_path: str = Query("")):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    if lang and lang in tracks:
        wav_path = tracks[lang]["path"]
    elif tracks:
        wav_path = list(tracks.values())[0]["path"]
    else:
        raise HTTPException(status_code=400, detail="No dubbed audio track generated yet")

    if not os.path.exists(wav_path):
        raise HTTPException(status_code=404, detail="Audio file not found")

    lang_label = lang or list(tracks.keys())[0]
    ffmpeg = find_ffmpeg()
    stamp = _unique_stamp()
    exports_dir = os.path.join(DUB_DIR, job_id, "exports")
    os.makedirs(exports_dir, exist_ok=True)

    source_path = wav_path
    bg_audio = job.get("no_vocals_path") if preserve_bg else None
    if bg_audio and os.path.exists(bg_audio):
        mixed_path = os.path.join(exports_dir, f"mixed_mp3_{lang_label}_{stamp}.wav")
        cmd_mix = [
            ffmpeg, "-i", bg_audio, "-i", wav_path,
            "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=0.8 1.2[aout]",
            "-map", "[aout]", "-c:a", "pcm_s16le", "-y", mixed_path
        ]
        try:
            rc, _, _ = await run_ffmpeg(cmd_mix, timeout=900.0)
            if rc == 0 and os.path.exists(mixed_path) and os.path.getsize(mixed_path) > 0:
                source_path = mixed_path
        except Exception as e:
            logger.error(f"Failed to mix audio for MP3: {e}")

    mp3_path = os.path.join(exports_dir, f"dubbed_{lang_label}_{stamp}.mp3")
    cmd = [ffmpeg, "-i", source_path, "-codec:a", "libmp3lame", "-b:a", "192k", "-y", mp3_path]
    try:
        rc, _, stderr = await run_ffmpeg(cmd, timeout=600.0)
        if rc != 0:
            raise Exception(stderr.decode(errors="replace") if stderr else "MP3 encode non-zero")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MP3 encoding timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MP3 encoding failed: {str(e)}")

    if not os.path.exists(mp3_path) or os.path.getsize(mp3_path) == 0:
        raise HTTPException(status_code=500, detail="MP3 encoding produced no output file")
    logger.info("Dub MP3 encoded %s (%d bytes)", mp3_path, os.path.getsize(mp3_path))

    base_name = os.path.splitext(job.get('filename', 'audio'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'audio'
    dl_name = f"dubbed_{lang_label}_{safe_name}_{stamp}.mp3"
    if save_path:
        return _native_save(mp3_path, save_path, dl_name, media_type="audio/mpeg")
    return FileResponse(
        mp3_path, media_type="audio/mpeg",
        headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
    )

@router.get("/dub/export-stems/{job_id}")
async def dub_export_stems(job_id: str, lang: str = Query(None)):
    import zipfile
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    if not tracks:
        raise HTTPException(status_code=400, detail="No dubbed tracks generated yet")

    if lang and lang in tracks:
        vocals_path = tracks[lang]["path"]
        lang_label = lang
    elif tracks:
        first_key = list(tracks.keys())[0]
        vocals_path = tracks[first_key]["path"]
        lang_label = first_key
    else:
        raise HTTPException(status_code=400, detail="No dubbed audio track")

    bg_path = job.get("no_vocals_path")

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        if os.path.exists(vocals_path):
            zf.write(vocals_path, f"vocals_dubbed_{lang_label}.wav")
        if bg_path and os.path.exists(bg_path):
            zf.write(bg_path, "background_original.wav")

    zip_buffer.seek(0)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    safe_name = ''.join(c for c in base_name if c.isalnum() or c in '-_ ').strip() or 'stems'
    return Response(
        content=zip_buffer.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="stems_{safe_name}.zip"'},
    )
