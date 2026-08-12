"""Voice-gallery archetype API.

Serves the catalog of *designed* voice archetypes from ``core.archetypes`` and
renders previews / materializes them into voice profiles on demand.

Design notes
============
* All heavy imports (the TTS model, torch) are deferred into the render
  functions so this module imports cleanly in test/CI environments without
  model weights. The pure endpoints (categories / list / get) and the preview
  *cache-hit* path never touch the model.
* Rendering reuses generation.py's proven ``_run_inference`` / ``get_model`` /
  ``_safe_torchaudio_save`` rather than re-deriving the ``model.generate``
  signature — one inference code path, one place to keep correct.
* Previews are cached on disk keyed by a hash of (instruct, language), so two
  archetypes that resolve to the same voice share a cache file and the cold
  render only happens once per distinct voice.
* That same key names the pre-rendered clips in the opt-in voice gallery
  (``services.gallery``), which is consulted BEFORE the engine so a fresh
  install can hear voices before the 2.4 GB checkpoint finishes downloading.
  Gallery files win over a local render of the same key — but only for
  ``/preview``. ``/use`` always renders locally: the WAV it keeps in
  ``VOICES_DIR`` is the reference audio a cloned voice is built from, and a
  downloaded MP3 must never become that.
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse

from core import archetypes
from core.config import OUTPUTS_DIR, VOICES_DIR
from services import gallery

logger = logging.getLogger("omnivoice.archetypes")

router = APIRouter()

_PREVIEW_DIR = Path(OUTPUTS_DIR) / "archetype_previews"
# Seed fixed so repeated renders of the same archetype are reproducible
# (mirrors scripts/render_demos_omnivoice.py).
_PREVIEW_SEED = 42
# Diffusion steps for previews. 16 under-converges: certain (script, seed)
# points — notably the "social" sample script at seed 42 — collapse to a
# degenerate tonal buzz (The Hype Host / Podcaster / Vlogger, issue follow-up).
# 32 reliably converges to speech across the gallery's instruct/script space
# at a one-time (cached) render cost.
_PREVIEW_NUM_STEP = 32
# Spectral-flatness floor below which a render is a degenerate tonal artifact
# rather than speech. Real, mastered speech sits ~0.04–0.07; a tonal buzz
# collapses to <0.005. 0.015 separates the two with wide margin and sits well
# below even breathy/whisper voices (which are broadband → high flatness).
_DEGENERATE_FLATNESS = 0.015


def _preview_key(a: dict) -> str:
    # Deterministic cache key, not a security digest. SHA-256 (not SHA-1) so the
    # SAST scanners don't flag it as a weak hash.
    return hashlib.sha256(
        f"{a['instruct']}|{a['language']}".encode("utf-8")
    ).hexdigest()[:16]


# A non-empty script is always required — synthesizing empty text yields
# silence. Every archetype carries a use-case script, but guard the render path
# too so a malformed archetype can never drive a blank render.
_FALLBACK_SCRIPT = "Here's a quick sample of this voice so you can hear how it sounds."


def _is_blank_audio(audio_tensor) -> bool:
    """True if a render came back effectively silent / empty / non-finite.

    After ``normalize_audio``'s silence-floor guard a dead render stays at the
    noise floor instead of being amplified to hiss, so a near-zero peak is a
    reliable "no audible speech" signal. A real, normalized clip peaks near
    -2 dBFS (~0.79), so the 0.02 threshold has a wide margin and won't flag
    legitimately quiet (e.g. whisper) voices.
    """
    try:
        import torch

        t = audio_tensor if isinstance(audio_tensor, torch.Tensor) else torch.as_tensor(audio_tensor)
        if t.numel() == 0:
            return True
        t = t.detach().to("cpu", dtype=torch.float32)
        if not torch.isfinite(t).all():
            return True
        return t.abs().max().item() < 0.02
    except Exception:  # never let the checker itself block a render
        return False


def _spectral_flatness(audio_tensor) -> Optional[float]:
    """Geometric-mean / arithmetic-mean of the power spectrum.

    ~1.0 for broadband noise, →0 for a pure tone. The degenerate diffusion
    renders this guards against are near-pure tonal buzzes (flatness <0.005),
    distinct from both silence (caught by ``_is_blank_audio``) and real speech
    (~0.04+). Returns ``None`` if it can't be computed so callers don't act on
    a bad measurement.
    """
    try:
        import torch

        t = audio_tensor if isinstance(audio_tensor, torch.Tensor) else torch.as_tensor(audio_tensor)
        t = t.detach().to("cpu", dtype=torch.float32).flatten()
        if t.numel() < 1024 or not torch.isfinite(t).all():
            return None
        spec = torch.fft.rfft(t * torch.hann_window(t.numel())).abs().pow(2) + 1e-12
        return float(torch.exp(torch.mean(torch.log(spec))) / torch.mean(spec))
    except Exception:  # never let the checker itself block a render
        return None


def _is_unusable_audio(audio_tensor) -> bool:
    """True if a render is silent/non-finite OR a degenerate tonal buzz.

    The blank guard alone misses the tonal-collapse failure mode: a buzz is
    *loud* (peaks near -2 dBFS after normalize), so it sails past the silence
    floor and — without this — gets cached and served as the preview.
    """
    if _is_blank_audio(audio_tensor):
        return True
    flatness = _spectral_flatness(audio_tensor)
    return flatness is not None and flatness < _DEGENERATE_FLATNESS


async def _render_archetype_wav(a: dict, out_path: Path) -> None:
    """Render an archetype's sample script to ``out_path`` using the live engine.

    Reuses generation.py's inference primitives so there is exactly one TTS code
    path. Heavy deps are imported here, never at module load. If the engine
    returns a blank/silent clip we retry once with a different seed, then fail
    loudly — a blank preview or voice profile must never be cached or saved.
    """
    from api.routers.generation import (  # noqa: WPS433 — intentional lazy import
        get_model,
        _run_inference,
        run_on_gpu_pool_guarded,
        _safe_torchaudio_save,
    )

    model = await get_model()
    language = a["language"]
    if language in (None, "", "Auto"):
        language = None
    text = (a.get("sample_script") or "").strip() or _FALLBACK_SCRIPT

    def _infer(seed: int):
        return _run_inference(
            model,          # _model
            text,           # text
            language,       # language
            None,           # ref_audio_path (design mode — no reference)
            None,           # ref_text
            a["instruct"],  # instruct
            None,           # duration
            _PREVIEW_NUM_STEP,  # num_step
            2.0,            # guidance_scale
            1.0,            # speed
            None,           # t_shift
            True,           # denoise
            True,           # postprocess_output
            None,           # layer_penalty_factor
            None,           # position_temperature
            None,           # class_temperature
            seed,           # seed
            "broadcast",    # effect_preset
        )

    # Bounded + pool-reset on hang so a wedged preview render can't starve the
    # GPU pool and brick the backend (#730 class). Budget comes from the shared
    # length-scaled helper (#1190) instead of the flat 300s default.
    from services.model_manager import generate_timeout_s
    _budget = generate_timeout_s(text)
    audio_tensor = await run_on_gpu_pool_guarded(
        lambda: _infer(_PREVIEW_SEED), what="Archetype preview generate",
        timeout=_budget)
    if _is_unusable_audio(audio_tensor):
        # Blank OR a degenerate tonal buzz — retry once on a different seed to
        # step off the bad diffusion trajectory. Static message only: the
        # archetype id is request-derived (CodeQL log-injection); the seed is a
        # module constant, safe to log.
        logger.warning("Archetype rendered unusable at seed %d — retrying once", _PREVIEW_SEED)
        audio_tensor = await run_on_gpu_pool_guarded(
            lambda: _infer(_PREVIEW_SEED + 1), what="Archetype preview generate",
            timeout=_budget)
    if _is_unusable_audio(audio_tensor):
        raise RuntimeError("the voice engine returned no audible audio for this archetype")

    # Invisible provenance mark (#1169), tensor stage, before the WAV is
    # persisted: this one site covers BOTH archetype outputs — the served
    # preview clip (GET /archetypes/{id}/preview) and the synthetic reference
    # WAV a materialized profile keeps in VOICES_DIR (played back via the
    # profile preview route). Runs in the GPU pool like generate's finalize;
    # never raises (degrades to unmarked on failure). User-uploaded/recorded
    # reference audio is human speech and is never marked — this only touches
    # audio the engine synthesized.
    # Runs on the dedicated watermark pool (#1190): AudioSeal embedding is CPU
    # work that holds no VRAM, so it must not occupy a GPU worker ahead of the
    # next generate on 1-worker hosts.
    from services.watermark import mark_synthetic
    from services.model_manager import get_watermark_pool
    import functools
    audio_tensor = await run_on_gpu_pool_guarded(
        functools.partial(mark_synthetic, audio_tensor, model.sampling_rate,
                          context="archetypes.render"),
        what="Archetype watermark",
        timeout=generate_timeout_s(""),
        executor=get_watermark_pool(),
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    _safe_torchaudio_save(str(out_path), audio_tensor, model.sampling_rate)


def _no_voice_model_downloaded() -> bool:
    """True only on a *positive* "no TTS weights on this machine" answer.

    Fails open on purpose: the cache probes are best-effort (a user-managed
    clone outside the HF layout is invisible to them), and telling someone with
    a working engine to go download a model is worse than saying nothing. Only
    a catalog we could read, with not one TTS repo cached, earns the offline
    message.
    """
    try:
        from api.routers.setup.models import get_model_catalog, is_cached

        tts = [m for m in get_model_catalog().all if m.get("role") == "TTS"]
        return bool(tts) and not any(is_cached(m["repo_id"]) for m in tts)
    except Exception:
        return False


def _preview_source(a: dict) -> tuple[str, str]:
    """Which path ``/preview`` will take for *a*, and what to tell the user.

    Replaces the old "see Settings → Logs → Backend" advice, which asked a user
    who wanted to hear a voice to go read a log file. The three states that
    actually differ are: we already have the audio (gallery), we can make it
    (render — say so, it takes a moment), and we can neither fetch nor make it
    (no model — the one state with an action attached).
    """
    key = _preview_key(a)
    if gallery.cached_preview(key) is not None:
        return "gallery", (
            "Pre-rendered preview from the voice gallery — a fixed reference "
            "rendering, not a render from your current engine."
        )
    if (_PREVIEW_DIR / f"{key}.wav").exists():
        return "cached", ""
    if _no_voice_model_downloaded():
        return "no_model", (
            "You're offline and no voice model is downloaded yet — "
            "Model Catalogue → Models → Download."
        )
    return "rendering", "Rendering this preview on your machine — it may take a moment."


# ── Read endpoints (no model) ─────────────────────────────────────────────────
# NOTE: declare the literal `/archetypes/categories` before `/archetypes/{id}`
# so it isn't swallowed by the path-parameter route.
@router.get("/archetypes/categories")
def list_categories():
    """The seven use-case categories the gallery is organized by."""
    return archetypes.categories()


# ── Voice-gallery (pre-rendered previews) ─────────────────────────────────────
# Declared above `/archetypes/{archetype_id}` for the same reason as
# `/categories`: keep literal paths out of the path-parameter route's reach.
@router.get("/archetypes/previews/status")
def preview_gallery_status():
    """Consent state, coverage and freshness for the Settings line."""
    return gallery.status()


@router.put("/archetypes/previews")
async def set_preview_gallery(enabled: bool = Body(..., embed=True)):
    """Turn pre-rendered previews on or off.

    Turning it ON is the user's explicit yes to an outbound call, and is the
    only thing that ever starts one — there is no on-install background fetch.
    The featured set is pulled right here so the yes has a visible effect;
    failures are silent by design (``fetch_featured`` swallows them) and leave
    previews rendering locally.
    """
    state = gallery.set_enabled(enabled)
    if enabled:
        state = await gallery.fetch_featured()
    return state


@router.post("/archetypes/previews/check")
async def check_preview_gallery():
    """Manual "check now" — bypasses the 24 h throttle, never the signature."""
    return await gallery.check_for_updates(force=True)


@router.get("/archetypes")
def list_archetypes_endpoint(
    q: Optional[str] = None,
    use_case: Optional[str] = None,
    gender: Optional[str] = None,
    age: Optional[str] = None,
    pitch: Optional[str] = None,
    accent: Optional[str] = None,
    whisper: Optional[bool] = None,
    lang: Optional[str] = None,
    featured: Optional[bool] = None,
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Filtered, paginated view over the archetype catalog.

    ``q`` is a free-text substring match over the archetype name/instruct so a
    voice picker can search the *entire* several-hundred-voice catalog by typing
    (the facet filters alone can't reach a specific voice by name). Content-free
    and local — it just narrows the in-memory catalog.
    """
    items = archetypes.list_archetypes(
        q=q, use_case=use_case, gender=gender, age=age, pitch=pitch,
        accent=accent, whisper=whisper, lang=lang, featured=featured,
    )
    total = len(items)
    page = items[offset:offset + limit]
    return {"total": total, "limit": limit, "offset": offset, "items": page}


