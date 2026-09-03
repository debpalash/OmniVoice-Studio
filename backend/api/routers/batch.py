"""Batch dubbing queue — POST videos with settings, process sequentially.

This is a lightweight batch orchestrator. Each job is a dub project that
runs through the same ingest→transcribe→translate→generate pipeline as
a manual dub, but driven by the queue instead of the UI.

The queue is in-memory (lives for the process lifetime). Jobs persist to
the SQLite `jobs` table for history, but the queue itself restarts empty
on backend restart — intentional, since GPU jobs can't be safely resumed.
"""
import os
import uuid
import time
import asyncio
import logging
from typing import Optional, List

from fastapi import APIRouter, File, UploadFile, HTTPException, Form
from pydantic import BaseModel

from core.config import DATA_DIR
from core import failure
from core.logging_utils import log_safe
from core.file_cleanup import FileCleanupError, unlink_if_present

router = APIRouter()
logger = logging.getLogger("omnivoice.batch")

# ── In-memory queue ─────────────────────────────────────────────────────

_queue: asyncio.Queue = None       # Lazily initialised
_worker_task: asyncio.Task = None  # Background consumer
_jobs: dict = {}                   # job_id → status dict


class BatchJobStatus(BaseModel):
    id: str
    status: str  # "queued" | "running" | "done" | "failed" | "cancelled"
    filename: str
    langs: List[str]
    voice_id: Optional[str] = None
    preserve_bg: bool = True
    created_at: float
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    error: Optional[str] = None
    progress: Optional[dict] = None


def _ensure_queue():
    """Lazy-init the asyncio queue + worker on first use."""
    global _queue, _worker_task
    if _queue is None:
        _queue = asyncio.Queue()
        _worker_task = asyncio.ensure_future(_worker())


async def _worker():
    """Process jobs one at a time from the queue."""
    while True:
        job_id = await _queue.get()
        job = _jobs.get(job_id)
        if not job or job["status"] == "cancelled":
            _queue.task_done()
            continue

        job["status"] = "running"
        job["started_at"] = time.time()
        logger.info("Batch job %s starting: %s", job_id, job["filename"])

        try:
            await _run_batch_pipeline(job_id, job)
            if job["status"] != "cancelled":
                job["status"] = "done"
                job["finished_at"] = time.time()
                logger.info(
                    "Batch job %s completed in %.1fs",
                    job_id, job["finished_at"] - job["started_at"],
                )
        except asyncio.CancelledError:
            # Task cancellation always means SHUTDOWN: the job-level cancel
            # endpoint only flips job["status"] — nothing ever cancels this
            # task to abort a single job. Swallowing the CancelledError here
            # made the worker unkillable (the while-loop re-entered
            # _queue.get() and event-loop teardown hung forever in
            # _cancel_all_tasks waiting on a task that never finishes). Mark
            # the in-flight job, then let the cancellation propagate.
            job["status"] = "cancelled"
            job["finished_at"] = time.time()
            raise
        except Exception as e:
            job["status"] = "failed"
            # plan-04 (#131): guaranteed non-empty, structured reason.
            job["error"] = failure.build_failure(e, stage="batch", include_diagnostic=False)["reason"]
            job["finished_at"] = time.time()
            logger.error("Batch job %s failed: %s", job_id, e, exc_info=True)
        finally:
            _queue.task_done()


def _set_progress(job, stage, percent=0, **extra):
    """Update a job's progress dict."""
    job["progress"] = {"stage": stage, "percent": percent, **extra}


#: Override for the native dub batch width. Set to 1 to disable batching.
BATCH_WIDTH_ENV = "OMNIVOICE_DUB_BATCH_WIDTH"

#: Hard ceiling on the override — a batch this wide is already amortizing
#: almost all of the per-call setup, and beyond it the failure mode is an OOM
#: that costs more than the saving.
_MAX_BATCH_WIDTH = 16

# Bound each allocation while persisting multipart uploads. Video inputs can
# be many gigabytes; `await UploadFile.read()` with no size used to mirror the
# entire file in process memory before writing it back out.
_UPLOAD_CHUNK_BYTES = 1024 * 1024


