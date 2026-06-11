import os
import io
import re
import time
import uuid
import asyncio
import logging
from typing import Optional
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse, StreamingResponse

from core.config import DUB_DIR, dub_seg_path
from core.tasks import task_manager
from api.routers.dub_core import _get_job
from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

router = APIRouter()
logger = logging.getLogger("omnivoice.api")


def _unique_stamp() -> str:
    """Return a short unique suffix like '20260415T142301-ab12cd34' for export files."""
    return f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"


_SAFE_LANG = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _safe_job_path(job_id: str, *parts: str) -> str:
    """Join path components under DUB_DIR/<job_id>/ with a realpath
    containment guard — request-supplied ids/names must never traverse out
    of the job's directory (same pattern as the per-segment export below)."""
    base = os.path.realpath(DUB_DIR)
    cand = os.path.realpath(os.path.join(DUB_DIR, job_id, *parts))
    if cand != base and not cand.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="Invalid path component")
    return cand


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
async def stream_task(task_id: str, after_seq: int = 0):
    """Universal Server-Sent Event stream for background tasks.

    `?after_seq=N` enables resumption: on reconnect, the client replays
    persisted events with seq > N, then (if the job is still live) attaches
    to the in-memory listener for live updates. After a server restart the
    in-memory task is gone but the persisted tail + final `jobs.status` are
    still readable, so a mid-stream reload still sees the final state.
    """
    from core import job_store
    job_row = job_store.get(task_id)
    live = task_manager.active_tasks.get(task_id)

    if not live and not job_row:
        raise HTTPException(
            status_code=404,
            detail="No such task. It may have been cleaned up or was never created.",
        )

    async def _reader():
        # 1) Replay any persisted events after the client's last-seen seq.
        try:
            persisted = job_store.events_since(task_id, after_seq=after_seq)
        except Exception:
            persisted = []
        for evt in persisted:
            yield evt["payload"]

        # 2) If the job has finished (whether in-memory or persisted-only), done.
        if not live:
            return
        if live["status"] in ("done", "failed", "cancelled"):
            return

        # 3) Attach to the in-memory listener for live updates.
        q = asyncio.Queue()
        await task_manager.add_listener(task_id, q)
        try:
            while True:
                evt = await q.get()
                if evt is None:
                    break
                yield evt
        finally:
            await task_manager.remove_listener(task_id, q)

    return StreamingResponse(_reader(), media_type="text/event-stream")


@router.get("/jobs")
async def list_jobs(status: str | None = None, project_id: str | None = None, limit: int = 100):
    """List persisted jobs, newest first.

    `status=active` → running + pending (what the batch-queue UI wants).
    `status=failed|done|cancelled|pending|running` → exact match.
    `project_id=...` → scope to one project.
    """
    from core import job_store
    limit = max(1, min(500, int(limit)))
    return job_store.list_jobs(status=status, project_id=project_id, limit=limit)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    from core import job_store
    row = job_store.get(job_id)
    if not row:
        raise HTTPException(
            status_code=404,
            detail="No such job. It may have been cleaned up or never created.",
        )
    return row


@router.get("/jobs/{job_id}/events")
async def list_job_events(job_id: str, after_seq: int = 0, limit: int = 500):
    """Persisted SSE tail. Strict ascending seq so the client can stitch
    it onto a live feed (which starts above the last returned seq).
    """
    from core import job_store
    row = job_store.get(job_id)
    if not row:
        raise HTTPException(
            status_code=404,
            detail="No job with that id. It may have expired, been deleted, or the server restarted before it was persisted — check the dub history in the sidebar.",
        )
    limit = max(1, min(2000, int(limit)))
    return {
        "job": row,
        "events": job_store.events_since(job_id, after_seq=after_seq, limit=limit),
    }


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


