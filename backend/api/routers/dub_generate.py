import os
import json
import logging
import time
import asyncio
import torch
import torchaudio
from fastapi import APIRouter, HTTPException

from core.db import db_conn
from core.config import DUB_DIR, VOICES_DIR, dub_seg_path
from core.tasks import task_manager
from schemas.requests import DubRequest
from services.model_manager import _gpu_pool, run_on_gpu_pool_guarded
from services.tts_backend import resolve_generation_backend
from services.audio_dsp import apply_mastering, normalize_audio, apply_effects_chain, get_effect_chain
from services.audio_io import atomic_save_wav, _safe_torchaudio_save
from services.ffmpeg_utils import (
    find_ffmpeg,
    spawn_subprocess,
    # Moved to ffmpeg_utils so the Smart Fit export pipeline (Phase B) can
    # reuse them; re-imported here so `dub_generate._atempo_chain` /
    # `_pitch_preserving_stretch` keep working for existing importers.
    _atempo_chain,
    _pitch_preserving_stretch,
)
from services.rvc import apply_rvc, is_enabled as rvc_is_enabled
from services.incremental import segment_fingerprint, fit_fingerprint
from services.fit_planner import FitParams, plan_fit
from services.watermark import embed_watermark
from api.routers.dub_core import _get_job, _save_job
from omnivoice.utils.voice_design import heal_design_instruct

logger = logging.getLogger("omnivoice.dub")

# Maximum compression ratio we'll attempt with pitch-preserving stretch
# before declaring "no way to fit cleanly" and falling back. atempo
# remains intelligible up to ~1.5× then introduces audible WSOLA
# artefacts; above ~1.8× speech becomes a fast garbled stream that no
# DSP can rescue. The contributing-factor pipeline (CPS-aware slot-fit
# in services/speech_rate.py, gap absorption below) keeps us under this
# in practice — this is only a guard rail.
MAX_STRETCH_RATIO = 1.8
# How far a too-long segment is allowed to bleed into the silent gap
# before the next segment. Buys headroom on languages with higher
# information density (Bengali, Hindi, Arabic…) without the audio
# colliding with the next speaker's onset.
GAP_OVERFLOW_MAX_S = 0.25
GAP_OVERFLOW_BUFFER_S = 0.05


def _sync_job_segments(job: dict, req: DubRequest) -> None:
    """Persist the segments this dub was actually generated from back onto the job.

    The editor only sends the (translated / user-edited) segment text in the
    generate request; the job itself kept the original-language ASR transcript.
    SRT/VTT export and ffmpeg subtitle burn-in read `job["segments"]`, so they
    rendered the source language instead of the dub the user just heard (#309).

    Merge strategy: rebuild `job["segments"]` from the request, carrying over
    per-segment metadata (speaker_id, id, …) from the existing job segment
    matched by stable id (fallback: index). `text_original` always keeps the
    source-language text so dual-subtitle layouts can still stack it under the
    translation.
    """
    if not req.segments:
        return
    existing = [s for s in (job.get("segments") or []) if isinstance(s, dict)]
    by_id = {str(s["id"]): s for s in existing if s.get("id") is not None}
    seg_ids = req.segment_ids or []
    merged: list[dict] = []
    for i, seg in enumerate(req.segments):
        seg_id = seg_ids[i] if i < len(seg_ids) else None
        prev = by_id.get(str(seg_id)) if seg_id is not None else None
        if prev is None and i < len(existing):
            prev = existing[i]
        row = dict(prev) if prev else {}
        if seg_id is not None:
            # The request id is authoritative — seg_order and the per-segment
            # WAV manifest are keyed by it.
            row["id"] = seg_id
        # Source-language text survives the overwrite so dual-subtitle export
        # keeps working; never let the translation clobber it.
        row["text_original"] = row.get("text_original") or row.get("text") or ""
        row["start"] = seg.start
        row["end"] = seg.end
        row["text"] = seg.text
        merged.append(row)
    job["segments"] = merged

    # P1.2 — per-language text, additively. `job["segments"]` stays the flat
    # single-slot map every existing consumer reads (last generated language);
    # `job["segments_i18n"]` preserves EACH generated track's text so
    # /dub/srt|vtt?lang= can emit that language instead of N identical files.
    # Shape: { langCode: { segKey: text } } where segKey is the segment's
    # stable id (str) or, for id-less legacy segments, its list index (str).
    # The whole per-language map is rebuilt on every generate of that language
    # (the request always carries the full segment list), so deleted segments
    # never linger. Jobs predating this field simply lack it — every reader
    # falls back to `job["segments"]`.
    lang = (req.language_code or "und").strip() or "und"
    i18n = job.setdefault("segments_i18n", {})
    i18n[lang] = {
        (str(row["id"]) if row.get("id") is not None else str(i)): row["text"]
        for i, row in enumerate(merged)
    }


def _seg_hashes_by_lang(job: dict) -> dict:
    """Per-language segment fingerprints: { langCode: { segId: hash } }.

    Additive migration (P1.3): jobs written by previous builds carry ONE flat
    `seg_hashes` map that was overwritten by whichever language generated
    last. That flat map can only describe the job's last-generated track, so
    it is attributed to `job["language_code"]` (which generate has always
    kept in lock-step with the last run). When even that is unknown the
    legacy hashes are dropped — segments then read as stale and regenerate
    cleanly, which is safer than guessing a language and splicing wrong-track
    audio. Note the legacy hashes also predate language-scoped fingerprints
    (see services.incremental.segment_fingerprint), so they compare stale
    once regardless — carrying them over just preserves the job shape.
    """
    by_lang = job.get("seg_hashes_by_lang")
    if not isinstance(by_lang, dict):
        by_lang = {}
        legacy = job.get("seg_hashes")
        prev_lang = job.get("language_code")
        if isinstance(legacy, dict) and legacy and prev_lang:
            by_lang[prev_lang] = dict(legacy)
        job["seg_hashes_by_lang"] = by_lang
    return by_lang


def _legacy_seg_cache_ok(job: dict, lang_code: str) -> bool:
    """May this run reuse legacy un-keyed ``seg_<id>.wav`` files?

    Only when no OTHER language's audio could be sitting in them: the job has
    no dubbed track in a different language. Single-language jobs rendered by
    previous builds therefore keep their whole on-disk cache; the moment a
    job carries a second language the un-keyed files are ambiguous (they hold
    whichever language wrote them last) and must never be spliced into a
    track again — the P1.3 cross-contamination class.
    """
    tracks = job.get("dubbed_tracks") or {}
    return not any(lc != lang_code for lc in tracks)


router = APIRouter()