async def _save_upload(upload: UploadFile, destination: str) -> None:
    try:
        with open(destination, "wb") as output:
            while chunk := await upload.read(_UPLOAD_CHUNK_BYTES):
                output.write(chunk)
    except BaseException:
        try:
            unlink_if_present(destination)
        except FileCleanupError:
            logger.warning("Could not remove incomplete batch upload", exc_info=True)
        raise


def _native_batch_width(backend) -> int:
    """How many segments to render in one native batch on THIS host.

    A native batch widens the forward pass, so the width cannot be a constant.
    The default engine declares ``min_vram_gb = 6.0`` for a SINGLE job; an
    unconditional 8-wide batch would OOM the 4-8 GB CUDA cards and the MPS
    Macs where the per-segment path succeeds today — turning a throughput
    optimization into a regression on exactly the hardware that already
    struggles (#1616 is a 4 GB card reporting capacity failures). Default
    behaviour must not get riskier on a host, so the width is derived from
    measured headroom and falls back to 1 (no batching) when unknown.

    CPU hosts get 1: batching there buys no kernel amortization and only
    multiplies peak RAM.
    """
    override = os.environ.get(BATCH_WIDTH_ENV, "").strip()
    if override:
        try:
            return max(1, min(_MAX_BATCH_WIDTH, int(override)))
        except (TypeError, ValueError):
            logger.warning(
                "%s=%r is not an integer — deriving the batch width from the host instead.",
                BATCH_WIDTH_ENV, override,
            )
    try:
        from core.device_caps import detect_host_caps
        caps = detect_host_caps()
    except Exception:  # noqa: BLE001 — an unprobeable host takes the safe path
        return 1
    if caps.family == "cpu" or not caps.vram_gb:
        return 1
    headroom = caps.vram_gb - float(getattr(backend, "min_vram_gb", 0.0) or 0.0)
    if headroom < 2.0:
        return 1
    if headroom < 6.0:
        return 2
    if headroom < 12.0:
        return 4
    return 8


def _batch_timeout_s(texts: list[str], backend) -> float:
    """Execution budget for one native batch.

    Not the sum of the per-item budgets: ``generate_timeout_s`` returns a
    floor (300s GPU / 600s CPU) plus per-length overage, so summing it across
    eight items yields a ~2400s budget — and a wedged batch would hold a
    GPU-pool worker for forty minutes before the reset this file depends on
    (#730). One floor covers wedge detection for the whole call; only the
    length-driven overage is genuinely additive.
    """
    from services.model_manager import generate_timeout_s

    floor = generate_timeout_s("", engine=backend)
    overage = sum(
        max(0.0, generate_timeout_s(text, engine=backend) - floor) for text in texts
    )
    return floor + overage