def _write_burn_srt(job: dict, exports_dir: str, stamp: str, dual: bool) -> str | None:
    """Build a temp SRT from job segments for use with ffmpeg's subtitles filter.

    Returned path is already ffmpeg-filter-safe (plain ASCII basename under exports_dir).
    Returns None if there are no segments to render.
    """
    segments = job.get("segments", [])
    if not segments:
        return None
    lines = []
    for i, seg in enumerate(segments):
        lines.append(str(i + 1))
        lines.append(f"{_format_srt_time(seg['start'])} --> {_format_srt_time(seg['end'])}")
        lines.append(_pick_subtitle_text(seg, dual))
        lines.append("")
    sub_path = os.path.join(exports_dir, f"burn_subs_{stamp}.srt")
    with open(sub_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return sub_path


def _ffmpeg_filter_escape(path: str) -> str:
    """Escape a path for use inside an ffmpeg filter value (subtitles=...).

    ffmpeg's filter parser treats `:` as an option separator and `\\`, `'` specially.
    Backslashes first, then colons, then single quotes.
    """
    return path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _build_video_stretch_filter_graph(
    plan: list[dict], orig_dur: float, video_input_idx: int = 0,
    in_label: str | None = None,
) -> tuple[str, str]:
    """Build an ffmpeg filter_complex graph that stretches the source video
    per-segment so each segment's visual duration matches a dub audio layout.

    `plan` is a list of {orig_start, orig_end, new_start, new_end, stretch_ratio}
    in original-time order (as persisted by dub_generate for stretch_video
    mode). Gaps between plan entries — and the pre-roll / tail — are passed
    through at 1.0× rate so silence and B-roll don't get squashed.

    `in_label` overrides the input stream reference; e.g. pass "[vsub]" when
    a subtitles filter has already written to that label. Defaults to
    `[{video_input_idx}:v]` for direct source-stream consumption.

    Returns (filter_graph, output_label). Output label is "[vstretched]" when
    chunks were emitted, or the original input label when the plan was empty
    (caller should fall back to stream-copy in that case).
    """
    # Empty plan = no stretch — caller should stream-copy the video. Return
    # early so we don't synthesise a degenerate "stretch whole video at 1.0×"
    # graph that would force a needless re-encode.
    if not plan:
        return "", in_label or f"[{video_input_idx}:v]"

    chunks: list[tuple[float, float, float]] = []  # (a, b, ratio)
    cursor = 0.0
    for entry in plan:
        a = float(entry["orig_start"])
        b = float(entry["orig_end"])
        if a > cursor + 1e-3:
            chunks.append((cursor, a, 1.0))  # gap or pre-roll at native rate
        ratio = float(entry["stretch_ratio"])
        if b > a:
            chunks.append((a, b, ratio))
        cursor = max(cursor, b)
    if orig_dur > cursor + 1e-3:
        chunks.append((cursor, orig_dur, 1.0))  # tail at native rate
    chunks = [(a, b, r) for (a, b, r) in chunks if b > a]
    if not chunks:
        return "", in_label or f"[{video_input_idx}:v]"

    src = in_label or f"[{video_input_idx}:v]"
    parts: list[str] = []
    labels: list[str] = []
    # `split` lets us tap the same source stream once per chunk without re-
    # decoding. setpts={ratio}*PTS slows down (ratio > 1) or speeds up
    # (ratio < 1) each chunk; PTS-STARTPTS first to normalise the timestamp
    # base after the trim.
    split_labels = [f"[vsplit{idx}]" for idx in range(len(chunks))]
    parts.append(f"{src}split={len(chunks)}{''.join(split_labels)}")
    for idx, ((a, b, ratio), split_lbl) in enumerate(zip(chunks, split_labels)):
        out_label = f"[vstr{idx}]"
        labels.append(out_label)
        parts.append(
            f"{split_lbl}trim=start={a:.4f}:end={b:.4f},"
            f"setpts=PTS-STARTPTS,setpts={ratio:.6f}*PTS{out_label}"
        )
    parts.append("".join(labels) + f"concat=n={len(chunks)}:v=1:a=0[vstretched]")
    return ";".join(parts), "[vstretched]"


def _video_stretch_plan_for(job: dict, lang_code: str) -> dict | None:
    """Return the persisted stretch plan + total durations for `lang_code`,
    or None if this job didn't use stretch_video mode (or no plan exists).
    """
    if (job.get("timing_strategy") or "").lower() != "stretch_video":
        return None
    plans = job.get("video_stretch_plans") or {}
    entry = plans.get(lang_code)
    if not entry or not entry.get("plan"):
        return None
    return entry


#: Audio export formats → ffmpeg codec args. Unknown formats fall back to
#: AAC/m4a so a bad request can never produce a broken command.
_AUDIO_FORMAT_CODECS: dict[str, list[str]] = {
    "wav": ["-c:a", "pcm_s16le"],
    "m4a": ["-c:a", "aac", "-b:a", "192k"],
    "mp3": ["-c:a", "libmp3lame", "-q:a", "2"],
    "flac": ["-c:a", "flac"],
}


def _build_audio_export_cmd(
    ffmpeg: str,
    track_path: str,
    bg_path: Optional[str],
    out_path: str,
    fmt: str,
) -> list[str]:
    """Build the ffmpeg command for an audio-only dub export (#119).

    No video input, stream-map, or codec — just the dubbed track, optionally
    mixed with the separated background (``no_vocals``), written to ``out_path``
    in the requested ``fmt``. Unknown formats fall back to AAC.
    """
    codec = _AUDIO_FORMAT_CODECS.get((fmt or "").lower(), _AUDIO_FORMAT_CODECS["m4a"])
    cmd = [ffmpeg, "-y", "-i", track_path]
    if bg_path:
        # Mix the dubbed voice over the original background bed (same weights
        # as the video mux path) so ambience/music is preserved.
        cmd += ["-i", bg_path, "-filter_complex",
                "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=1.2 0.8[aout]",
                "-map", "[aout]"]
    cmd += codec
    cmd.append(out_path)
    return cmd


@router.get("/dub/download/{job_id}")
@router.get("/dub/download/{job_id}/{filename}")
async def dub_download(
    job_id: str,
    preserve_bg: bool = Query(True, description="Mix background noise into dubbed tracks"),
    default_track: str = Query("original"),
    include_tracks: str = Query("", description="Comma-separated list of tracks to include (e.g. 'original,de,es'). Empty = include all."),
    save_path: str = Query("", description="Absolute destination path. If set, mux output is copied there and JSON returned instead of FileResponse."),
    burn_subs: bool = Query(False, description="Burn subtitles into the video stream (forces re-encode). Uses dual-subtitle layout when dual=1."),
    dual: bool = Query(False, description="When burn_subs=1, render translated on top of italicised original."),
    out_format: str = Query("m4a", description="Audio-only jobs (#119): output container — wav, m4a, mp3, or flac. Ignored for video jobs."),
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

    # ── Audio-only dubbing (#119) ─────────────────────────────────────────
    # No source video to mux into — export the dubbed track (optionally mixed
    # with the separated background) straight to an audio container.
    if (job.get("input_type") or "video").lower() == "audio":
        if default_track and default_track != "original" and default_track in filtered_tracks:
            lang_code, track_info = default_track, filtered_tracks[default_track]
        elif filtered_tracks:
            lang_code, track_info = next(iter(filtered_tracks.items()))
        else:
            raise HTTPException(status_code=400, detail="No dubbed track selected for audio export")

        fmt = (out_format or "m4a").lower()
        if fmt not in _AUDIO_FORMAT_CODECS:
            fmt = "m4a"
        # lang_code is already constrained to an existing track key, but
        # allowlist-sanitize it before it reaches the output path so a path
        # component can never carry separators/traversal (same pattern as
        # safe_name below).
        safe_lang = "".join(c for c in lang_code if c.isalnum() or c in "-_") or "track"
        out_path = os.path.join(exports_dir, f"dubbed_audio_{safe_lang}_{stamp}.{fmt}")
        bg = job.get("no_vocals_path") if preserve_bg else None
        bg = bg if (bg and os.path.exists(bg)) else None
        cmd = _build_audio_export_cmd(ffmpeg, track_info["path"], bg, out_path, fmt)
        try:
            rc, _, stderr = await run_ffmpeg(cmd, timeout=1800.0)
            if rc != 0:
                raise Exception(stderr.decode(errors="replace") if stderr else "ffmpeg audio export non-zero")
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="ffmpeg audio export timed out")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"ffmpeg failed to export dubbed audio: {e}. Verify ffmpeg is installed (`ffmpeg -version`) and the dubbed track exists.",
            )
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise HTTPException(status_code=500, detail="ffmpeg audio export produced no output file")
        logger.info("Dub audio export wrote %s (%d bytes)", out_path, os.path.getsize(out_path))

        base_name = os.path.splitext(job.get("filename", "output"))[0]
        safe_name = "".join(c for c in base_name if c.isalnum() or c in "-_ ").strip() or "output"
        dl_name = f"dubbed_{safe_name}_{safe_lang}_{stamp}.{fmt}"
        media_type = _MEDIA_TYPES.get(f".{fmt}", "audio/mp4")
        if save_path:
            return _native_save(out_path, save_path, dl_name, media_type=media_type)
        return FileResponse(
            out_path, media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
        )

    # Determine whether this export should drive video through a per-segment
    # stretch graph (Mode B). Stretch is keyed off the default_track's plan
    # because the video can only physically follow one timeline at a time.
    # If multiple dub tracks are included and they were generated under
    # stretch_video, only the default_track is visually in sync — other
    # tracks share the same (stretched) video. Single-track export is the
    # supported common case.
    stretch_entry = _video_stretch_plan_for(job, default_track) if default_track and default_track != "original" else None
    # Subtitle burn under stretch_video would render cues at the original
    # timestamps onto a re-timed video — they'd drift. Skip the burn pass
    # in that combo and log; the user can still export the SRT/VTT
    # separately and the new-layout timing lives there.
    if stretch_entry and burn_subs:
        logger.warning(
            "stretch_video + burn_subs is not supported in one pass; "
            "skipping subtitle burn for job %s. Export the SRT/VTT separately.",
            job_id,
        )
        burn_subs = False

    sub_path = _write_burn_srt(job, exports_dir, stamp, dual) if burn_subs else None

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

    filter_parts: list[str] = []
    video_map = "0:v:0"
    if sub_path:
        esc = _ffmpeg_filter_escape(sub_path)
        filter_parts.append(f"[0:v]subtitles='{esc}'[vsub]")
        video_map = "[vsub]"
    if stretch_entry:
        orig_dur = float(stretch_entry.get("orig_duration") or job.get("duration") or 0.0)
        graph, vlabel = _build_video_stretch_filter_graph(
            stretch_entry["plan"], orig_dur, video_input_idx=0,
            in_label=video_map if video_map != "0:v:0" else None,
        )
        if graph:
            filter_parts.append(graph)
            video_map = vlabel

    cmd += ["-map", video_map]
    if include_original:
        cmd += ["-map", "0:a:0"]

    if bg_idx is not None:
        for i, t in enumerate(tracks_to_process):
            out_label = f"[aout{i}]"
            filter_parts.append(f"[{bg_idx}:a][{t['idx']}:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=0.8 1.2{out_label}")
            t["out_label"] = out_label
        for t in tracks_to_process:
            cmd += ["-map", t["out_label"]]
    else:
        for t in tracks_to_process:
            cmd += ["-map", f"{t['idx']}:a:0"]

    if filter_parts:
        cmd += ["-filter_complex", ";".join(filter_parts)]

    # Burning subs or per-segment video stretch both force a real video
    # re-encode; stream-copy is only viable when nothing touches the video
    # filter chain.
    if sub_path or stretch_entry:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
    else:
        cmd += ["-c:v", "copy"]
    cmd += ["-c:a", "aac", "-b:a", "192k"]

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

    # In stretch_video mode the video and audio durations should match
    # within sub-frame precision, but `-shortest` can still cut off the
    # trailing frame; let ffmpeg keep both streams. Otherwise keep the
    # legacy `-shortest` so a slightly-overrunning track doesn't extend
    # the mux past the video.
    if not stretch_entry:
        cmd += ["-shortest"]
    cmd += [output_path, "-y"]

    try:
        rc, _, stderr = await run_ffmpeg(cmd, timeout=1800.0)
        if rc != 0:
            raise Exception(stderr.decode(errors="replace") if stderr else "ffmpeg mux non-zero")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="ffmpeg mux timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"ffmpeg failed to combine video + dubbed audio: {e}. Verify ffmpeg is installed (`ffmpeg -version`), and check that every dubbed track file exists in the job folder.",
        )

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


