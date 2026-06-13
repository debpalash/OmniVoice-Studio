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

from fastapi import APIRouter
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


def _build_synth(default_voice: str | None):
    """Return ``(synth, sample_rate)`` bound to the active TTS engine.

    ``synth(text, voice_id)`` renders one span of text (already pause- and
    chapter-split) in the given voice and returns a 1-D audio tensor. Voice
    resolutions are cached per id. The default OmniVoice model takes the native
    path; other engines go through the generic ``TTSBackend`` adapter.
    """
    from services.tts_backend import OmniVoiceBackend, active_backend_id, get_backend_class

    cache: dict = {}

    def resolve(voice_id):
        key = voice_id or default_voice
        if key not in cache:
            cache[key] = _resolve_voice(key)
        return cache[key]

    cls = get_backend_class(active_backend_id())
    if cls is OmniVoiceBackend:
        from services.model_manager import get_model
        # get_model() is async; the caller resolves it before threading.
        return ("omnivoice", resolve, get_model)

    backend = cls()

    def synth(text, voice_id):
        v = resolve(voice_id)
        return backend.generate(
            text, language=None, ref_audio=v["ref_audio"],
            ref_text=v["ref_text"], instruct=v["instruct"], duration=None,
        )
    return ("generic", synth, backend.sample_rate)


@router.post("/audiobook")
async def audiobook_synthesize(req: AudiobookRequest):
    """Synthesize a chapterized m4b audiobook, streaming SSE progress."""
    from core.config import OUTPUTS_DIR
    from services.audio_io import atomic_save_wav
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
        loop = asyncio.get_running_loop()

        try:
            mode, a, b = _build_synth(req.default_voice)
            if mode == "omnivoice":
                resolve, get_model = a, b
                model = await get_model()
                sr = getattr(model, "sampling_rate", 24000)

                def synth(text, voice_id):
                    v = resolve(voice_id)
                    return model.generate(
                        text=text, language=None, ref_audio=v["ref_audio"],
                        ref_text=v["ref_text"], instruct=v["instruct"], duration=None,
                    )[0]
            else:
                synth, sr = a, b

            total = len(plan.chapters)
            chapter_files: list[str] = []
            chapters_meta: list[tuple[str, int]] = []
            yield _emit({"type": "started", "job_id": job_id, "chapters": total})

            for i, chapter in enumerate(plan.chapters):
                audio, dur = await loop.run_in_executor(
                    _gpu_pool, synthesize_chapter, chapter.spans, synth, sr,
                )
                wav_path = os.path.join(work, f"chapter_{i:03d}.wav")
                atomic_save_wav(wav_path, audio, sr)
                chapter_files.append(wav_path)
                chapters_meta.append((chapter.title, int(round(dur * 1000))))
                yield _emit({"type": "chapter", "index": i, "total": total,
                             "title": chapter.title, "duration_s": round(dur, 2)})

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
                         "chapters": total, "duration_s": round(total_s, 2)})
        except Exception as e:  # surface, don't 500 the stream
            if job_store is not None:
                try:
                    job_store.mark_failed(job_id, str(e))
                except Exception:
                    pass
            yield _emit({"type": "error", "error": str(e)[:300]})

    return StreamingResponse(gen(), media_type="text/event-stream")