@router.post("/dub/generate/{job_id}")
async def dub_generate(job_id: str, req: DubRequest):
    """Adds a dub generation job to the async batch task pool."""
    job = _get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="This dub session has expired or was never created. Re-upload the video to start a new one.",
        )

    # ── Engine resolution (issue #312 class) ────────────────────────────────
    # Dub used to hardcode OmniVoice via get_model() regardless of the engine
    # selected in Settings → Engines — a SILENT fallback. Every real dub
    # segment's ref_audio resolves to either an auto:<speaker>/auto-seg:<id>
    # clone cut from the source video or a saved voice-profile row (see
    # `_gen` below), so require_cloning=True: an engine that can't clone
    # would either mis-clone per segment or fail deep into the job. Checked
    # ONCE here, before the streaming task starts, so a doomed job fails fast
    # with one clear message instead of N per-segment ones.
    try:
        backend = await resolve_generation_backend(require_cloning=True)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    async def _stream(task_id):
        total = len(req.segments)
        all_segment_wavs = []
        sync_scores = []

        # Track language for this run. Everything per-track — the per-segment
        # WAV cache, fingerprints, seg_wav_kind — is keyed by it (P1.3) so a
        # multi-language job's tracks can't cross-contaminate.
        lang_code = req.language_code or "und"

        def _seg_lang_path(seg_key) -> str:
            # Per-language per-segment WAV: seg_{lang}_{id}.wav. Built through
            # dub_seg_path so the sanitisation + DUB_DIR containment guard
            # apply to the combined key. Legacy un-keyed seg_{id}.wav files
            # remain readable via the gated fallback (_legacy_seg_cache_ok).
            return dub_seg_path(job_id, f"{lang_code}_{seg_key}")

        # Throttle the device cache flush. empty_cache() is a synchronous
        # device stall, so calling it every segment (as the old code did)
        # serialised the GPU loop; the batched-I/O design it replaced kept
        # it off the hot path on purpose. Flush every ~16 releases instead —
        # frequent enough to bound VRAM, rare enough to stay invisible.
        _RELEASE_FLUSH_EVERY = 16
        _release_count = {"n": 0}

        def _release_audio_tensors(*objs) -> None:
            """Best-effort VRAM cleanup after a segment is safely on disk.

            Tensors are freed by the callers' own ``del`` once they fall out
            of scope; this only throttles the device cache flush. ``*objs`` is
            kept for call-site compatibility but intentionally unused — a local
            ``del`` here would only unbind the parameter, never the caller's
            reference.
            """
            _release_count["n"] += 1
            if _release_count["n"] % _RELEASE_FLUSH_EVERY != 0:
                return
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    torch.mps.empty_cache()
            except Exception:
                pass

        # mix_<id> scratch WAVs written for silence/cached-fail/error slots are
        # pure assembly inputs (no preview/regen contract), so they're deleted
        # once the final track is written.
        _mix_temp_paths: list[str] = []

        def _store_mix_wav(start: float, end: float, wav: torch.Tensor, sr: int, seg_key: str):
            """Write one segment to disk and keep only its path in the mix manifest.

            A zero/negative-length buffer is never written (``atomic_save_wav``
            raises on empty audio); instead a harmless zero-length in-memory
            entry is returned, which the assembly tolerates via its ``e > s``
            guard.
            """
            if wav.shape[-1] <= 0:
                return (start, end, torch.zeros(1, 0), sr)
            path = dub_seg_path(job_id, seg_key)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            atomic_save_wav(path, wav.detach().cpu(), sr)
            if seg_key.startswith("mix_"):
                _mix_temp_paths.append(path)
            _release_audio_tensors(wav)
            return (start, end, path, sr)

        def _entry_num_samples(entry) -> int:
            # Zero/negative-duration slots are kept as in-memory tensors (never
            # written to disk); report their length directly.
            if isinstance(entry[2], torch.Tensor):
                return int(entry[2].shape[-1])
            try:
                info = torchaudio.info(entry[2])
                return int(info.num_frames)
            except Exception:
                wav, _sr = torchaudio.load(entry[2])
                n = int(wav.shape[-1])
                _release_audio_tensors(wav)
                return n

        def _load_entry_wav(entry, target_sr: int) -> torch.Tensor:
            if isinstance(entry[2], torch.Tensor):
                return entry[2]
            wav, loaded_sr = torchaudio.load(entry[2])
            if loaded_sr != target_sr:
                import torchaudio.functional as AF
                wav = AF.resample(wav, loaded_sr, target_sr)
            return wav

        def _write_memmap_wav_atomic(target_path: str, samples, sample_rate: int) -> None:
            """Write a mono float32 memmap to int16 WAV without loading it all.

            Intentionally does NOT watermark: the final track is assembled from
            per-segment WAVs that were already watermarked once at synthesis
            time (see the seg-write path below), exactly as ``main`` does.
            Re-marking here would double-mark every segment in the final mix.
            """
            import tempfile
            import wave
            import numpy as np

            target_dir = os.path.dirname(target_path) or "."
            target_base = os.path.basename(target_path)
            fd, tmp_path = tempfile.mkstemp(
                prefix=f".{target_base}.",
                suffix=".wav",
                dir=target_dir,
            )
            os.close(fd)
            chunk_samples = max(sample_rate * 30, 1)
            try:
                with wave.open(tmp_path, "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(sample_rate)
                    total_len = int(samples.shape[0])
                    for off in range(0, total_len, chunk_samples):
                        chunk = np.array(samples[off: off + chunk_samples], dtype=np.float32, copy=True)
                        if chunk.size == 0:
                            continue
                        np.nan_to_num(chunk, copy=False, nan=0.0, posinf=1.0, neginf=-1.0)
                        chunk = np.clip(chunk, -1.0, 1.0)
                        pcm = (chunk * 32767.0).astype("<i2", copy=False)
                        wf.writeframes(pcm.tobytes())
                os.replace(tmp_path, target_path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise

        # Phase 4.1 — partial regen. If `regen_only` is set, we only run TTS
        # on segments whose id is in that set; the others reuse their existing
        # `seg_i.wav` on disk and slot into the final mix unchanged.
        regen_only = set(req.regen_only or []) if req.regen_only is not None else None
        seg_ids = req.segment_ids or []
        strategy = (req.timing_strategy or "concise").lower()
        # Strategy-transition guard: smart_fit re-mixes the *natural-rate*
        # per-segment WAVs from disk. If the previous run used strict_slot,
        # the on-disk WAVs are slot-squeezed ("slotted") — reusing them would
        # double-compress. Force one full regen; afterwards seg_wav_kind is
        # "natural" and partial regen / fit-only re-mix (regen_only=[]) work.
        # Jobs predating this field have unknown kind → also regen once.
        # P1.3: the kind is per-track now (each language renders under its own
        # strategy); the flat job["seg_wav_kind"] is only consulted for jobs
        # written before the per-language map existed — once the map is
        # present, a language without an entry has unknown-kind WAVs (or none
        # at all) and must regen once, exactly like the pre-field case.
        _kind_map = job.get("seg_wav_kind_by_lang")
        _wav_kind = (
            _kind_map.get(lang_code) if isinstance(_kind_map, dict) else job.get("seg_wav_kind")
        )
        if strategy == "smart_fit" and regen_only is not None and _wav_kind != "natural":
            regen_only = None
        # Manifest: stable segment id per current index. Per-segment WAVs are
        # named by stable id (dub_seg_path) so regen reuses the right audio after
        # reorder; index-keyed readers (preview/export) resolve via this manifest.
        job["seg_order"] = [seg_ids[k] if k < len(seg_ids) else f"seg_{k}" for k in range(len(req.segments))]

        # Per-segment metadata to persist after the hot loop. Audio itself is
        # written immediately and only file paths are kept, so long videos don't
        # retain every generated tensor in RAM until final assembly.
        _pending_seg_writes: list[tuple] = []

        # Calibration records for the pre-synthesis duration planner
        # (services/duration_planner.py): text length + the NATURAL-rate TTS
        # duration of every freshly synthesized segment. Only meaningful for
        # the natural-rate strategies — strict_slot forces the audio to the
        # slot length, which would poison the observed chars-per-second.
        _natural_dur_records: dict[str, dict] = {}

        # Phase 4.1 bench instrumentation: measure where incremental time goes.
        # Only prints when regen_only is active (real-user incremental path).
        _t_start = time.perf_counter()
        _t_cache = 0.0
        _t_tts = 0.0

        for i, seg in enumerate(req.segments):
            seg_id = seg_ids[i] if i < len(seg_ids) else f"seg_{i}"

            # Check abort flag before each segment
            if task_manager.is_cancelled(task_id):
                yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i})}\n\n"
                return

            yield f"data: {json.dumps({'type': 'progress', 'current': i, 'total': total, 'text': seg.text[:50]})}\n\n"

            seg_duration = seg.end - seg.start
            if seg_duration <= 0.05 or not seg.text.strip():
                sr = backend.sample_rate
                # max(0, …): a zero/negative-duration slot must not feed a
                # negative length to torch.zeros (raises) — _store_mix_wav
                # turns the empty buffer into a harmless in-memory entry.
                silence = torch.zeros(1, max(0, int(seg_duration * sr)))
                all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, silence, sr, f"mix_{seg_id}"))
                try:
                    del silence
                except Exception:
                    pass
                _release_audio_tensors()
                sync_scores.append(1.0)
                continue

            # Partial regen: if this segment isn't in the allow-list, reuse its
            # previously-rendered WAV so the final mix still covers the timeline.
            if regen_only is not None and seg_id not in regen_only:
                # This track's own cache first (seg_{lang}_{id}.wav). Legacy
                # un-keyed files (seg_{id}.wav / seg_{index}.wav) are reused
                # ONLY when no other-language track exists on the job — a
                # multi-track job's un-keyed files hold whichever language
                # rendered last, and splicing them here was exactly how
                # "Regen N changed" mixed language B into track A (P1.3).
                seg_wav_path = _seg_lang_path(seg_id)
                if not os.path.exists(seg_wav_path) and _legacy_seg_cache_ok(job, lang_code):
                    for _legacy_key in (seg_id, i):
                        _legacy = dub_seg_path(job_id, _legacy_key)
                        if os.path.exists(_legacy):
                            seg_wav_path = _legacy
                            break
                if os.path.exists(seg_wav_path):
                    try:
                        _t_cache_0 = time.perf_counter()
                        cached_wav, cached_sr = torchaudio.load(seg_wav_path)
                        if cached_sr != backend.sample_rate:
                            import torchaudio.functional as AF
                            cached_wav = AF.resample(cached_wav, cached_sr, backend.sample_rate)
                        # Pad/trim to slot — except smart_fit, whose mix
                        # loop needs the natural-rate length to compute the
                        # audio/video split (the seg_wav_kind guard above
                        # guarantees these cached WAVs are natural-rate).
                        if strategy != "smart_fit":
                            target_samples = int(seg_duration * backend.sample_rate)
                            current_samples = cached_wav.shape[-1]
                            if target_samples > current_samples:
                                cached_wav = torch.nn.functional.pad(cached_wav, (0, target_samples - current_samples))
                            elif current_samples > target_samples:
                                cached_wav = cached_wav[..., :target_samples]
                        all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, cached_wav, backend.sample_rate, f"mix_{seg_id}"))
                        try:
                            del cached_wav
                        except Exception:
                            pass
                        _release_audio_tensors()
                        sync_scores.append(getattr(seg, 'sync_ratio', None) or 1.0)
                        _t_cache += time.perf_counter() - _t_cache_0
                        continue
                    except Exception as e:
                        # Fall through to a silent placeholder if the cached WAV
                        # is broken — cleaner than aborting the whole mix.
                        yield f"data: {json.dumps({'type': 'warning', 'segment': i, 'message': f'cached seg lost, padding silence: {str(e)[:120]}'})}\n\n"
                sr = backend.sample_rate
                silence = torch.zeros(1, max(0, int(seg_duration * sr)))
                all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, silence, sr, f"mix_{seg_id}"))
                try:
                    del silence
                except Exception:
                    pass
                _release_audio_tensors()
                sync_scores.append(1.0)
                continue

            def _gen(text, lang, instruct_str, dur_s, nstep, cfg, spd, profile_id, effect_preset):
                # Normalize once at the segment's text→engine choke point
                # (covers the OOM-retry generate below too, which reuses this
                # closure's `text`). Pref-gated, idempotent, never raises.
                from services.text_normalization import normalize_for_tts
                text = normalize_for_tts(text, lang)

                ref_audio = None
                ref_text = None
                used_seed = None

                # Auto-clones extracted from the source video during prepare
                # (see services/speaker_clone.py) live at job["speaker_clones"]
                # keyed by speaker_id. We use the `auto:` prefix so they can't
                # collide with persistent voice_profiles.id values.
                # Wave 3.2: a per-segment clone ref (cut from this line's own
                # source audio) takes precedence over the per-speaker clone.
                if profile_id and profile_id.startswith("auto-seg:"):
                    sid = profile_id[len("auto-seg:"):]
                    info = (job.get("segment_clones") or {}).get(sid)
                    if info:
                        ref_audio = info.get("ref_audio")
                        ref_text = info.get("ref_text")
                    profile_id = None  # prevent the voice_profiles lookup below

                elif profile_id and profile_id.startswith("auto:"):
                    # #486: an `auto:{speaker}` binding still prefers THIS
                    # segment's own per-segment ref when one exists (cut from
                    # this line's source audio → matches its prosody), falling
                    # back to the per-speaker clone otherwise. This keeps the
                    # Wave 3.2 per-segment-ref quality win while letting every
                    # segment carry the UI-visible `auto:` id the dub editor's
                    # Voice dropdown can actually render ("From Video →
                    # Speaker N"). `seg_id` is closed over from the per-segment
                    # loop below.
                    seg_ref = (job.get("segment_clones") or {}).get(str(seg_id))
                    if seg_ref:
                        ref_audio = seg_ref.get("ref_audio")
                        ref_text = seg_ref.get("ref_text")
                    else:
                        key = profile_id[len("auto:"):]
                        clones = job.get("speaker_clones") or {}
                        # Match by the safe-name key first, fall back to speaker_id.
                        auto = None
                        for spk, info in clones.items():
                            if spk.lower().replace(" ", "_") == key or spk == key:
                                auto = info
                                break
                        if auto:
                            ref_audio = auto.get("ref_audio")
                            ref_text = auto.get("ref_text")
                    profile_id = None  # prevent the voice_profiles lookup below

                if profile_id:
                    with db_conn() as conn:
                        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
                    if row:
                        if row["is_locked"] and row["locked_audio_path"]:
                            ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                            ref_text = row["ref_text"]
                            used_seed = row["seed"]
                        elif row["instruct"] and not row["is_locked"]:
                            used_seed = row["seed"] 
                        else:
                            ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                            ref_text = row["ref_text"]
                            used_seed = row["seed"]
                            
                        if not instruct_str:
                            try:
                                _vd = row["vd_states"]
                            except (KeyError, IndexError):
                                _vd = None
                            instruct_str = heal_design_instruct(row["instruct"], _vd)

                if used_seed is not None:
                    torch.manual_seed(used_seed)

                try:
                    audio_out = backend.generate(
                        text=text, language=lang if lang != "Auto" else None,
                        ref_audio=ref_audio, ref_text=ref_text,
                        instruct=instruct_str if instruct_str else None,
                        duration=dur_s, num_step=nstep, guidance_scale=cfg,
                        speed=spd, denoise=True, postprocess_output=True,
                    )
                    sr = backend.sample_rate

                    # Apply per-segment DSP effect preset (default: broadcast)
                    seg_effect_preset = effect_preset or "broadcast"
                    if seg_effect_preset == "raw":
                        return audio_out

                    mastered_audio = audio_out
                    if not getattr(backend, "applies_own_mastering", False):
                        mastered_audio = apply_mastering(audio_out, sample_rate=sr)
                    effect_chain = get_effect_chain(seg_effect_preset)
                    if effect_chain:
                        mastered_audio = apply_effects_chain(
                            mastered_audio,
                            sample_rate=sr,
                            chain=effect_chain,
                        )
                    return normalize_audio(mastered_audio, target_dBFS=-2.0)
                except Exception as e:
                    is_oom = (
                        isinstance(e, torch.cuda.OutOfMemoryError)
                        or "out of memory" in str(e).lower()
                        or "CUDA error" in str(e)
                    )
                    import gc
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                        torch.mps.empty_cache()

                    if not is_oom:
                        raise

                    retry_steps = min(nstep, 8)
                    logger.warning(
                        "OOM on segment (nstep=%d), retrying with %d steps after cache flush",
                        nstep, retry_steps,
                    )
                    try:
                        audio_out = backend.generate(
                            text=text, language=lang if lang != "Auto" else None,
                            ref_audio=ref_audio, ref_text=ref_text,
                            instruct=instruct_str if instruct_str else None,
                            duration=dur_s, num_step=retry_steps, guidance_scale=cfg,
                            speed=spd, denoise=True, postprocess_output=True,
                        )
                        sr = backend.sample_rate

                        seg_effect_preset = effect_preset or "broadcast"
                        if seg_effect_preset == "raw":
                            return audio_out

                        mastered_audio = audio_out
                        if not getattr(backend, "applies_own_mastering", False):
                            mastered_audio = apply_mastering(audio_out, sample_rate=sr)
                        effect_chain = get_effect_chain(seg_effect_preset)
                        if effect_chain:
                            mastered_audio = apply_effects_chain(
                                mastered_audio,
                                sample_rate=sr,
                                chain=effect_chain,
                            )
                        return normalize_audio(mastered_audio, target_dBFS=-2.0)
                    except Exception as retry_err:
                        raise RuntimeError(
                            f"Ran out of GPU memory generating this segment. "
                            f"Retried with {retry_steps} steps but still failed. "
                            f"Try the Flush button in the header to free VRAM, "
                            f"or switch to CPU in Settings. "
                            f"Underlying error: {retry_err}"
                        ) from retry_err

            seg_profile = seg.profile_id or None
            seg_speed = seg.speed if hasattr(seg, 'speed') and seg.speed is not None else req.speed
            seg_lang = seg.target_lang if getattr(seg, 'target_lang', None) else req.language

            seg_instruct = seg.instruct or req.instruct
            # Phase 4.2 — if the segment carries a free-form direction, parse it
            # and append the taxonomy instruct (e.g. "urgent, surprised") on top
            # of whatever instruct was already set. Also apply the director's
            # speed bias so "urgent" actually sounds a bit quicker.
            seg_direction = getattr(seg, 'direction', None)
            if seg_direction and seg_direction.strip():
                try:
                    from services.director import parse as _parse_direction
                    d = _parse_direction(seg_direction)
                    extra_instruct = d.instruct_prompt()
                    if extra_instruct:
                        seg_instruct = (
                            f"{seg_instruct}, {extra_instruct}" if seg_instruct else extra_instruct
                        )
                    bias = d.rate_bias()
                    if bias and abs(bias - 1.0) > 0.01:
                        # Speed-bias from a Direction only multiplies seg_speed
                        # in strict_slot mode, which is the legacy path that
                        # compresses audio at synthesis time to fit the slot.
                        # In concise / stretch_video modes we preserve natural
                        # rate so the user gets the "urgent" or "slow" voice
                        # the director asked for without the chipmunk side-
                        # effect that overshooting the slot would otherwise
                        # cause.
                        if (req.timing_strategy or "concise") == "strict_slot":
                            seg_speed = (seg_speed or 1.0) * bias
                except Exception as e:
                    logger.debug("direction parse skipped for %s: %s", getattr(seg, 'id', '?'), e)

            loop = asyncio.get_running_loop()
            try:
                # Fast-preview mode for interactive edits — trade ~10–20 %
                # quality for ~2× speed by dropping flow-matching steps.
                # Client sends `preview=true` when the user is iterating;
                # before final export the client should re-call without the
                # flag to restore num_step=req.num_step quality.
                _num_step = 8 if req.preview else req.num_step
                _t_tts_0 = time.perf_counter()
                seg_effect_preset = getattr(seg, "effect_preset", None) or "broadcast"

                # In concise / stretch_video / smart_fit modes we pass
                # dur_s=None so the TTS model speaks at its natural rate for
                # this text length — the whole point of the new timing
                # strategies is to never squeeze the speech to fit at
                # synthesis time. strict_slot keeps the legacy behaviour
                # where dur_s is the slot hint.
                _dur_for_tts = seg_duration if strategy == "strict_slot" else None

                # Bounded + pool-reset on hang so a wedged dub segment can't
                # starve the GPU pool and brick the backend (#730 class).
                audio_tensor = await run_on_gpu_pool_guarded(
                    lambda: _gen(
                        seg.text, seg_lang, seg_instruct, _dur_for_tts,
                        _num_step, req.guidance_scale, seg_speed, seg_profile, seg_effect_preset,
                    ),
                    what="Dub generate",
                )
                _t_tts += time.perf_counter() - _t_tts_0

                # Check abort immediately after GPU work completes
                if task_manager.is_cancelled(task_id):
                    yield f"data: {json.dumps({'type': 'cancelled', 'segments_processed': i + 1})}\n\n"
                    return

                target_samples = int(seg_duration * backend.sample_rate)
                current_samples = audio_tensor.shape[-1]

                if strategy == "strict_slot":
                    # Legacy: pad short audio + trim long audio so the mix
                    # loop receives slot-sized buffers. The atempo squeeze
                    # in the mix loop never fires here because we already
                    # forced size = target_samples.
                    if target_samples > current_samples:
                        pad_amount = target_samples - current_samples
                        audio_tensor = torch.nn.functional.pad(audio_tensor, (0, pad_amount))
                    elif current_samples > target_samples:
                        audio_tensor = audio_tensor[..., :target_samples]
                # concise / stretch_video / smart_fit: keep audio at its
                # natural length. The mix loop decides per-mode whether to
                # trim, slip, stretch the video, or split audio/video
                # retiming (smart_fit) to accommodate it.

                generated_dur = audio_tensor.shape[-1] / backend.sample_rate
                sync_ratio = round(generated_dur / max(seg_duration, 0.01), 3)

                sync_scores.append(sync_ratio)

                # Duration-planner calibration sample: this text length spoke
                # for this long at natural rate. Keyed by stable seg id and
                # merged into the per-language job map after the loop.
                if strategy != "strict_slot" and seg.text.strip() and generated_dur > 0:
                    _natural_dur_records[str(seg_id)] = {
                        "chars": len(seg.text.strip()),
                        "dur": round(generated_dur, 4),
                    }

                # Build the fingerprint now (cheap) but defer the disk write
                # and job flush to the batch-write phase after the GPU loop.
                _seg_fp = None
                try:
                    # track_lang scopes the hash to THIS track (P1.3); the
                    # client-side recompute (/tools/incremental) sends the
                    # same code, so parity (#281 class) holds per language.
                    _seg_fp = segment_fingerprint({
                        "text": seg.text,
                        "target_lang": getattr(seg, "target_lang", None),
                        "profile_id": getattr(seg, "profile_id", None),
                        "instruct": getattr(seg, "instruct", None),
                        "speed": getattr(seg, "speed", None),
                        "direction": getattr(seg, "direction", None),
                        "effect_preset": getattr(seg, "effect_preset", None),
                    }, track_lang=lang_code)
                except Exception as e:
                    logger.debug("seg fingerprint skipped for %s: %s", seg_id, e)

                _pending_seg_writes.append((i, backend.sample_rate, seg_id, _seg_fp, _num_step))

                # RVC needs the WAV on disk, so write it immediately only
                # when RVC is active (uncommon path).
                if rvc_is_enabled():
                    seg_wav_path = _seg_lang_path(seg_id)
                    atomic_save_wav(seg_wav_path, audio_tensor, backend.sample_rate)
                    try:
                        await loop.run_in_executor(_gpu_pool, apply_rvc, seg_wav_path)
                        rvc_wav, rvc_sr = torchaudio.load(seg_wav_path)
                        if rvc_sr == backend.sample_rate:
                            audio_tensor = rvc_wav

                            target_samples = int(seg_duration * backend.sample_rate)
                            current_samples = audio_tensor.shape[-1]
                            if target_samples > current_samples:
                                audio_tensor = torch.nn.functional.pad(audio_tensor, (0, target_samples - current_samples))
                            elif current_samples > target_samples:
                                audio_tensor = audio_tensor[..., :target_samples]
                    except Exception as e:
                        yield f"data: {json.dumps({'type': 'warning', 'segment': i, 'message': f'RVC skipped: {str(e)[:120]}'})}\n\n"

                # Watermark this FRESH TTS output exactly once, right before it
                # is persisted. The same seg_{lang}_{id}.wav is BOTH the
                # downloadable per-segment file AND the assembly input for the
                # final track, so marking it here (and nowhere else) gives the
                # downloadable WAV its mark back and the final mix inherits it —
                # no double-mark. Cached-reuse audio is already marked;
                # silence/zero slots carry no speech to mark, so neither is
                # re-watermarked.
                audio_tensor = embed_watermark(audio_tensor, backend.sample_rate)

                seg_wav_path = _seg_lang_path(seg_id)
                try:
                    # Keep the existing per-segment WAV contract for previews
                    # and partial regeneration, but do not keep the tensor in RAM.
                    atomic_save_wav(seg_wav_path, audio_tensor, backend.sample_rate)
                except Exception as e:
                    logger.warning("seg write failed for %s: %s", seg_id, e)
                    # If the durable segment write fails, still preserve a mix
                    # copy so this generation can finish.
                    all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, audio_tensor, backend.sample_rate, f"mix_{seg_id}"))
                    try:
                        del audio_tensor
                    except Exception:
                        pass
                    _release_audio_tensors()
                else:
                    all_segment_wavs.append((seg.start, seg.end, seg_wav_path, backend.sample_rate))
                    try:
                        del audio_tensor
                    except Exception:
                        pass
                    _release_audio_tensors()
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'segment': i, 'error': str(e)})}\n\n"
                sr = backend.sample_rate
                all_segment_wavs.append(_store_mix_wav(seg.start, seg.end, torch.zeros(1, max(0, int(seg_duration * sr))), sr, f"mix_{seg_id}"))
                sync_scores.append(1.0)

        _t_loop_end = time.perf_counter()

        yield f"data: {json.dumps({'type': 'assembling'})}\n\n"

        # ── Batch metadata phase ──────────────────────────────────────
        # Per-segment WAVs were written during the loop to keep RAM bounded.
        # Flush only lightweight fingerprints/quality metadata here.
        _t_diskw_0 = time.perf_counter()
        # P1.3 — fingerprints live per language so each track's staleness is
        # judged against ITS OWN last generate. The flat job["seg_hashes"] is
        # kept as a mirror of the CURRENT track's map: every existing consumer
        # (the `done` event, dub-history restore, older frontends) already
        # treats it as "the hashes of the language generated last", which is
        # exactly what it now provably contains.
        hashes = _seg_hashes_by_lang(job).setdefault(lang_code, {})
        quality_map = job.setdefault("seg_num_step", {})
        for (_si, _sr, _sid, _fp, _nstep) in _pending_seg_writes:
            if _fp is not None:
                hashes[_sid] = _fp
            quality_map[_sid] = _nstep
        job["seg_hashes"] = dict(hashes)
        # Duration-planner calibration: per-language (chars, natural dur)
        # records. update() (not replace) so partial regens keep accumulating
        # samples from earlier runs of this track.
        if _natural_dur_records:
            job.setdefault("seg_natural_durs_by_lang", {}).setdefault(
                lang_code, {},
            ).update(_natural_dur_records)
        # Single job flush instead of one per 8 segments.
        _save_job(job_id, job)
        _t_diskw = time.perf_counter() - _t_diskw_0

        sr = backend.sample_rate
        slot_fit = (req.slot_fit or "time_stretch").lower()
        overflow_budget_s = max(0.0, float(req.overflow_budget_s or 0.0))

        # Per-segment fit_status emitted alongside the legacy sync_scores so
        # the UI can replace the lying "Sync: 100%" badge with a truthful
        # "Fits / Overflows +0.4s / Slipped 0.2s / Video stretched 1.18×".
        fit_status: list[dict] = []

        # Mode B layout: when stretch_video is on, compute a new timeline
        # where each segment's slot equals the natural-rate dub audio length;
        # gaps stay at 1.0×. Persisted on the job so dub_export.py can build
        # the matching per-segment setpts filter chain on the source video.
        new_layout: list[tuple[float, float]] = []
        video_stretch_plan: list[dict] = []
        fit_plan = None  # smart_fit only — services.fit_planner.FitPlan
        orig_total_dur = float(job.get("duration") or 0.0)

        if strategy == "stretch_video":
            cursor = 0.0
            for i, (orig_start, orig_end, wav_path, _) in enumerate(all_segment_wavs):
                wl_i = _entry_num_samples((orig_start, orig_end, wav_path, sr))
                natural_dur = (wl_i / sr) if wl_i > 0 else max(0.0, orig_end - orig_start)
                if i == 0:
                    # Preserve the pre-roll (silence before the first seg).
                    cursor = orig_start
                else:
                    prev_orig_end = all_segment_wavs[i - 1][1]
                    gap = max(0.0, orig_start - prev_orig_end)
                    cursor += gap
                new_start = cursor
                new_end = cursor + natural_dur
                new_layout.append((new_start, new_end))
                orig_dur = max(1e-3, orig_end - orig_start)
                video_stretch_plan.append({
                    "orig_start": round(orig_start, 4),
                    "orig_end": round(orig_end, 4),
                    "new_start": round(new_start, 4),
                    "new_end": round(new_end, 4),
                    "stretch_ratio": round(natural_dur / orig_dur, 4),
                })
                cursor = new_end
            # Preserve the trailing tail (anything after the last seg in the
            # original video) at 1.0× rate.
            if all_segment_wavs:
                last_orig_end = all_segment_wavs[-1][1]
                cursor += max(0.0, orig_total_dur - last_orig_end)
            new_total_dur = max(cursor, orig_total_dur)
            total_samples = int(new_total_dur * sr)
        elif strategy == "smart_fit":
            # Smart Fit: plan the audio-rate / video-ratio split per segment
            # from the natural-rate WAV lengths. Pure planning — the mix
            # loop below applies the audio side; the video side ships as
            # fit_plans[lang] for the (Phase B) export pipeline.
            _fo = req.fit_options
            _fit_defaults = FitParams()
            fit_params = FitParams(
                max_audio_only_rate=float(getattr(_fo, "max_audio_only_rate", None) or _fit_defaults.max_audio_only_rate),
                audio_rate_cap=float(getattr(_fo, "audio_rate_cap", None) or _fit_defaults.audio_rate_cap),
                video_slow_cap=float(getattr(_fo, "video_slow_cap", None) or _fit_defaults.video_slow_cap),
                gap_guard_s=float(_fo.gap_guard_s) if _fo is not None and _fo.gap_guard_s is not None else _fit_defaults.gap_guard_s,
                allow_video_retime=bool(_fo.allow_video_retime) if _fo is not None and _fo.allow_video_retime is not None else _fit_defaults.allow_video_retime,
            )
            _seg_order = job.get("seg_order") or []
            fit_plan = plan_fit(
                [
                    {
                        "id": _seg_order[i] if i < len(_seg_order) else f"seg_{i}",
                        "start": s,
                        "end": e,
                    }
                    for i, (s, e, _path, _) in enumerate(all_segment_wavs)
                ],
                [_entry_num_samples(entry) / sr for entry in all_segment_wavs],
                orig_total_dur,
                fit_params,
            )
            total_samples = int(fit_plan.total_duration * sr)
        else:
            total_samples = int(orig_total_dur * sr)

        # smart_fit: cue times for the fitted timeline, computed from the
        # ACTUAL stretched/trimmed sample positions in the mix loop below —
        # not from the plan — so subtitles land exactly on the audio.
        fitted_cues: list[dict] = []

        track_path = os.path.join(DUB_DIR, job_id, f"dubbed_{lang_code}.wav")
        os.makedirs(os.path.dirname(track_path), exist_ok=True)

        import gc
        import tempfile
        import numpy as np

        mix_samples = max(total_samples, 1)
        fd, mix_path = tempfile.mkstemp(
            prefix=f".{os.path.basename(track_path)}.mix.",
            suffix=".f32",
            dir=os.path.dirname(track_path),
        )
        os.close(fd)
        try:
            with open(mix_path, "r+b") as mix_file:
                mix_file.truncate(mix_samples * 4)
            mix_audio = np.memmap(mix_path, dtype=np.float32, mode="r+", shape=(mix_samples,))

            for i, (start, end, wav_path, _) in enumerate(all_segment_wavs):
                seg_ref = req.segments[i] if i < len(req.segments) else None
                seg_gain = getattr(seg_ref, "gain", None) if seg_ref is not None else None
                seg_gain = seg_gain if seg_gain is not None else 1.0
                seg_gain = max(0.0, min(2.0, seg_gain))
                wav = _load_entry_wav((start, end, wav_path, sr), sr)
                adjusted = wav * seg_gain
                if adjusted.ndim == 2 and adjusted.shape[0] > 1:
                    adjusted = adjusted.mean(dim=0, keepdim=True)
                wl = adjusted.shape[-1]
                natural_dur = wl / sr if wl > 0 else 0.0
                orig_dur = max(0.0, end - start)

                if strategy == "stretch_video":
                    # Mode B: audio at natural rate, placed on the stretched
                    # timeline. No trim, no atempo. dub_export handles the video.
                    new_start, _new_end = new_layout[i]
                    place_at = new_start
                    fit_status.append({
                        "status": "video_stretched",
                        "stretch_ratio": round(natural_dur / max(orig_dur, 1e-3), 3),
                    })

                elif strategy == "smart_fit":
                    # Smart Fit: apply the planner's audio_rate via the same
                    # pitch-preserving atempo pipe strict_slot uses, place the
                    # result at the planned new_start, and hard-trim whatever
                    # the caps couldn't absorb. The video side (video_ratio per
                    # chunk) is persisted below for the export pipeline.
                    sf = fit_plan.segments[i]
                    place_at = sf.new_start
                    if sf.audio_rate > 1.0 + 1e-6 and wl > 0:
                        target = max(1, int(round(wl / sf.audio_rate)))
                        try:
                            adjusted = await _pitch_preserving_stretch(
                                adjusted, target, sr,
                            )
                        except Exception as e:
                            logger.warning(
                                "atempo stretch failed for seg %d (%.2f×), "
                                "falling back to linear interp: %s",
                                i, sf.audio_rate, e,
                            )
                            adjusted = torch.nn.functional.interpolate(
                                adjusted.unsqueeze(0),
                                size=target,
                                mode='linear',
                                align_corners=False,
                            ).squeeze(0)
                        wl = adjusted.shape[-1]
                    # Residual overflow → hard-trim to the segment's new video
                    # slot (fade below keeps the cut pop-free).
                    new_slot_samples = int(max(0.0, sf.new_end - sf.new_start) * sr)
                    if new_slot_samples > 0 and wl > new_slot_samples:
                        adjusted = adjusted[..., :new_slot_samples]
                        wl = adjusted.shape[-1]
                    # Truthful per-segment verdict for the UI badge.
                    entry = {"status": sf.status}
                    if sf.audio_rate > 1.0 + 1e-6:
                        entry["audio_rate"] = round(sf.audio_rate, 3)
                    if sf.video_ratio > 1.0 + 1e-6:
                        entry["video_ratio"] = round(sf.video_ratio, 3)
                    if sf.overflow_s > 0:
                        entry["overflow_s"] = round(sf.overflow_s, 3)
                    fit_status.append(entry)
                    # Cue times from the ACTUAL stretched sample positions.
                    fitted_cues.append({
                        "id": sf.seg_id,
                        "start": round(place_at, 4),
                        "end": round(place_at + wl / sr, 4),
                    })

                elif strategy == "concise":
                    # Mode A: never compress. Allow the audio to extend into the
                    # silent gap before the next seg (existing heuristic) plus
                    # any extra `overflow_budget_s`. Beyond that, hard-trim with
                    # a short fade so we never overlap the next speaker.
                    place_at = start
                    effective_end = end
                    if i + 1 < len(all_segment_wavs):
                        next_start = all_segment_wavs[i + 1][0]
                        gap = next_start - end
                        if gap > GAP_OVERFLOW_BUFFER_S:
                            effective_end = end + min(
                                gap - GAP_OVERFLOW_BUFFER_S, GAP_OVERFLOW_MAX_S,
                            )
                    effective_end += overflow_budget_s
                    slot_samples_eff = int(max(0.0, (effective_end - start)) * sr)
                    if slot_samples_eff > 0 and wl > slot_samples_eff:
                        overflow_s = (wl - slot_samples_eff) / sr
                        adjusted = adjusted[..., :slot_samples_eff]
                        wl = adjusted.shape[-1]
                        fit_status.append({
                            "status": "overflows",
                            "overflow_s": round(overflow_s, 3),
                        })
                    else:
                        fit_status.append({"status": "fits"})

                else:
                    # strict_slot (legacy): preserve the previous atempo / trim /
                    # off semantics so existing callers and back-compat tests
                    # keep passing.
                    place_at = start
                    effective_end = end
                    if i + 1 < len(all_segment_wavs):
                        next_start = all_segment_wavs[i + 1][0]
                        gap = next_start - end
                        if gap > GAP_OVERFLOW_BUFFER_S:
                            effective_end = end + min(
                                gap - GAP_OVERFLOW_BUFFER_S, GAP_OVERFLOW_MAX_S,
                            )
                    slot_samples = int(max(0.0, (effective_end - start)) * sr)
                    if slot_fit != "off" and slot_samples > 0 and wl > slot_samples:
                        if slot_fit == "time_stretch":
                            ratio = wl / slot_samples
                            capped_ratio = min(ratio, MAX_STRETCH_RATIO)
                            capped_target = int(wl / capped_ratio)
                            try:
                                adjusted = await _pitch_preserving_stretch(
                                    adjusted, capped_target, sr,
                                )
                                if adjusted.shape[-1] > slot_samples:
                                    adjusted = adjusted[..., :slot_samples]
                                if ratio > MAX_STRETCH_RATIO:
                                    logger.info(
                                        "seg %d compression %.2f× exceeded cap; "
                                        "stretched to %.2f×, tail trimmed",
                                        i, ratio, capped_ratio,
                                    )
                            except Exception as e:
                                logger.warning(
                                    "atempo stretch failed for seg %d (%.2f×), "
                                    "falling back to linear interp: %s",
                                    i, ratio, e,
                                )
                                adjusted = torch.nn.functional.interpolate(
                                    adjusted.unsqueeze(0),
                                    size=slot_samples,
                                    mode='linear',
                                    align_corners=False,
                                ).squeeze(0)
                        else:  # "trim"
                            adjusted = adjusted[..., :slot_samples]
                        wl = adjusted.shape[-1]
                    fit_status.append({
                        "status": "fits",
                        "compression_applied": (slot_fit == "time_stretch"
                                                and wl != int(natural_dur * sr)),
                    })

                # Common: short fades to avoid pops, then mix into disk-backed audio.
                fade_ms = 15
                fade_samples = int((fade_ms / 1000.0) * sr)
                if wl > fade_samples * 2:
                    ramp_up = torch.linspace(0, 1, fade_samples, device=adjusted.device)
                    ramp_down = torch.linspace(1, 0, fade_samples, device=adjusted.device)
                    adjusted[0, :fade_samples] *= ramp_up
                    adjusted[0, -fade_samples:] *= ramp_down

                s = int(place_at * sr)
                if s < 0:
                    adjusted = adjusted[..., -s:]
                    wl = adjusted.shape[-1]
                    s = 0
                e = min(s + wl, total_samples)
                if s < total_samples and e > s:
                    mix_len = e - s
                    seg_np = (
                        adjusted[:, :mix_len]
                        .detach()
                        .cpu()
                        .to(torch.float32)
                        .clamp(-1.0, 1.0)
                        .squeeze(0)
                        .numpy()
                    )
                    mix_audio[s:e] += seg_np
                try:
                    del wav, adjusted
                except Exception:
                    pass
                _release_audio_tensors()

            _t_save_0 = time.perf_counter()
            mix_audio.flush()
            _write_memmap_wav_atomic(track_path, mix_audio[:mix_samples], sr)
            _t_save = time.perf_counter() - _t_save_0
            _t_mix = _t_save_0 - _t_loop_end
        finally:
            try:
                mix_audio.flush()
                mix_mmap = getattr(mix_audio, "_mmap", None)
                if mix_mmap is not None:
                    mix_mmap.close()
            except Exception:
                pass
            try:
                del mix_audio
            except Exception:
                pass
            gc.collect()
            try:
                os.unlink(mix_path)
            except OSError:
                pass
            # The final track is written; the mix_<id> scratch WAVs (silence /
            # cached-fail / error slots) have served their only purpose as
            # assembly inputs and would otherwise leak into the job dir.
            for _mp in _mix_temp_paths:
                try:
                    os.unlink(_mp)
                except OSError:
                    pass
        # Per-track metadata. For stretch_video, the dub wav is at the new
        # (longer) timeline, so we record its actual duration here too — the
        # mux step needs this to know whether to use the original video as-is
        # or stretch it per the plan.
        track_dur = total_samples / sr if total_samples > 0 else 0.0
        job["dubbed_tracks"][lang_code] = {
            "path": track_path,
            "language": req.language,
            "language_code": lang_code,
            "duration": round(track_dur, 4),
            "timing_strategy": strategy,
        }

        # Persist the timing strategy + (for Mode B) the per-segment stretch
        # plan so dub_export can build the matching video pipeline at mux
        # time. Plans are keyed by language code because each language gets
        # its own dub track with its own natural-rate audio layout.
        job["language"] = req.language
        job["language_code"] = lang_code
        job["timing_strategy"] = strategy
        # Keep job segments in lock-step with what was just rendered so
        # subtitle export / burn-in use the translated text (#309).
        _sync_job_segments(job, req)
        if strategy == "stretch_video":
            stretch_plans = job.setdefault("video_stretch_plans", {})
            stretch_plans[lang_code] = {
                "plan": video_stretch_plan,
                "total_duration": round(track_dur, 4),
                "orig_duration": round(orig_total_dur, 4),
            }
        elif strategy == "smart_fit" and fit_plan is not None:
            # video_stretch_plans stays untouched — smart_fit persists its
            # own keyspace so a job can carry both without clobbering.
            _fit_params_payload = {
                "timing_strategy": strategy,
                "max_audio_only_rate": fit_params.max_audio_only_rate,
                "audio_rate_cap": fit_params.audio_rate_cap,
                "video_slow_cap": fit_params.video_slow_cap,
                "gap_guard_s": fit_params.gap_guard_s,
                "allow_video_retime": fit_params.allow_video_retime,
            }
            fit_fp = fit_fingerprint(_fit_params_payload)
            job.setdefault("fit_plans", {})[lang_code] = {
                # Same dict shape _build_video_stretch_filter_graph consumes.
                "plan": fit_plan.video_plan,
                # Cue times from actual stretched sample positions — for
                # subtitle export on the fitted timeline.
                "fitted_segments": fitted_cues,
                "total_duration": round(track_dur, 4),
                "orig_duration": round(orig_total_dur, 4),
                "params": _fit_params_payload,
                "fit_fp": fit_fp,
            }
            job["dubbed_tracks"][lang_code]["fit_fp"] = fit_fp
        # Record what kind of per-segment WAVs are on disk so a later
        # smart_fit run knows whether partial regen / fit-only re-mix can
        # reuse them ("natural") or must regen once ("slotted"). Per-track
        # (P1.3) — each language renders under its own strategy; the flat
        # field stays in lock-step for older readers.
        _kind = "slotted" if strategy == "strict_slot" else "natural"
        job.setdefault("seg_wav_kind_by_lang", {})[lang_code] = _kind
        job["seg_wav_kind"] = _kind
        _save_job(job_id, job)

        _t_total = time.perf_counter() - _t_start
        logger.info(
            "bench[generate] total=%.2fs tts=%.2fs cache=%.2fs diskw=%.2fs mix=%.2fs save=%.2fs segs=%d%s",
            _t_total, _t_tts, _t_cache, _t_diskw, _t_mix, _t_save, total,
            f" regen={len(regen_only)}" if regen_only is not None else "",
        )

        yield f"data: {json.dumps({'type': 'done', 'segments_processed': total, 'language_code': lang_code, 'tracks': list(job['dubbed_tracks'].keys()), 'sync_scores': sync_scores, 'fit_status': fit_status, 'timing_strategy': strategy, 'seg_hashes': job.get('seg_hashes', {}), 'seg_num_step': job.get('seg_num_step', {})})}\n\n"

    task_id = f"dub_{job_id}_{int(time.time())}"
    await task_manager.add_task(task_id, "dub_generate", _stream, task_id)
    return {"task_id": task_id}


