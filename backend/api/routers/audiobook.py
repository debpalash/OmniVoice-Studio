"""Audiobook creator endpoints (parity Wave 5).

``POST /audiobook/plan`` — pure preview: parse a chapter-delimited script
(Markdown ``# H1`` chapters, inline ``[voice:NAME]`` / ``[pause …]``) into the
chapter/span plan, no synthesis.

``POST /audiobook`` — the synth job: render each chapter through the active TTS
backend (reusing ``services.audiobook.synthesize_chapter`` + ``chunked_tts``),
then mux the chapter WAVs into a chapterized **m4b** (FFMETADATA1 chapters via
``build_m4b_cmd``). Progress streams as Server-Sent Events, mirroring the dub
pipeline. ffmpeg-gated — without ffmpeg the job reports an error event and
stops (the m4b is the only output format).

epub/pdf ingest, ACX mastering, crash-resume and the UI remain follow-ups.
"""

import asyncio
import json
import os
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.audiobook import (
    parse_audiobook_script,
    synthesize_chapter,
)
from services.longform_render import (
    build_concat_list,
    build_ffmetadata,
    build_render_cmd,
)

router = APIRouter()


class AudiobookPlanRequest(BaseModel):
    text: str
    default_voice: str | None = None


@router.post("/audiobook/plan")
def audiobook_plan(req: AudiobookPlanRequest) -> dict:
    """Parse a script into a chapter/span plan (pure preview, no synthesis)."""
    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)
    return plan.to_dict()


#: Cover size cap mirrors longform_render's guard (8 MB — a book cover, not a
#: payload). Kept in sync intentionally; the render builder re-validates too.
_COVER_MAX_BYTES = 8 * 1024 * 1024


@router.post("/audiobook/import")
async def audiobook_import(file: UploadFile = File(...)) -> dict:
    """Import a ``.txt``/``.md``/``.epub`` into a chapter-delimited script.

    EPUB is parsed in spine order (stdlib only, local); plain text gets ``# ``
    headings inserted ahead of obvious chapter-title lines. Returns the script
    text (for the editor) + the resulting chapter count."""
    from services.longform_import import chapterize_plaintext, epub_to_chapter_script

    name = (file.filename or "").lower()
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if name.endswith(".epub"):
        try:
            script = epub_to_chapter_script(data)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"couldn't parse EPUB: {e}")
    else:
        script = chapterize_plaintext(data.decode("utf-8", "ignore"))
    if not script.strip():
        raise HTTPException(status_code=400, detail="no text found in the file")
    plan = parse_audiobook_script(script)
    return {"text": script, "chapters": plan.chapter_count}


@router.post("/audiobook/cover")
async def audiobook_cover(cover: UploadFile = File(...)) -> dict:
    """Upload a cover image; returns a server-side ``path`` to pass back as
    ``cover_path`` in the synth request. Validated here (jpg/png + size cap) and
    again at render time."""
    from core.config import OUTPUTS_DIR

    ext = os.path.splitext(cover.filename or "")[1].lower()
    if ext not in (".jpg", ".jpeg", ".png"):
        raise HTTPException(status_code=400, detail="cover must be a .jpg or .png")
    data = await cover.read()
    if not data or len(data) > _COVER_MAX_BYTES:
        raise HTTPException(status_code=400, detail="cover must be between 1 byte and 8 MB")
    cover_dir = os.path.join(OUTPUTS_DIR, "audiobook_covers")
    os.makedirs(cover_dir, exist_ok=True)
    path = os.path.join(cover_dir, f"{uuid.uuid4().hex[:12]}{ext}")
    with open(path, "wb") as f:
        f.write(data)
    return {"path": path}


class AudiobookRequest(BaseModel):
    text: str
    default_voice: str | None = None   # voice profile id; None = engine default
    bitrate: str = "128k"
    format: str = "m4b"                 # "m4b" | "mp3"
    loudness: str | None = None         # None/"off" | "acx" | "podcast" (opt-in)
    cover_path: str | None = None       # server-side path to a jpg/png cover
    # Global tags embedded in the output: {title, author, narrator, year,
    # genre, description}. Player-visible (Apple Books / Audible read these).
    metadata: dict | None = None


def _resolve_voice(profile_id: str | None) -> dict:
    """Map a voice-profile id to (ref_audio, ref_text, instruct, seed).

    Compact form of the resolver in generation.py — covers locked, design and
    clone profiles. Returns all-None for the engine default (no profile).
    """
    out = {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None}
    if not profile_id:
        return out
    from core.config import VOICES_DIR
    from core.db import db_conn

    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return out
    try:
        kind = row["kind"] or "clone"
    except (KeyError, IndexError):
        kind = "clone"
    if row["is_locked"] and row["locked_audio_path"]:
        out["ref_audio"] = os.path.join(VOICES_DIR, row["locked_audio_path"])
        out["ref_text"] = row["ref_text"]
        out["instruct"] = row["instruct"]
    elif kind == "design":
        out["ref_audio"] = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
        out["ref_text"] = row["ref_text"] if out["ref_audio"] else None
        out["instruct"] = row["instruct"]
    else:
        out["ref_audio"] = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
        out["ref_text"] = row["ref_text"]
        out["instruct"] = row["instruct"]
    try:
        if row["seed"] is not None:
            out["seed"] = row["seed"]
    except (KeyError, IndexError):
        pass
    return out