async def _run_batch_pipeline(job_id: str, job: dict):
    """Full batch dub pipeline: extract → transcribe → translate → generate → mix → export."""
    import subprocess

    loop = asyncio.get_running_loop()
    video_path = job["video_path"]
    langs = job["langs"]
    batch_dir = os.path.join(DATA_DIR, "batch", job_id)
    os.makedirs(batch_dir, exist_ok=True)

    # ── 1. Extract audio ──────────────────────────────────────────────
    _set_progress(job, "extract", 0)
    audio_path = os.path.join(batch_dir, "audio.wav")

    from services.ffmpeg_utils import bed_mix_filter, find_ffmpeg
    ffmpeg = find_ffmpeg()

    def _extract():
        subprocess.run(
            [ffmpeg, "-y", "-i", video_path,
             "-vn", "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1",
             audio_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=300, check=True,
        )
        # Get duration
        result = subprocess.run(
            [ffmpeg, "-i", audio_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30,
        )
        import re
        match = re.search(r"Duration: (\d+):(\d+):(\d+)\.(\d+)", result.stderr.decode("utf-8", errors="replace"))
        if match:
            h, m, s, cs = match.groups()
            return int(h) * 3600 + int(m) * 60 + int(s) + int(cs) / 100
        return 0.0

    duration = await loop.run_in_executor(None, _extract)
    job["duration"] = duration
    _set_progress(job, "extract", 100)

    if job["status"] == "cancelled":
        return

    # ── 2. Transcribe ─────────────────────────────────────────────────
    _set_progress(job, "transcribe", 0)

    from services.asr_backend import load_active_asr_backend
    from services.model_manager import _gpu_pool, _cpu_pool, run_on_gpu_pool_guarded
    from services.segmentation import (
        segment_transcript, assign_speakers_heuristic,
    )

    def _transcribe():
        # `load_*`, not `get_*`: the plain selector returns engines whose
        # shallow probe passed but whose deep import chain is broken, failing
        # the whole batch job at `.transcribe()` instead of degrading (#1185).
        backend = load_active_asr_backend()
        result = backend.transcribe(audio_path, word_timestamps=True)
        detected_lang = result.get("language", "en")
        segments = segment_transcript(result, duration=duration)
        segments = assign_speakers_heuristic(segments)
        for i, s in enumerate(segments):
            s["id"] = f"s{i:05x}"
            s.setdefault("text_original", s.get("text", ""))
        try:
            backend.unload()
        except Exception:
            pass
        return segments, detected_lang

    # Bound the batch transcribe (#730) so a wedged whisperx/CTranslate2 call
    # can't hold its GPU-pool worker forever and starve the rest of the backend
    # ("can't reach backend"); run_transcribe_guarded also resets the pool on
    # timeout to restore capacity.
    from services.asr_backend import run_transcribe_guarded
    segments, source_lang = await run_transcribe_guarded(_gpu_pool, _transcribe, what="Batch")
    source_lang = (source_lang or "en").split("_")[0][:2].lower()
    job["segments"] = segments
    job["source_lang"] = source_lang
    _set_progress(job, "transcribe", 100, segments_count=len(segments))

    if job["status"] == "cancelled" or not segments:
        if not segments:
            job["error"] = "Transcription produced no segments"
            job["status"] = "failed"
        return

    # ── Engine resolution (issue #312 class) ────────────────────────────
    # Batch used to hardcode VoiceStudio via get_model() regardless of the
    # engine selected in Model Catalogue → Engines. require_cloning only when a
    # specific voice is pinned (job["voice_id"]) — an unpinned job is fine on
    # any active engine. Resolved ONCE for the whole job (every language
    # below shares the same active engine); an uncaught ValueError here
    # propagates to _worker()'s existing except-Exception handling, which
    # already records a structured job failure via core.failure.build_failure.
    from services.tts_backend import resolve_generation_backend
    backend = await resolve_generation_backend(
        require_cloning=bool(job.get("voice_id")),
        cloning_purpose="this batch job's pinned voice",
    )
    sr = backend.sample_rate

    # ── 3. Translate + Generate per language ───────────────────────────
    total_langs = len(langs)
    outputs = {}

    for lang_idx, target_lang in enumerate(langs):
        if job["status"] == "cancelled":
            return

        # ── 3a. Translate ─────────────────────────────────────────────
        _set_progress(
            job, "translate",
            percent=int((lang_idx / total_langs) * 100),
            current_lang=target_lang,
        )

        translated_segments = list(segments)  # copy
        if target_lang != source_lang:
            try:
                def _translate_batch(segs, src, tgt):
                    """Translate segment texts via Google Translate."""
                    from deep_translator import GoogleTranslator
                    TRANSLATE_CODES = {
                        "en": "en", "es": "es", "fr": "fr", "de": "de",
                        "it": "it", "pt": "pt", "ru": "ru", "ja": "ja",
                        "ko": "ko", "zh": "zh-CN", "ar": "ar", "hi": "hi",
                        "tr": "tr", "pl": "pl", "nl": "nl", "sv": "sv",
                    }
                    src_code = TRANSLATE_CODES.get(src, src) or "auto"
                    tgt_code = TRANSLATE_CODES.get(tgt, tgt)
                    translator = GoogleTranslator(source=src_code, target=tgt_code)
                    out = []
                    for s in segs:
                        s_copy = dict(s)
                        text = s.get("text", "").strip()
                        if text:
                            try:
                                s_copy["text"] = translator.translate(text) or text
                            except Exception as e:
                                logger.warning("Translate seg failed: %s", e)
                        out.append(s_copy)
                    return out

                translated_segments = await loop.run_in_executor(
                    _cpu_pool, _translate_batch,
                    segments, source_lang, target_lang,
                )
            except ImportError:
                logger.warning("deep_translator not installed, skipping translation for %s", target_lang)
            except Exception as e:
                logger.warning("Translation failed for %s: %s, using original", target_lang, e)
                translated_segments = segments

        if job["status"] == "cancelled":
            return

        # ── 3b. Generate TTS ──────────────────────────────────────────
        _set_progress(
            job, "generate",
            percent=int((lang_idx / total_langs) * 100),
            current_lang=target_lang,
            current_segment=0,
            total_segments=len(translated_segments),
        )

        from services.audio_dsp import apply_mastering, normalize_audio
        from services.audio_io import atomic_save_wav
        import torch

        total_samples = int(duration * sr)
        full_audio = torch.zeros(1, total_samples)
        total_segs = len(translated_segments)

        # Native engines can amortize encoder/decoder setup across a small
        # batch. Keep the adapter seam optional: engines without a real batch
        # implementation inherit TTSBackend.generate_batch(), which preserves
        # the established one-segment behavior below.
        from services.tts_backend import TTSBackend
        batched_audio: dict[int, torch.Tensor] = {}
        has_native_batch = type(backend).generate_batch is not TTSBackend.generate_batch
        if has_native_batch:
            from services.text_normalization import normalize_for_tts

            batch_ref_audio = None
            batch_ref_text = None
            if job.get("voice_id"):
                from core.db import db_conn
                from core.config import VOICES_DIR as _VD
                with db_conn() as conn:
                    row = conn.execute(
                        "SELECT * FROM voice_profiles WHERE id=?",
                        (job["voice_id"],),
                    ).fetchone()
                if row:
                    if row["is_locked"] and row["locked_audio_path"]:
                        batch_ref_audio = os.path.join(_VD, row["locked_audio_path"])
                    elif row["ref_audio_path"]:
                        batch_ref_audio = os.path.join(_VD, row["ref_audio_path"])
                    batch_ref_text = row["ref_text"]

            batch_width = _native_batch_width(backend)

            async def _prefetch_batch(first_index: int) -> None:
                """Render the batch beginning at ``first_index`` into
                ``batched_audio``.

                Rendered on demand rather than prerendering the whole track:
                the tensors are popped as they are placed, so peak host memory
                is one batch instead of every segment of the language — and
                the progress bar tracks placement instead of running to the
                end and restarting at segment 1.
                """
                if job["status"] == "cancelled":
                    return
                batch_rows = []
                index = first_index
                while index < total_segs and len(batch_rows) < batch_width:
                    seg = translated_segments[index]
                    if (seg.get("end", 0) - seg.get("start", 0) > 0.05
                            and seg.get("text", "").strip()):
                        batch_rows.append((index, seg))
                    index += 1
                if len(batch_rows) < 2:
                    return  # nothing to amortize — the per-segment path is equal
                batch_indices = [index for index, _ in batch_rows]
                batch_texts = [
                    normalize_for_tts(row.get("text", "").strip(), target_lang)
                    for _, row in batch_rows
                ]
                batch_durations = [
                    row.get("end", 0) - row.get("start", 0)
                    for _, row in batch_rows
                ]

                def _render_native_batch():
                    generated = backend.generate_batch(
                        batch_texts,
                        language=target_lang,
                        ref_audio=batch_ref_audio,
                        ref_text=batch_ref_text,
                        duration=batch_durations,
                        num_step=16,
                        guidance_scale=2.0,
                        speed=1.0,
                        denoise=True,
                        postprocess_output=True,
                    )
                    if len(generated) != len(batch_indices):
                        raise RuntimeError(
                            f"native batch returned {len(generated)} outputs for "
                            f"{len(batch_indices)} segments"
                        )
                    rendered = []
                    for audio_out in generated:
                        if not getattr(backend, "applies_own_mastering", False):
                            audio_out = apply_mastering(audio_out, sample_rate=sr)
                        rendered.append(normalize_audio(audio_out, target_dBFS=-2.0))
                    return rendered

                try:
                    rendered = await run_on_gpu_pool_guarded(
                        _render_native_batch,
                        what="Batch generate",
                        timeout=_batch_timeout_s(batch_texts, backend),
                    )
                    batched_audio.update(zip(batch_indices, rendered))
                except TimeoutError:
                    # Do not immediately queue the same expensive work again:
                    # the timed-out pool task may still be holding the device.
                    raise
                except Exception as e:
                    logger.warning(
                        "Native TTS batch failed for segments %s-%s; falling back per segment: %s",
                        batch_indices[0] + 1,
                        batch_indices[-1] + 1,
                        e,
                    )

        for i, seg in enumerate(translated_segments):
            if job["status"] == "cancelled":
                return

            _set_progress(
                job, "generate",
                percent=int(((lang_idx + (i / total_segs)) / total_langs) * 100),
                current_lang=target_lang,
                current_segment=i + 1,
                total_segments=total_segs,
            )

            seg_start = seg.get("start", 0)
            seg_end = seg.get("end", 0)
            seg_duration = seg_end - seg_start
            seg_text = seg.get("text", "").strip()

            if seg_duration <= 0.05 or not seg_text:
                continue

            def _gen(text=seg_text, lang=target_lang, dur=seg_duration):
                # Normalize once at the segment's text→engine choke point —
                # the same pre-pass as /generate and dub_generate's _gen.
                # `lang` is the job's target language code. Pref-gated,
                # idempotent, never raises.
                from services.text_normalization import normalize_for_tts
                text = normalize_for_tts(text, lang)

                ref_audio = None
                ref_text = None

                # Use voice_id if provided
                if job.get("voice_id"):
                    from core.db import db_conn
                    from core.config import VOICES_DIR as _VD
                    with db_conn() as conn:
                        row = conn.execute(
                            "SELECT * FROM voice_profiles WHERE id=?",
                            (job["voice_id"],),
                        ).fetchone()
                    if row:
                        if row["is_locked"] and row["locked_audio_path"]:
                            ref_audio = os.path.join(_VD, row["locked_audio_path"])
                        elif row["ref_audio_path"]:
                            ref_audio = os.path.join(_VD, row["ref_audio_path"])
                        ref_text = row.get("ref_text")

                try:
                    audio_out = backend.generate(
                        text=text, language=lang,
                        ref_audio=ref_audio, ref_text=ref_text,
                        duration=dur, num_step=16,
                        guidance_scale=2.0, speed=1.0,
                        denoise=True, postprocess_output=True,
                    )
                    if not getattr(backend, "applies_own_mastering", False):
                        audio_out = apply_mastering(audio_out, sample_rate=sr)
                    return normalize_audio(audio_out, target_dBFS=-2.0)
                except Exception as e:
                    logger.warning("TTS failed for seg %d (lang=%s): %s", i, lang, e)
                    # #1190: the silence still stands in for the segment (one
                    # bad line shouldn't bin an otherwise good dub), but it is
                    # no longer INVISIBLE — the job carries a warning the UI /
                    # API consumer can see instead of shipping a
                    # finished-looking track with unexplained silence.
                    job.setdefault("warnings", []).append(
                        f"Segment {i + 1} of the {lang} track failed to "
                        f"synthesize and was left silent: {e}"
                    )
                    return torch.zeros(1, int(dur * sr))

            try:
                # Bounded + pool-reset on hang so a wedged batch segment can't
                # starve the GPU pool and brick the backend (#730 class).
                # Budget is the shared length-scaled one (#1190): a long segment
                # on CPU-class hardware no longer dies on the flat 300s.
                from services.model_manager import generate_timeout_s
                if has_native_batch and i not in batched_audio:
                    await _prefetch_batch(i)
                if i in batched_audio:
                    audio_tensor = batched_audio.pop(i)
                else:
                    audio_tensor = await run_on_gpu_pool_guarded(
                        _gen, what="Batch generate",
                        timeout=generate_timeout_s(seg_text, engine=backend),
                    )

                # Fit to slot
                target_samples_seg = int(seg_duration * sr)
                current_samples = audio_tensor.shape[-1]
                if target_samples_seg > current_samples:
                    audio_tensor = torch.nn.functional.pad(
                        audio_tensor, (0, target_samples_seg - current_samples)
                    )
                elif current_samples > target_samples_seg:
                    audio_tensor = audio_tensor[..., :target_samples_seg]

                # Crossfade
                fade_samples = int(0.015 * sr)
                wl = audio_tensor.shape[-1]
                if wl > fade_samples * 2:
                    ramp_up = torch.linspace(0, 1, fade_samples)
                    ramp_down = torch.linspace(1, 0, fade_samples)
                    audio_tensor[0, :fade_samples] *= ramp_up
                    audio_tensor[0, -fade_samples:] *= ramp_down

                s_idx = int(seg_start * sr)
                e_idx = min(s_idx + wl, total_samples)
                full_audio[:, s_idx:e_idx] += audio_tensor[:, :e_idx - s_idx]

            except TimeoutError as e:
                # #1190/#1202: a GPU timeout (or a saturated pool) used to be
                # swallowed into a silent gap in the dubbed track — the user got
                # a finished-looking video with missing speech and no warning,
                # and on a 1-worker host the abandoned job made every later
                # segment likelier to time out too (the "22-chunk batch dies at
                # chunk 3" cascade). Fail the job loudly instead: _worker()'s
                # except-Exception handler records a structured failure the UI
                # surfaces. Non-timeout per-segment errors keep the old
                # degrade-to-gap behaviour, but are now recorded on the job.
                logger.error("Batch TTS seg %d timed out — failing the job: %s", i, e)
                raise RuntimeError(
                    f"Segment {i + 1} of the {target_lang} track did not "
                    f"render, so the dubbed track would have shipped with a "
                    f"silent gap. {e}"
                ) from e
            except Exception as e:
                logger.warning("Batch TTS seg %d failed: %s", i, e)
                job.setdefault("warnings", []).append(
                    f"Segment {i + 1} of the {target_lang} track failed and was "
                    f"left silent: {e}"
                )

        # ── 3c. Save dubbed audio track ───────────────────────────────
        # Invisible provenance mark on the assembled track (#1169), tensor
        # stage, before the WAV write / aac mux — batch dubs used to ship
        # unmarked while the interactive dub pipeline marked every segment.
        # One whole-track embed (chunked internally, #1045) is equivalent to
        # dub_generate's per-segment marks: the 16-bit message repeats
        # throughout. Never raises (degrades to unmarked on failure, same as
        # every producer).
        # Dispatched to the dedicated watermark pool, not the GPU pool (#1190):
        # AudioSeal embedding is CPU work that holds no VRAM, and a whole-track
        # embed is long enough that occupying a GPU worker with it stalled the
        # next language's segments on 1-worker hosts.
        from services.watermark import mark_synthetic_async
        full_audio = await mark_synthetic_async(
            full_audio, sr, context="batch.dub_track",
        )

        # Same assembly pattern as dub_generate.py:390 — `full_audio` is a
        # zero-init tensor that gets +='d from torch.cat-style slices, so
        # it can land non-contiguous + out-of-range. Go through the
        # audited + atomic helper to defend against #48 silent corruption
        # and partial-write truncation simultaneously.
        track_path = os.path.join(batch_dir, f"dubbed_{target_lang}.wav")
        atomic_save_wav(track_path, full_audio, sr)

        # ── 3d. Mix with original video ───────────────────────────────
        _set_progress(
            job, "mix",
            percent=int(((lang_idx + 0.8) / total_langs) * 100),
            current_lang=target_lang,
        )

        output_path = os.path.join(batch_dir, f"output_{target_lang}.mp4")

        def _mix(bg=job.get("preserve_bg", True)):
            if bg:
                # Mix dubbed audio with original background
                subprocess.run(
                    [ffmpeg, "-y",
                     "-i", video_path,
                     "-i", track_path,
                     "-filter_complex",
                     bed_mix_filter("0:a", "1:a", out="out", duration="first"),
                     "-map", "0:v", "-map", "[out]",
                     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                     "-shortest", output_path],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=600, check=True,
                )
            else:
                # Replace audio entirely
                subprocess.run(
                    [ffmpeg, "-y",
                     "-i", video_path,
                     "-i", track_path,
                     "-map", "0:v", "-map", "1:a",
                     "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                     "-shortest", output_path],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=600, check=True,
                )

        await loop.run_in_executor(None, _mix)
        outputs[target_lang] = output_path

    job["outputs"] = outputs
    _set_progress(job, "done", 100)


# ── Endpoints ───────────────────────────────────────────────────────────

@router.post("/batch/enqueue")
async def enqueue_batch_job(
    video: UploadFile = File(...),
    langs: str = Form("es"),            # comma-separated lang codes
    voice_id: Optional[str] = Form(None),
    preserve_bg: bool = Form(True),
):
    """Enqueue a video for batch dubbing.

    The video is saved to disk and a job is added to the queue.
    Returns the job ID for status polling.
    """
    _ensure_queue()

    job_id = str(uuid.uuid4())[:12]
    lang_list = [l.strip() for l in langs.split(",") if l.strip()]
    if not lang_list:
        raise HTTPException(400, "At least one target language is required")

    # TTS-only install: no ASR model on disk → typed 409 with a download CTA
    # now, instead of accepting the job and having the transcribe stage
    # silently auto-download multi-GB whisper weights (or fail) in the worker.
    from services.asr_backend import asr_model_missing_detail, asr_model_missing_error
    missing = await asyncio.to_thread(asr_model_missing_error)
    if missing is not None:
        raise HTTPException(409, {**missing, "message": asr_model_missing_detail(missing)})

    # Save the uploaded video
    batch_dir = os.path.join(DATA_DIR, "batch")
    os.makedirs(batch_dir, exist_ok=True)
    ext = os.path.splitext(video.filename or "video.mp4")[1] or ".mp4"
    video_path = os.path.join(batch_dir, f"{job_id}{ext}")

    await _save_upload(video, video_path)

    job = {
        "id": job_id,
        "status": "queued",
        "filename": video.filename or f"{job_id}{ext}",
        "video_path": video_path,
        "langs": lang_list,
        "voice_id": voice_id,
        "preserve_bg": preserve_bg,
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "error": None,
        "progress": None,
    }
    _jobs[job_id] = job
    await _queue.put(job_id)

    logger.info(
        "Batch job %s enqueued (%d target languages)",
        log_safe(job_id), len(lang_list),
    )
    return {"job_id": job_id, "status": "queued", "queue_position": _queue.qsize()}


@router.get("/batch/jobs")
def list_batch_jobs(status: Optional[str] = None, limit: int = 50):
    """List batch jobs, optionally filtered by status."""
    jobs = list(_jobs.values())
    if status:
        if status == "active":
            jobs = [j for j in jobs if j["status"] in ("queued", "running")]
        else:
            jobs = [j for j in jobs if j["status"] == status]
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return jobs[:limit]


@router.get("/batch/jobs/{job_id}")
def get_batch_job(job_id: str):
    """Get the status of a specific batch job."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.post("/batch/jobs/{job_id}/cancel")
def cancel_batch_job(job_id: str):
    """Cancel a queued or running batch job."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] in ("done", "failed", "cancelled"):
        return {"already": job["status"]}
    job["status"] = "cancelled"
    job["finished_at"] = time.time()
    return {"cancelled": True}


@router.delete("/batch/jobs/{job_id}")
def delete_batch_job(job_id: str):
    """Delete a batch job record and its video file."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("video_path"):
        try:
            unlink_if_present(job["video_path"])
        except FileCleanupError as exc:
            raise HTTPException(
                status_code=500,
                detail="Could not delete the batch video file. Close any app using it and retry.",
            ) from exc
    _jobs.pop(job_id, None)
    return {"deleted": True}


@router.get("/batch/download/{job_id}/{lang}")
def download_batch_output(job_id: str, lang: str):
    """Download a completed batch job's output video for a given language."""
    from fastapi.responses import FileResponse

    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "done":
        raise HTTPException(400, f"Job is {job['status']}, not done")

    outputs = job.get("outputs", {})
    path = outputs.get(lang)
    if not path or not os.path.exists(path):
        raise HTTPException(404, f"No output for language '{lang}'")

    filename = f"{os.path.splitext(job['filename'])[0]}_{lang}.mp4"
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=filename,
    )