# ── Real-time segment preview ──────────────────────────────────────────
# Stream TTS for a single segment without the full pipeline overhead.
# The frontend calls this when the user edits a segment's text/instruct
# and wants to hear the result immediately.

from pydantic import BaseModel
from typing import Optional
from fastapi.responses import Response
import io


class SegmentPreviewRequest(BaseModel):
    text: str
    language: str = "Auto"
    instruct: Optional[str] = None
    profile_id: Optional[str] = None
    speed: float = 1.0
    duration: Optional[float] = None


@router.post("/dub/preview-segment/{job_id}")
async def preview_segment(job_id: str, req: SegmentPreviewRequest):
    """Generate TTS for a single segment and return WAV bytes.

    This is the fast path for interactive editing — 8 diffusion steps,
    no disk write, no watermark, no mix. Just raw audio preview.
    """
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # See the /dub/generate/{job_id} resolution above (issue #312 class) —
    # a segment preview resolves ref_audio from the same auto-clone /
    # voice-profile sources, so it needs the same cloning-capable gate.
    try:
        backend = await resolve_generation_backend(require_cloning=True)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    def _gen():
        ref_audio = None
        ref_text = None

        # Resolve profile / auto-clone
        pid = req.profile_id
        if pid and pid.startswith("auto:"):
            key = pid[len("auto:"):]
            clones = job.get("speaker_clones") or {}
            for spk, info in clones.items():
                if spk.lower().replace(" ", "_") == key or spk == key:
                    ref_audio = info.get("ref_audio")
                    ref_text = info.get("ref_text")
                    break
            pid = None

        instruct_str = req.instruct
        if pid:
            with db_conn() as conn:
                row = conn.execute(
                    "SELECT * FROM voice_profiles WHERE id=?", (pid,)
                ).fetchone()
            if row:
                if row["is_locked"] and row["locked_audio_path"]:
                    ref_audio = os.path.join(VOICES_DIR, row["locked_audio_path"])
                    ref_text = row["ref_text"]
                elif row["ref_audio_path"]:
                    ref_audio = os.path.join(VOICES_DIR, row["ref_audio_path"])
                    ref_text = row["ref_text"]
                if not instruct_str and row["instruct"]:
                    instruct_str = row["instruct"]

        lang = req.language if req.language != "Auto" else None
        # Same normalization as the full dub render above, so a preview
        # sounds exactly like the final segment. Pref-gated, never raises.
        from services.text_normalization import normalize_for_tts
        audio_out = backend.generate(
            text=normalize_for_tts(req.text, lang),
            language=lang,
            ref_audio=ref_audio,
            ref_text=ref_text,
            instruct=instruct_str if instruct_str else None,
            duration=req.duration,
            num_step=8,  # fast preview
            guidance_scale=2.0,
            speed=req.speed,
            denoise=True,
            postprocess_output=True,
        )
        if not getattr(backend, "applies_own_mastering", False):
            audio_out = apply_mastering(audio_out, sample_rate=backend.sample_rate)
        return normalize_audio(audio_out, target_dBFS=-2.0)

    # Bounded + pool-reset on hang so a wedged preview generate can't starve the
    # GPU pool and brick the backend (#730 class).
    audio_tensor = await run_on_gpu_pool_guarded(_gen, what="Dub preview generate")

    sr = backend.sample_rate
    buf = io.BytesIO()
    _safe_torchaudio_save(buf, audio_tensor, sr, format="wav")
    buf.seek(0)

    return Response(
        content=buf.read(),
        media_type="audio/wav",
        headers={
            "X-Audio-Duration": str(round(audio_tensor.shape[-1] / sr, 2)),
        },
    )