def _build_synth(default_voice: str | None) -> dict:
    """Describe how to synthesize for the active TTS engine.

    Returns a dict with ``mode``, ``resolve`` (voice-id → resolved refs, cached
    per id) and ``engine_id``. For OmniVoice it also carries the async
    ``get_model``; other engines carry a ready ``synth`` + ``sample_rate``.
    :func:`_prepare_synth` turns this into a uniform ``(synth, sr, resolve,
    engine_id)`` once the (async) model is in hand.
    """
    from services.tts_backend import OmniVoiceBackend, active_backend_id, get_backend_class

    cache: dict = {}

    def resolve(voice_id):
        key = voice_id or default_voice
        if key not in cache:
            cache[key] = _resolve_voice(key)
        return cache[key]

    engine_id = active_backend_id()
    cls = get_backend_class(engine_id)
    if cls is OmniVoiceBackend:
        from services.model_manager import get_model
        return {"mode": "omnivoice", "resolve": resolve,
                "engine_id": engine_id, "get_model": get_model}

    backend = cls()

    def synth(text, voice_id):
        v = resolve(voice_id)
        return backend.generate(
            text, language=None, ref_audio=v["ref_audio"],
            ref_text=v["ref_text"], instruct=v["instruct"], duration=None,
        )
    return {"mode": "generic", "resolve": resolve, "engine_id": engine_id,
            "synth": synth, "sample_rate": backend.sample_rate}


async def _prepare_synth(default_voice: str | None):
    """Resolve :func:`_build_synth` into ``(synth, sample_rate, resolve,
    engine_id)`` — awaiting the OmniVoice model load when needed. Shared by the
    full job and the per-chapter preview."""
    info = _build_synth(default_voice)
    resolve, engine_id = info["resolve"], info["engine_id"]
    if info["mode"] == "omnivoice":
        model = await info["get_model"]()
        sr = getattr(model, "sampling_rate", 24000)

        def synth(text, voice_id):
            v = resolve(voice_id)
            return model.generate(
                text=text, language=None, ref_audio=v["ref_audio"],
                ref_text=v["ref_text"], instruct=v["instruct"], duration=None,
            )[0]
        return synth, sr, resolve, engine_id
    return info["synth"], info["sample_rate"], resolve, engine_id


def _render_chapter_cached(chapter, synth, sr, engine_id, resolve, cache_dir):
    """Render one chapter, content-addressed so a re-run reuses it (resume).

    Returns ``(wav_path, duration_s, was_cached)``. The WAV lives at
    ``cache_dir/<key>.wav`` where ``key`` is :func:`chapter_cache_key` over the
    chapter's spans + sample rate + engine + each voice's resolved signature, so
    an unchanged chapter is never re-synthesized. Runs in the GPU-pool executor.
    """
    import wave

    from services.audio_io import atomic_save_wav
    from services.longform_render import chapter_cache_key

    spans_tuples = [(s.voice_id, s.text, s.pause_ms_after) for s in chapter.spans]
    sig: dict = {}
    for s in chapter.spans:
        k = s.voice_id or ""
        if k not in sig:
            v = resolve(s.voice_id)
            sig[k] = f"{v.get('ref_audio')}|{v.get('instruct')}|{v.get('seed')}"
    key = chapter_cache_key(spans_tuples, sample_rate=sr, engine_id=engine_id, voice_sig=sig)
    wav_path = os.path.join(cache_dir, f"{key}.wav")

    if os.path.exists(wav_path):
        try:
            with wave.open(wav_path, "rb") as w:
                dur = w.getnframes() / float(w.getframerate() or sr)
            return wav_path, dur, True
        except Exception:
            pass  # corrupt cache entry — fall through and re-render

    audio, dur = synthesize_chapter(chapter.spans, synth, sr)
    atomic_save_wav(wav_path, audio, sr)
    return wav_path, dur, False


class AudiobookPreviewRequest(BaseModel):
    text: str
    chapter_index: int = 0
    default_voice: str | None = None


@router.post("/audiobook/preview")
async def audiobook_preview(req: AudiobookPreviewRequest) -> dict:
    """Render a single chapter so the user can audition it before the full run.

    Reuses the same content-addressed cache as the job, so a preview warms the
    cache (the later full render reuses it) and a re-preview is instant.
    """
    from core.config import OUTPUTS_DIR
    from services.model_manager import _gpu_pool

    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)
    if not plan.chapters:
        raise HTTPException(status_code=400, detail="no chapters parsed from the script")
    n = len(plan.chapters)
    if not (0 <= req.chapter_index < n):
        raise HTTPException(status_code=400, detail=f"chapter_index out of range (0..{n - 1})")

    chapter = plan.chapters[req.chapter_index]
    cache_dir = os.path.join(OUTPUTS_DIR, "audiobook_cache")
    os.makedirs(cache_dir, exist_ok=True)
    synth, sr, resolve, engine_id = await _prepare_synth(req.default_voice)
    loop = asyncio.get_running_loop()
    wav_path, dur, was_cached = await loop.run_in_executor(
        _gpu_pool, _render_chapter_cached, chapter, synth, sr, engine_id, resolve, cache_dir,
    )
    return {
        "output": os.path.relpath(wav_path, OUTPUTS_DIR),  # served via /audio
        "duration_s": round(dur, 2),
        "cached": was_cached,
        "title": chapter.title,
    }