@router.get("/archetypes/{archetype_id}")
def get_archetype_endpoint(archetype_id: str):
    a = archetypes.get_archetype(archetype_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Archetype not found")
    return a


# ── Render endpoints (model-gated) ────────────────────────────────────────────
@router.get("/archetypes/{archetype_id}/preview/state")
def preview_archetype_state(archetype_id: str):
    """Where the next ``/preview`` for this archetype would come from.

    Touches neither the model nor the network, so a picker can label a voice
    ("may take a moment", "download a model first") *before* it commits to a
    request that may take 40 seconds or fail.
    """
    a = archetypes.get_archetype(archetype_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Archetype not found")
    source, message = _preview_source(a)
    return {"source": source, "message": message}


@router.get("/archetypes/{archetype_id}/preview")
async def preview_archetype(
    archetype_id: str,
    local: bool = Query(False, description="Bypass gallery audio after a client decode failure"),
):
    """Serve a short preview clip — from the gallery, the cache, or the engine."""
    a = archetypes.get_archetype(archetype_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Archetype not found")

    key = _preview_key(a)
    # Gallery first, and only for /preview: these bytes are audio we can prove
    # the provenance of, so they beat a local render of the same key. A miss
    # (offline, disabled, key not published) is silent — we just render.
    gallery_path = None if local else gallery.cached_preview(key)
    if gallery_path is None and not local:
        gallery_path = await gallery.fetch_preview(key)
    if gallery_path is not None:
        # Nothing else in the app polls, so the daily refresh hangs off the
        # request that proves previews are being used. Fire-and-forget.
        gallery.maybe_refresh_in_background()
        return FileResponse(
            str(gallery_path),
            media_type="audio/mpeg",
            headers={"Cache-Control": "no-cache",
                     "X-OmniVoice-Preview-Source": "gallery"},
        )

    cache_path = _PREVIEW_DIR / f"{key}.wav"
    if not cache_path.exists():
        try:
            await _render_archetype_wav(a, cache_path)
        except Exception as e:  # model missing / OOM / inference failure
            logger.error("Archetype preview render failed", exc_info=True)
            # Two different failures, two different answers. Without a model
            # there is nothing to read in a log — there is something to do.
            if _no_voice_model_downloaded():
                detail = (
                    "You're offline and no voice model is downloaded yet — "
                    "Model Catalogue → Models → Download. (Or turn on pre-rendered "
                    "voice previews in Model Catalogue → Models.)"
                )
            else:
                detail = (
                    "Couldn't render a preview right now — the voice engine "
                    f"reported: {e}"
                )
            raise HTTPException(status_code=503, detail=detail)
    # no-cache (not no-store): the URL is stable but its bytes change when an
    # archetype's preview is re-rendered, so force the client to revalidate
    # against the ETag instead of serving a stale cached clip indefinitely.
    return FileResponse(
        str(cache_path),
        media_type="audio/wav",
        headers={"Cache-Control": "no-cache",
                 "X-OmniVoice-Preview-Source": "local"},
    )


@router.post("/archetypes/{archetype_id}/use")
async def use_archetype(archetype_id: str, name: Optional[str] = Query(None)):
    """Materialize an archetype into a reusable voice profile.

    Renders a reference sample (so the voice has a concrete identity and a
    preview) and inserts a ``voice_profiles`` row carrying the archetype's
    instruct + language. The profile then shows up everywhere voices are
    picked (Dub / Generate / Clone).

    Never sourced from the voice gallery, no matter how cheap that would be:
    this WAV lands in ``VOICES_DIR`` as the profile's reference audio, so a
    downloaded, lossily-encoded MP3 would silently become the sample every
    future clone of this voice is built from. It renders locally or it fails.
    """
    a = archetypes.get_archetype(archetype_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Archetype not found")

    from core import event_bus
    from core.db import db_conn

    # Idempotent (dedup): an archetype materializes to exactly ONE voice profile.
    # Picking the same gallery voice again — from any picker (Gallery grid,
    # VoiceSelector, …) — must reuse that one row instead of rendering + inserting
    # a fresh duplicate every time. The `personality` column already carries the
    # source archetype id (stamped by the INSERT below), so it's the natural
    # dedup key; the expensive render + INSERT only run on first use.
    with db_conn() as conn:
        existing = conn.execute(
            "SELECT id, name FROM voice_profiles WHERE personality = ? LIMIT 1",
            (a["id"],),
        ).fetchone()
    if existing is not None:
        return {"profile_id": existing["id"], "name": existing["name"]}

    profile_id = str(uuid.uuid4())[:8]
    audio_filename = f"{profile_id}.wav"
    audio_path = Path(VOICES_DIR) / audio_filename

    try:
        await _render_archetype_wav(a, audio_path)
    except Exception as e:
        logger.error("Archetype 'use' render failed", exc_info=True)
        # Same actionable/diagnostic split as /preview — minus the gallery
        # suggestion, which cannot help here.
        if _no_voice_model_downloaded():
            detail = (
                "Creating a voice needs the voice model — no voice model is "
                "downloaded yet. Model Catalogue → Models → Download."
            )
        else:
            detail = (
                "Couldn't create a voice from this archetype — the voice engine "
                f"reported: {e}"
            )
        raise HTTPException(status_code=503, detail=detail)

    profile_name = (name or a["name"]).strip() or a["name"]
    try:
        with db_conn() as conn:
            # Re-check under the write connection right before inserting: a
            # concurrent /use for the same archetype may have inserted while we
            # were rendering (the pre-render SELECT above raced). Reuse that row
            # and drop our just-rendered sample instead of creating a duplicate.
            # (personality is NOT globally unique — marketplace/persona imports
            # reuse the column — so a UNIQUE index isn't an option; this closes
            # the realistic window for the single-user desktop app.)
            dup = conn.execute(
                "SELECT id, name FROM voice_profiles WHERE personality = ? LIMIT 1",
                (a["id"],),
            ).fetchone()
            if dup is not None:
                with __import__("contextlib").suppress(OSError):
                    os.remove(audio_path)
                return {"profile_id": dup["id"], "name": dup["name"]}
            conn.execute(
                "INSERT INTO voice_profiles "
                "(id, name, ref_audio_path, ref_text, instruct, language, seed, personality, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    profile_id, profile_name, audio_filename, a["sample_script"],
                    a["instruct"], a["language"], _PREVIEW_SEED, a["id"], time.time(),
                ),
            )
    except Exception:
        with __import__("contextlib").suppress(OSError):
            os.remove(audio_path)
        raise

    event_bus.emit("profiles", {"action": "created", "id": profile_id})
    return {"profile_id": profile_id, "name": profile_name}