_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
}


@router.get("/dub/media/{job_id}")
async def dub_get_media(job_id: str):
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    video_path = job["video_path"]
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Media file not found")
    # Pass an explicit media_type. Without this Starlette falls back to
    # mimetypes.guess_type, which on some platforms returns the wrong
    # MIME (e.g. "application/octet-stream" for .mkv), and the Tauri
    # WebView then refuses to render the <video> element — leaving a
    # silent black box. Default to video/mp4 because the ingest pipeline
    # remuxes URL downloads to mp4 (dub_pipeline.yt_download_sync).
    ext = os.path.splitext(video_path)[1].lower()
    return FileResponse(video_path, media_type=_MEDIA_TYPES.get(ext, "video/mp4"))

# One mux at a time per preview file. Without this, two overlapping requests
# (e.g. the <video> element remounting right after a re-dub) both ran ffmpeg
# against the same output path, and the mtime check below saw the half-written
# file as a valid cache — serving a truncated MP4 that left the player stuck
# loading forever (#281).
_preview_mux_locks: dict[str, asyncio.Lock] = {}


def _preview_lock(path: str) -> asyncio.Lock:
    lock = _preview_mux_locks.get(path)
    if lock is None:
        lock = _preview_mux_locks.setdefault(path, asyncio.Lock())
    return lock