@router.post("/audiobook")
async def audiobook_synthesize(req: AudiobookRequest):
    """Synthesize a chapterized m4b audiobook, streaming SSE progress."""
    from core.config import OUTPUTS_DIR
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg
    from services.model_manager import _gpu_pool

    plan = parse_audiobook_script(req.text, default_voice=req.default_voice)

    async def gen():
        job_id = uuid.uuid4().hex[:16]
        try:
            from core import job_store
            job_store.create(job_id, type="audiobook")
            job_store.mark_running(job_id)
        except Exception:
            job_store = None  # job history is best-effort; never block synthesis

        def _emit(payload: dict) -> str:
            if job_store is not None:
                try:
                    job_store.append_event(job_id, json.dumps(payload))
                except Exception:
                    pass
            return f"data: {json.dumps(payload)}\n\n"

        if not plan.chapters:
            yield _emit({"type": "error", "error": "no chapters parsed from the script"})
            return
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            yield _emit({"type": "error", "error": "ffmpeg not available; the m4b output needs it"})
            return

        work = os.path.join(OUTPUTS_DIR, f"audiobook_{job_id}")
        os.makedirs(work, exist_ok=True)
        # Chapter WAVs are content-addressed in a shared cache so a re-run
        # (after a failure or interruption) reuses what already rendered — only
        # the missing/changed chapters synthesize again (resume).
        cache_dir = os.path.join(OUTPUTS_DIR, "audiobook_cache")
        os.makedirs(cache_dir, exist_ok=True)
        loop = asyncio.get_running_loop()

        try:
            synth, sr, resolve, engine_id = await _prepare_synth(req.default_voice)

            total = len(plan.chapters)
            chapter_files: list[str] = []
            chapters_meta: list[tuple[str, int]] = []
            cached_n = 0
            failed: list[int] = []
            yield _emit({"type": "started", "job_id": job_id, "chapters": total})

            for i, chapter in enumerate(plan.chapters):
                try:
                    wav_path, dur, was_cached = await loop.run_in_executor(
                        _gpu_pool, _render_chapter_cached,
                        chapter, synth, sr, engine_id, resolve, cache_dir,
                    )
                except Exception as ce:  # isolate a bad chapter — keep going
                    failed.append(i)
                    yield _emit({"type": "chapter_error", "index": i, "total": total,
                                 "title": chapter.title, "error": str(ce)[:200]})
                    continue
                chapter_files.append(wav_path)
                chapters_meta.append((chapter.title, int(round(dur * 1000))))
                cached_n += 1 if was_cached else 0
                yield _emit({"type": "chapter", "index": i, "total": total,
                             "title": chapter.title, "duration_s": round(dur, 2),
                             "cached": was_cached})

            if not chapter_files:
                yield _emit({"type": "error", "error": "all chapters failed to render"})
                return

            yield _emit({"type": "assembling"})
            meta_path = os.path.join(work, "chapters.ffmeta")
            with open(meta_path, "w", encoding="utf-8") as f:
                f.write(build_ffmetadata(chapters_meta, global_meta=req.metadata))
            concat_path = os.path.join(work, "concat.txt")
            with open(concat_path, "w", encoding="utf-8") as f:
                f.write(build_concat_list(chapter_files))
            ext = "mp3" if (req.format or "").lower() == "mp3" else "m4b"
            out_name = f"audiobook_{job_id}.{ext}"
            out_path = os.path.join(OUTPUTS_DIR, out_name)
            await run_ffmpeg(
                build_render_cmd(
                    ffmpeg, concat_path, meta_path, out_path,
                    fmt=ext, bitrate=req.bitrate,
                    cover_path=req.cover_path, loudness=req.loudness,
                ),
                job_id=job_id,
            )

            if job_store is not None:
                try:
                    job_store.mark_done(job_id)
                except Exception:
                    pass
            total_s = sum(d for _, d in chapters_meta) / 1000.0
            yield _emit({"type": "done", "output": out_name,
                         "chapters": len(chapter_files), "duration_s": round(total_s, 2),
                         "cached_chapters": cached_n, "failed_chapters": failed})
        except Exception as e:  # surface, don't 500 the stream
            if job_store is not None:
                try:
                    job_store.mark_failed(job_id, str(e))
                except Exception:
                    pass
            yield _emit({"type": "error", "error": str(e)[:300]})

    return StreamingResponse(gen(), media_type="text/event-stream")