@router.get("/dub/preview-video/{job_id}")
async def dub_preview_video(
    job_id: str,
    lang: str = Query(..., description="Language code of the dubbed track to mux in"),
    preserve_bg: bool = Query(True),
):
    """Return an inline-playable MP4 with the chosen dubbed track as sole audio.

    Caches per lang+preserve_bg combination under exports/preview_{lang}_{bg}.mp4.
    Cache is invalidated when the underlying dubbed track mtime is newer than the cache.
    """
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    tracks = job.get("dubbed_tracks", {})
    track_info = tracks.get(lang)
    if not track_info:
        raise HTTPException(status_code=404, detail=f"No dubbed track for lang={lang}")

    track_path = track_info.get("path")
    if not track_path or not os.path.exists(track_path):
        raise HTTPException(status_code=404, detail="Dubbed track file missing")

    video_path = job.get("video_path")
    if not video_path or not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail="Source video missing")

    bg_audio = job.get("no_vocals_path") if preserve_bg else None
    has_bg = bool(bg_audio and os.path.exists(bg_audio))

    if not _SAFE_LANG.match(lang):
        raise HTTPException(status_code=400, detail="Invalid lang")
    # realpath-normalised + containment-checked inline BEFORE any filesystem
    # access so the guard dominates every sink (the file's established
    # pattern — see dub_preview_segment; CodeQL does not track the guard
    # through a helper's return value).
    _base = os.path.realpath(DUB_DIR)
    exports_dir = os.path.realpath(os.path.join(_base, job_id, "exports"))
    if not exports_dir.startswith(_base + os.sep):
        raise HTTPException(status_code=400, detail="Invalid job id")
    os.makedirs(exports_dir, exist_ok=True)
    bg_suffix = "bg" if (preserve_bg and has_bg) else "nobg"
    preview_path = os.path.realpath(
        os.path.join(exports_dir, f"preview_{lang}_{bg_suffix}.mp4")
    )
    if not preview_path.startswith(_base + os.sep):
        raise HTTPException(status_code=400, detail="Invalid path")

    track_mtime = os.path.getmtime(track_path)

    def _cache_ok() -> bool:
        return (
            os.path.exists(preview_path)
            and os.path.getsize(preview_path) > 0
            and os.path.getmtime(preview_path) >= track_mtime
        )

    async def _mux_preview():
        # Mux into a temp file and os.replace() into place so a concurrent
        # reader never sees a partially-written preview (#281: video stuck
        # loading forever after a re-dub).
        mux_path = preview_path + ".tmp.mp4"
        ffmpeg = find_ffmpeg()
        stretch_entry = _video_stretch_plan_for(job, lang)
        cmd = [ffmpeg, "-i", video_path]
        input_idx = 1
        if preserve_bg and has_bg:
            cmd += ["-i", bg_audio]
            bg_idx = input_idx
            input_idx += 1
        else:
            bg_idx = None
        cmd += ["-i", track_path]
        track_idx = input_idx

        # Build filter graph. In stretch_video mode we splice the source
        # video into per-segment chunks, setpts each to match the dub audio
        # layout, and concat them — so audio plays at natural rate and the
        # visuals follow. Otherwise we stream-copy video for speed.
        filter_parts: list[str] = []
        video_map = "0:v:0"
        if stretch_entry:
            orig_dur = float(stretch_entry.get("orig_duration") or job.get("duration") or 0.0)
            graph, vlabel = _build_video_stretch_filter_graph(
                stretch_entry["plan"], orig_dur, video_input_idx=0,
            )
            if graph:
                filter_parts.append(graph)
                video_map = vlabel
        if bg_idx is not None:
            filter_parts.append(
                f"[{bg_idx}:a][{track_idx}:a]amix=inputs=2:duration=longest:dropout_transition=2:weights=0.8 1.2[aout]"
            )

        cmd += ["-map", video_map]
        if bg_idx is not None:
            cmd += ["-map", "[aout]"]
        else:
            cmd += ["-map", f"{track_idx}:a:0"]
        if filter_parts:
            cmd += ["-filter_complex", ";".join(filter_parts)]

        # Stretch path needs a real encode; stream-copy otherwise.
        if stretch_entry:
            cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
        else:
            cmd += ["-c:v", "copy"]
        cmd += ["-c:a", "aac", "-b:a", "192k"]
        # `-shortest` would cut the stretched video at the (slightly different)
        # audio length and lose the trailing frame; only use it on the copy path.
        if not stretch_entry:
            cmd += ["-shortest"]
        cmd += [mux_path, "-y"]

        def _discard_tmp():
            try:
                os.remove(mux_path)
            except OSError:
                pass

        try:
            rc, _, stderr = await run_ffmpeg(cmd, timeout=900.0)
            if rc != 0:
                raise Exception(stderr.decode(errors="replace") if stderr else "ffmpeg mux non-zero")
            if not os.path.exists(mux_path) or os.path.getsize(mux_path) == 0:
                raise Exception("preview mux produced empty file")
        except asyncio.TimeoutError:
            _discard_tmp()
            raise HTTPException(status_code=504, detail="preview mux timed out")
        except Exception as e:
            _discard_tmp()
            raise HTTPException(
                status_code=500,
                detail=f"ffmpeg failed to build the preview stream: {str(e)[:300]}. This usually means the source video can't be re-encoded on the fly — try downloading the MP4 instead.",
            )

        os.replace(mux_path, preview_path)

    async with _preview_lock(preview_path):
        if not _cache_ok():
            await _mux_preview()

    # no-store: the URL is stable across re-dubs, so any HTTP-level caching
    # in the WebView would keep showing the previous dub after a re-generate
    # (#281: "edits don't change the result").
    return FileResponse(
        preview_path,
        media_type="video/mp4",
        headers={"Cache-Control": "no-store"},
    )


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
    # Resolve the stable-id-named WAV via the render manifest; fall back to the
    # legacy index name for jobs rendered before id-based naming (#185). Each
    # candidate is realpath-normalised and containment-checked BEFORE any
    # filesystem access, so the guard dominates every path sink.
    order = job.get("seg_order") or []
    seg_id = order[segment_index] if 0 <= segment_index < len(order) else segment_index
    base = os.path.realpath(DUB_DIR)
    seg_path = None
    for _sid in (seg_id, segment_index):
        cand = os.path.realpath(dub_seg_path(job_id, _sid))
        if cand.startswith(base + os.sep) and os.path.exists(cand):
            seg_path = cand
            break
    if not seg_path:
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

def _pick_subtitle_text(seg: dict, dual: bool) -> str:
    """One line per subtitle cue, unless dual=true and an original exists.

    Dual layout stacks translated text on top of the (italicised) original, the
    way Netflix / language-learning apps present them:

        Das Spiel wirklich zu verändern.
        <i>Actually change the game.</i>
    """
    translated = (seg.get("text") or "").strip()
    original = (seg.get("text_original") or "").strip()
    if not dual or not original or original == translated:
        return translated or original
    return f"{translated}\n<i>{original}</i>"


# Subtitles deliberately have no ?save_path= variant: they're small text
# bodies, so the Tauri side fetches them raw and writes the file itself via
# the save_text_file command — the OS save dialog is the write authorization
# (#309). The frontend's JSON-envelope save flow stays for binary exports.


@router.get("/dub/srt/{job_id}")
@router.get("/dub/srt/{job_id}/{filename}")
async def dub_export_srt(job_id: str, dual: bool = False):
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
        srt_lines.append(_pick_subtitle_text(seg, dual))
        srt_lines.append("")

    srt_content = "\n".join(srt_lines)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    suffix = "_dual" if dual else ""
    dl_name = f"subtitles_{base_name}{suffix}.srt"
    return Response(
        content=srt_content,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
    )

def _format_vtt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"

@router.get("/dub/vtt/{job_id}")
@router.get("/dub/vtt/{job_id}/{filename}")
async def dub_export_vtt(job_id: str, dual: bool = False):
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
        vtt_lines.append(_pick_subtitle_text(seg, dual))
        vtt_lines.append("")

    vtt_content = "\n".join(vtt_lines)
    base_name = os.path.splitext(job.get('filename', 'video'))[0]
    suffix = "_dual" if dual else ""
    dl_name = f"subtitles_{base_name}{suffix}.vtt"
    return Response(
        content=vtt_content,
        media_type="text/vtt",
        headers={"Content-Disposition": f'attachment; filename="{dl_name}"'},
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
    order = job.get("seg_order") or []
    base = os.path.realpath(DUB_DIR)
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, seg in enumerate(segments):
            seg_id = order[i] if i < len(order) else i
            # realpath + containment guard before any filesystem access.
            seg_path = None
            for _sid in (seg_id, i):
                cand = os.path.realpath(dub_seg_path(job_id, _sid))
                if cand.startswith(base + os.sep) and os.path.exists(cand):
                    seg_path = cand
                    break
            if seg_path:
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
async def dub_download_mp3(job_id: str, lang: str = Query(None), preserve_bg: bool = Query(True), save_path: str = Query(""), bitrate: str = Query("192k")):
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
    # Accept '128', '192k' etc. — normalize to ffmpeg's 'Nk' form and clamp
    # to a sensible range so a malformed value can't stall encoding.
    _br = str(bitrate or "192k").lower().rstrip("k") or "192"
    try:
        _br_int = max(64, min(int(_br), 320))
    except ValueError:
        _br_int = 192
    br_arg = f"{_br_int}k"
    cmd = [ffmpeg, "-i", source_path, "-codec:a", "libmp3lame", "-b:a", br_arg, "-y", mp3_path]
    try:
        rc, _, stderr = await run_ffmpeg(cmd, timeout=600.0)
        if rc != 0:
            raise Exception(stderr.decode(errors="replace") if stderr else "MP3 encode non-zero")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MP3 encoding timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"ffmpeg couldn't encode MP3: {e}. Check that libmp3lame is compiled into your ffmpeg build (`ffmpeg -codecs | grep mp3`) — reinstall via homebrew if it's missing.",
        )

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
