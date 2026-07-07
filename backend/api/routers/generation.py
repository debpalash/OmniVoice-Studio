import os
import io
import re
import uuid
import time
import random
import asyncio
import tempfile
import contextlib
import logging
import traceback
from typing import Optional
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import StreamingResponse

import sqlite3
from core.db import db_conn, ensure_schema
from core.config import OUTPUTS_DIR, VOICES_DIR
import functools
from services.model_manager import (
    get_model, _gpu_pool, run_on_gpu_pool_guarded, GpuJobTimeoutError,
)
from services.audio_io import _safe_torchaudio_save
from core import event_bus
from omnivoice.utils.voice_design import heal_design_instruct

router = APIRouter()
logger = logging.getLogger("omnivoice.generate")


def _profile_instruct(row):
    """Validator-safe instruct for a stored profile row.

    Sanitizes the persisted instruct (dropping the ``"[object Object]"``
    sentinel / freeform prose that older builds saved) and, for a design row,
    rebuilds the tags from ``vd_states`` when the stored value is unusable — so
    a poisoned/legacy profile never 400-s generation (#550 #571 #594 #596).
    """
    try:
        vd = row["vd_states"]
    except (KeyError, IndexError):
        vd = None
    return heal_design_instruct(row["instruct"], vd)


def _render_with_pauses(gen_span, segments, sample_rate):
    """Synthesize ``[(text, pause_ms), ...]`` spans and stitch silence between
    them (issue #276).

    ``gen_span(text) -> torch.Tensor`` synthesizes one text span (raw model
    output). A silence buffer of ``pause_ms`` is inserted after a span when
    requested, matching the audio tensor's channel dims / dtype / device.
    Returns the concatenated waveform. Kept model-free (``gen_span`` is injected)
    so the stitching is unit-testable without loading the TTS model.
    """
    import torch

    items = []  # ('a', tensor) for audio, ('s', n_samples) for silence
    for span_text, pause_ms in segments:
        if span_text and span_text.strip():
            items.append(("a", gen_span(span_text)))
        if pause_ms > 0:
            n = int(round(sample_rate * pause_ms / 1000.0))
            if n > 0:
                items.append(("s", n))

    ref = next((t for kind, t in items if kind == "a"), None)
    if ref is None:
        # No speakable text (e.g. the input was only pause markers) — emit the
        # requested silence so the caller still gets a valid clip.
        total = sum(n for kind, n in items if kind == "s") or 1
        return torch.zeros(total, dtype=torch.float32)

    parts = []
    for kind, val in items:
        if kind == "a":
            parts.append(val)
        else:
            shape = list(ref.shape)
            shape[-1] = val
            parts.append(torch.zeros(*shape, dtype=ref.dtype, device=ref.device))
    return torch.cat(parts, dim=-1)


def _sanitize_audio(audio_out):
    """Replace non-finite samples (NaN / ±inf) with silence so a model glitch
    can't produce an unreadable WAV (#629). Returns the input unchanged when it's
    already finite or isn't a tensor. Never raises."""
    try:
        import torch
        if torch.is_tensor(audio_out) and not bool(torch.isfinite(audio_out).all()):
            logger.warning(
                "Generated audio contained non-finite samples (NaN/inf) — "
                "sanitizing to silence to keep the WAV decodable (#629)."
            )
            return torch.nan_to_num(audio_out, nan=0.0, posinf=0.0, neginf=0.0)
    except Exception:
        pass
    return audio_out


def _apply_effect_chain(audio_out, sample_rate, effect_preset, *, skip_mastering=False):
    """Shared post-DSP for /generate: preset validation → mastering →
    effect chain → loudness normalization.

    ``skip_mastering`` honors a backend's ``applies_own_mastering`` flag
    (issue #312): studio engines (e.g. VoxCPM2's native 48 kHz output)
    opt out of the broadcast highpass + Compressor pre-stage that's tuned
    for OmniVoice's 24 kHz clone output. Loudness normalization still runs —
    it's a benign peak scale. Mirrors ``_run_tts`` in openai_compat.py.
    """
    from services.audio_dsp import (
        EFFECT_PRESETS, apply_mastering, normalize_audio,
        apply_effects_chain, get_effect_chain,
    )

    # #629: a numerical glitch in the model (observed on MPS) can leave NaN/±inf
    # samples, which write an unreadable WAV that then fails decoding with an
    # opaque "ffmpeg returned error code: 183 / Invalid data" — surfaced to the
    # user as a misleading "ran out of memory". Replace non-finite samples with
    # silence here, before any DSP/encode touches the audio, so the output is
    # always a valid WAV. Covers the raw path too (it returns just below).
    audio_out = _sanitize_audio(audio_out)

    preset = effect_preset or "broadcast"
    if preset not in EFFECT_PRESETS:
        raise ValueError(
            f"Unknown effect preset: {preset!r}. "
            f"Valid: {list(EFFECT_PRESETS.keys())}"
        )

    if preset == "raw":
        # Raw: skip all DSP — return raw model output
        return audio_out

    if not skip_mastering:
        audio_out = apply_mastering(audio_out, sample_rate=sample_rate)
    chain = get_effect_chain(preset)
    if chain:
        audio_out = apply_effects_chain(
            audio_out, sample_rate=sample_rate, chain=chain,
        )
    return normalize_audio(audio_out, target_dBFS=-2.0)


def _safe_exc_text(e: BaseException) -> str:
    """``f"{type(e).__name__}: {e}"`` — the house style used for
    unrecognized-error formatting throughout the backend (grep
    ``type(e).__name__`` in settings.py / asr_backend.py / model_manager.py
    / engines.py) — with a guard against leaking a raw container repr.

    #977: an AssertionError raised deep inside a vendored dependency
    (mlx-audio's Kokoro pipeline) had ``.args`` shaped like
    ``('du', {'a': 'American English', ...})`` — a tuple containing a dict.
    ``str(e)`` on that renders the WHOLE table straight into the user-facing
    message. Any engine's ``generate()`` can raise something shaped like
    this (not just Kokoro), so guard generically: if any element of
    ``e.args`` is a container rather than a plain string, don't interpolate
    ``str(e)`` at all — name the exception type and point at the log
    instead.
    """
    args = getattr(e, "args", ())
    if any(isinstance(a, (dict, list, tuple, set, frozenset)) for a in args):
        return f"{type(e).__name__} — see Settings → Logs → Backend for details"
    return f"{type(e).__name__}: {e}"


def _exception_chain(e):
    """Yield ``e`` plus every ``__cause__``/``__context__`` beneath it
    (cycle-safe). Engines and hub libraries routinely wrap the original
    transport/allocator error, so classification must look at the whole
    chain, not just the outermost message."""
    seen = set()
    stack = [e]
    while stack:
        exc = stack.pop()
        if exc is None or id(exc) in seen:
            continue
        seen.add(id(exc))
        yield exc
        stack.append(exc.__cause__)
        stack.append(exc.__context__)


# #880: transport-level exception type names from httpx (huggingface_hub ≥1.x
# downloads over it) and requests/urllib3 (older engine deps). Any of these
# anywhere in the exception chain means the network — not memory — killed the
# generation.
_NETWORK_EXC_NAMES = frozenset({
    # httpx
    "ConnectError", "ConnectTimeout", "ReadTimeout", "ReadError",
    "WriteError", "WriteTimeout", "PoolTimeout", "NetworkError",
    "TransportError", "RemoteProtocolError", "ProxyError", "CloseError",
    # requests / urllib3
    "ConnectionError", "ChunkedEncodingError", "MaxRetryError",
    "NewConnectionError", "ProtocolError",
    # stdlib socket-level drops mid-download
    "ConnectionResetError", "ConnectionAbortedError", "ConnectionRefusedError",
    # huggingface_hub: failed first-use download with nothing in the disk cache
    "LocalEntryNotFoundError",
})

# Same class, but the transport error was stringified into a wrapper message
# (so the type name is gone). All lowercase; matched against .lower().
_NETWORK_MSG_SIGNATURES = (
    "client has been closed",    # httpx closed-client lifecycle error (#880)
    "cannot send a request",     # httpx: same error, message head
    "connection error",          # requests / huggingface_hub wording
    "connection reset",          # ECONNRESET mid-download
    "read timed out",            # requests/urllib3 timeout wording
    "max retries exceeded",      # urllib3 retry exhaustion
    "temporary failure in name resolution",  # DNS down (glibc)
    "name or service not known",             # DNS down (glibc)
    "getaddrinfo failed",                    # DNS down (Windows)
)


def _is_network_failure(e) -> bool:
    """True iff the failure (anywhere in its chain) is an HTTP-client
    lifecycle / network-transport error — e.g. a first-use model download
    from the HF Hub dying mid-generation (#880)."""
    for exc in _exception_chain(e):
        if type(exc).__name__ in _NETWORK_EXC_NAMES:
            return True
        low = str(exc).lower()
        if any(sig in low for sig in _NETWORK_MSG_SIGNATURES):
            return True
    return False


# Signatures of an *actual* out-of-memory condition. All lowercase.
_OOM_MSG_SIGNATURES = (
    "out of memory",               # CUDA / MPS / generic torch wording
    "not enough memory",           # torch CPU DefaultCPUAllocator
    "cannot allocate memory",      # OS-level ENOMEM
    "std::bad_alloc",              # C++ allocator failure
    "cublas_status_alloc_failed",  # cuBLAS workspace allocation
    "cuda_error_out_of_memory",    # raw CUDA driver error name
    "paging file is too small",    # Windows [WinError 1455] mapping DLLs
)


def _is_oom_failure(e) -> bool:
    """True iff the failure (anywhere in its chain) actually looks like an
    out-of-memory condition — the only case where the Flush hint is honest."""
    for exc in _exception_chain(e):
        if isinstance(exc, MemoryError):
            return True
        # torch.cuda.OutOfMemoryError subclasses RuntimeError; match by name
        # so this needs no torch import (and covers other frameworks' twins).
        if type(exc).__name__ == "OutOfMemoryError":
            return True
        low = str(exc).lower()
        if any(sig in low for sig in _OOM_MSG_SIGNATURES):
            return True
    return False


# #919: an engine that requires a model path / env var which isn't set (or is
# set to a directory missing its model files) fails with a *configuration*
# error, not a runtime one. The reporting user selected sherpa-onnx and hit
# "OMNIVOICE_SHERPA_MODEL not set. Point it to a sherpa-onnx TTS model
# directory …" — a pure setup problem — yet the OOM catch-all told them (on a
# 63 GB-RAM box) to press Flush for memory they never ran out of. Classify the
# whole CLASS of "engine not configured / required env var not set" errors so
# any current or future opt-in engine (sherpa/Confucius4/dots/MOSS …) surfaces
# actionable setup guidance instead of the memory hint. All lowercase; matched
# over the whole exception chain (engines wrap the original error).
_CONFIG_MSG_SIGNATURES = (
    "not set. point it to",      # sherpa: OMNIVOICE_SHERPA_MODEL not set
    "no model.onnx found in",    # sherpa: dir set but the model file is missing
    "not configured",            # generic "engine not configured" wording
    "venv not found. set",       # confucius4/dots/MOSS dedicated-venv opt-ins
    "unavailable: omnivoice_",   # is_available() reason wrapped by _ensure_loaded
)

# An OMNIVOICE_* engine env var named alongside "not set" / "point it to" /
# "set omnivoice_…" is the strongest config-missing signal and generalizes to
# any engine gated on such a var (issue #919 class).
_CONFIG_ENV_RE = re.compile(r"omnivoice_[a-z0-9_]+")


def _is_config_failure(e) -> bool:
    """True iff the failure is a *configuration* problem — a required engine
    model path / env var that isn't set (or points nowhere) — rather than a
    runtime fault. The remedy is to set the value, never to Flush VRAM."""
    for exc in _exception_chain(e):
        low = str(exc).lower()
        if any(sig in low for sig in _CONFIG_MSG_SIGNATURES):
            return True
        if _CONFIG_ENV_RE.search(low) and (
            "not set" in low or "point it to" in low or "set omnivoice_" in low
        ):
            return True
    return False


def _oom_friendly_reraise(e):
    """Best-effort cache flush + the user-facing OOM hint shared by both
    inference paths."""
    import gc
    import torch
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    elif torch.cuda.is_available():
        torch.cuda.empty_cache()
    # #278: don't mislabel a torch.compile/Triton/Inductor crash as an
    # out-of-memory condition. (model_manager's generate wrapper already
    # retries these eagerly; this only triggers if that retry also died.)
    from services.model_manager import _is_compile_runtime_failure
    if _is_compile_runtime_failure(e):
        raise RuntimeError(
            f"TTS engine hit a torch.compile/Triton error (not out of memory). "
            f"Disable torch.compile in Settings → Performance, use the Flush "
            f"button to reload the model, then regenerate. Underlying error: {e}"
        ) from e
    # #437: a Permission-denied / exec failure (e.g. a bundled engine binary
    # that lost its +x bit) is NOT an OOM — don't send the user to the Flush
    # button; tell them what's actually wrong.
    es = str(e)
    if isinstance(e, PermissionError) or "Permission denied" in es or "Errno 13" in es:
        raise RuntimeError(
            f"A required engine binary couldn't be executed (permission denied). "
            f"This usually means a bundled binary lost its execute bit — reinstall, "
            f"or run `chmod +x` on the engine binary named in the error. "
            f"Underlying error: {e}"
        ) from e
    # #629: a decode/ffmpeg failure on the rendered audio is NOT out of memory —
    # it's unreadable audio (usually a transient numerical glitch). Say so rather
    # than sending the user down the OOM path.
    if "ffmpeg returned error" in es or "Decoding failed" in es or "Invalid data found" in es:
        raise RuntimeError(
            f"The engine produced unreadable audio (a decode step failed) — this is "
            f"usually a transient glitch. Use the Flush button to reload the model, "
            f"then regenerate. Underlying error: {e}"
        ) from e
    # #664: a bad voice-design instruct (free-form prose, mixed EN/ZH, or
    # conflicting tags) raises "Unsupported instruct items …" / "Cannot mix …
    # in a single instruct" / "Conflicting instruct items …" from omnivoice's
    # _resolve_instruct. That's a USER-INPUT validation error, not an OOM. Match
    # on the message signature (NOT the type — a lower layer can wrap the original
    # ValueError, which is why the route's `except ValueError` guard misses it)
    # and re-raise as a clean ValueError so the route returns a 400 with the
    # instruct guidance, instead of a 500 telling the user to Flush for memory
    # they never ran out of. (Complements the client-side guard in #658/#612.)
    _low = es.lower()
    if ("unsupported instruct items" in _low
            or "conflicting instruct items" in _low
            or "in a single instruct" in _low):
        raise ValueError(es) from e
    # #705: a corrupt or wrong-architecture native component (a .dll / .pyd / .exe
    # — torch, ffmpeg, or a bundled engine binary) fails to load/spawn on Windows
    # with "[WinError 193] %1 is not a valid Win32 application". That is NOT OOM,
    # and Flush won't help — reinstalling/repairing the component is the real fix.
    if "[winerror 193]" in _low or "is not a valid win32 application" in _low:
        raise RuntimeError(
            f"A native component (a DLL / .pyd / .exe — e.g. torch, ffmpeg, or an "
            f"engine binary) is corrupt or built for the wrong architecture "
            f"([WinError 193]). Reinstall or repair that component — the Flush "
            f"button won't help here. Underlying error: {e}"
        ) from e
    # #715: a "[Errno 32] Broken pipe" (BrokenPipeError) surfacing from
    # generation is NOT out of memory — it means the backend's stdout/stderr
    # pipe to the desktop shell that launched it closed mid-render (an orphaned
    # backend whose parent shell exited or relaunched). main.py wraps
    # sys.stdout/stderr to swallow EPIPE, but a C-level write inside the native
    # engine/torch can still raise one past that guard. Flush won't help —
    # relaunching the app re-parents the backend to a live shell.
    # #756: the GPU's compute capability isn't in this PyTorch build's arch list,
    # so CUDA can't launch kernels ("no kernel image is available for execution").
    # NOT OOM. get_best_device() now falls back to CPU up front, but classify the
    # raw error too in case CUDA was forced (OMNIVOICE_FORCE_CUDA) or a sub-path
    # still ran on the GPU — point at the real fix, not the Flush button.
    if "no kernel image is available" in _low:
        raise RuntimeError(
            f"Your GPU isn't supported by the installed PyTorch build (CUDA can't "
            f"launch kernels for its compute capability). Switch the compute device "
            f"to CPU in Settings, or install a matching PyTorch (e.g. a cu128 build "
            f"for newer GPUs). The Flush button won't help. Underlying error: {e}"
        ) from e
    if isinstance(e, BrokenPipeError) or "broken pipe" in _low or "errno 32" in _low:
        raise RuntimeError(
            f"The backend lost its output pipe mid-generation — the desktop app "
            f"that launched it closed or relaunched ([Errno 32] Broken pipe). "
            f"Restart the app and try again; the Flush button won't help here. "
            f"Underlying error: {e}"
        ) from e
    # #880: an httpx/requests transport failure surfacing from generation —
    # most commonly a first-use model download from the HF Hub dying with
    # httpx's "Cannot send a request, as the client has been closed" (the
    # shared client got closed mid-lifecycle), a connect/read timeout, or a
    # dropped connection — is NOT out of memory. The model never finished
    # loading, so Flush is the wrong remedy; retrying is. Matched over the
    # whole exception chain (type names + stringified signatures) because
    # engines wrap the original transport error.
    if _is_network_failure(e):
        raise RuntimeError(
            f"A model download or network call failed mid-generation (usually "
            f"the engine fetching its model files on first use). This is a "
            f"network problem, not a memory problem — flushing VRAM won't "
            f"help. Retry the generation; if it keeps failing, check your "
            f"internet connection and any HF_ENDPOINT/mirror setting. "
            f"Underlying error: {e}"
        ) from e
    # #919: a required engine model path / env var that isn't set is a pure
    # CONFIGURATION problem, not a runtime one. sherpa-onnx's
    # "OMNIVOICE_SHERPA_MODEL not set. Point it to …" used to fall through to
    # the OOM catch-all, telling a user with 63 GB of RAM to press Flush. Point
    # at the real fix — set the variable — and never mention memory or Flush.
    # The underlying error already names the exact variable + what to point it
    # at (and Settings → Engines shows a copy-paste setup line), so keep it
    # front-and-center. Checked before the OOM branch so a config error can
    # never be mislabeled as memory.
    if _is_config_failure(e):
        raise RuntimeError(
            f"This TTS engine isn't set up yet — it needs a model path or "
            f"environment variable that isn't configured, so nothing was "
            f"generated. Set it as the underlying error describes (it names the "
            f"exact variable and what to point it at), then restart OmniVoice — "
            f"or pick a ready engine in Settings → Engines. This is a setup "
            f"problem, not a memory one. Underlying error: {e}"
        ) from e
    # #880 (the class bug): the OOM hint used to be the catch-all fallback,
    # so ANY unrecognized error told the user to press Flush for memory they
    # never ran out of. Only claim OOM when something in the chain actually
    # looks like one; everything else surfaces as what it is — unrecognized —
    # with the real error front and center.
    if _is_oom_failure(e):
        raise RuntimeError(
            f"TTS engine stopped mid-generation. This usually means it ran out of memory. "
            f"Try the Flush button to reload the model, then regenerate. Underlying error: {e}"
        ) from e
    raise RuntimeError(
        f"TTS engine stopped mid-generation with an error OmniVoice doesn't "
        f"recognize. Retry once; if it keeps failing, please report it with "
        f"the full trace. Underlying error: {_safe_exc_text(e)}"
    ) from e


def _run_inference(
    model, text, language, ref_audio_path, ref_text, instruct, duration,
    num_step, guidance_scale, speed, t_shift, denoise,
    postprocess_output, layer_penalty_factor, position_temperature,
    class_temperature, used_seed, effect_preset="broadcast",
    max_chunk_chars=None, crossfade_ms=None,
):
    import torch
    try:
        if used_seed is not None:
            torch.manual_seed(used_seed)

        kwargs = {}
        if t_shift is not None: kwargs["t_shift"] = t_shift
        if layer_penalty_factor is not None: kwargs["layer_penalty_factor"] = layer_penalty_factor
        if position_temperature is not None: kwargs["position_temperature"] = position_temperature
        if class_temperature is not None: kwargs["class_temperature"] = class_temperature

        sr = model.sampling_rate if hasattr(model, 'sampling_rate') else 24000

        # Inline [pause Nms] markers (issue #276): split the text and stitch
        # silence between independently-synthesized spans. Fully opt-in — text
        # without a marker takes the unchanged single-shot path below.
        from omnivoice.utils.text import parse_pause_markers
        segments = parse_pause_markers(text)
        has_pause = len(segments) > 1 or (segments and segments[0][1] > 0)

        if has_pause:
            def _gen_span(span_text):
                # Per-span duration is left to the model; an explicit overall
                # `duration` can't be meaningfully split across spans.
                return model.generate(
                    text=span_text, language=language, ref_audio=ref_audio_path,
                    ref_text=ref_text, instruct=instruct, duration=None,
                    num_step=num_step, guidance_scale=guidance_scale, speed=speed,
                    denoise=denoise, postprocess_output=postprocess_output,
                    **kwargs
                )[0]
            audio_out = _render_with_pauses(_gen_span, segments, sr)
        else:
            # Wave 1.2: long text is split at sentence boundaries and the
            # per-chunk audio crossfaded — removes the length ceiling. Short
            # text takes the single-shot path below unchanged. [pause] inputs
            # keep the dedicated stitcher above (spans are already short).
            from services.chunked_tts import (
                DEFAULT_CROSSFADE_MS, DEFAULT_MAX_CHUNK_CHARS,
                concatenate_audio_chunks, split_text_into_chunks,
            )
            _max_chars = DEFAULT_MAX_CHUNK_CHARS if max_chunk_chars is None else max_chunk_chars
            _xfade_ms = DEFAULT_CROSSFADE_MS if crossfade_ms is None else crossfade_ms
            text_chunks = split_text_into_chunks(text, _max_chars)
            if len(text_chunks) > 1:
                parts = []
                for i, chunk_text in enumerate(text_chunks):
                    # Vary the seed per chunk (deterministically) to avoid
                    # correlated RNG artifacts across chunk boundaries.
                    if used_seed is not None:
                        torch.manual_seed(used_seed + i)
                    parts.append(model.generate(
                        text=chunk_text, language=language, ref_audio=ref_audio_path,
                        ref_text=ref_text, instruct=instruct, duration=None,
                        num_step=num_step, guidance_scale=guidance_scale, speed=speed,
                        denoise=denoise, postprocess_output=postprocess_output,
                        **kwargs
                    )[0])
                audio_out = concatenate_audio_chunks(parts, sr, _xfade_ms)
            else:
                audios = model.generate(
                    text=text, language=language, ref_audio=ref_audio_path,
                    ref_text=ref_text, instruct=instruct, duration=duration,
                    num_step=num_step, guidance_scale=guidance_scale, speed=speed,
                    denoise=denoise, postprocess_output=postprocess_output,
                    **kwargs
                )
                audio_out = audios[0]

        # Apply DSP effect preset. The OmniVoice model never masters its own
        # output, so mastering always runs here (unchanged behavior).
        return _apply_effect_chain(audio_out, sr, effect_preset)

    except ValueError as e:
        # Don't wrap validation errors in OOM message
        raise e
    except Exception as e:
        _oom_friendly_reraise(e)


def _run_backend_inference(
    backend, text, language, ref_audio_path, ref_text, instruct, duration,
    num_step, guidance_scale, speed, denoise, postprocess_output,
    used_seed, effect_preset="broadcast",
    max_chunk_chars=None, crossfade_ms=None,
):
    """Engine-aware twin of :func:`_run_inference` (issue #312).

    Runs the request through a pluggable ``TTSBackend`` adapter instead of the
    OmniVoice model directly. The adapter protocol is narrower than the
    OmniVoice-native surface — engine-specific extras (``t_shift``,
    ``layer_penalty_factor``, …) only exist on the native path, which is why
    OmniVoice itself still goes through ``_run_inference``.
    """
    import torch
    try:
        if used_seed is not None:
            torch.manual_seed(used_seed)

        if language and language.lower() == "auto":
            language = None

        gen_kwargs = dict(
            language=language, ref_audio=ref_audio_path, ref_text=ref_text,
            instruct=instruct, num_step=num_step, guidance_scale=guidance_scale,
            speed=speed, denoise=denoise, postprocess_output=postprocess_output,
        )
        sr = backend.sample_rate

        # Inline [pause Nms] markers (issue #276) work for every engine — the
        # silence stitching is model-free.
        from omnivoice.utils.text import parse_pause_markers
        segments = parse_pause_markers(text)
        has_pause = len(segments) > 1 or (segments and segments[0][1] > 0)

        if has_pause:
            def _gen_span(span_text):
                # Per-span duration is left to the engine; an explicit overall
                # `duration` can't be meaningfully split across spans.
                return backend.generate(span_text, duration=None, **gen_kwargs)
            audio_out = _render_with_pauses(_gen_span, segments, sr)
        else:
            # Wave 1.2: sentence-boundary chunking for long text (see
            # _run_inference for the rationale; behavior is identical here).
            from services.chunked_tts import (
                DEFAULT_CROSSFADE_MS, DEFAULT_MAX_CHUNK_CHARS,
                concatenate_audio_chunks, split_text_into_chunks,
            )
            _max_chars = DEFAULT_MAX_CHUNK_CHARS if max_chunk_chars is None else max_chunk_chars
            _xfade_ms = DEFAULT_CROSSFADE_MS if crossfade_ms is None else crossfade_ms
            text_chunks = split_text_into_chunks(text, _max_chars)
            if len(text_chunks) > 1:
                parts = []
                for i, chunk_text in enumerate(text_chunks):
                    if used_seed is not None:
                        torch.manual_seed(used_seed + i)
                    parts.append(backend.generate(chunk_text, duration=None, **gen_kwargs))
                audio_out = concatenate_audio_chunks(parts, sr, _xfade_ms)
            else:
                audio_out = backend.generate(text, duration=duration, **gen_kwargs)

        return _apply_effect_chain(
            audio_out, sr, effect_preset,
            skip_mastering=getattr(backend, "applies_own_mastering", False),
        )

    except ValueError as e:
        # Don't wrap validation errors in OOM message
        raise e
    except Exception as e:
        _oom_friendly_reraise(e)


@router.post("/generate")
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
    t_shift: Optional[float] = Form(None),
    denoise: bool = Form(True),
    postprocess_output: bool = Form(True),
    layer_penalty_factor: Optional[float] = Form(None),
    position_temperature: Optional[float] = Form(None),
    class_temperature: Optional[float] = Form(None),
    profile_id: Optional[str] = Form(None),
    seed: Optional[int] = Form(None),
    effect_preset: str = Form("broadcast"),
    engine: Optional[str] = Form(None),
    # Wave 1.2 — unlimited-length generation: long text is split at sentence
    # boundaries and crossfaded. 0 disables chunking (whole text to engine).
    max_chunk_chars: int = Form(800, ge=0),
    crossfade_ms: int = Form(50, ge=0, le=1000),
    # Expressive-TTS Spec 01: apply the user pronunciation dictionary + inline
    # [[…]] overrides to the text before synthesis. Default ON; the global
    # OMNIVOICE_PRONUNCIATION pref can disable it for power users. Omitting it
    # with an empty dictionary is byte-identical to legacy behavior.
    pronounce: bool = Form(True),
):
    # #502: NFC-normalize the input text so decomposed (NFD) diacritics — common
    # in pasted Vietnamese and other Latin-with-marks text — are composed to the
    # single codepoints the tokenizer/model expect, instead of base-letter +
    # combining-mark sequences that render as distorted/garbled speech. NFC is a
    # no-op for already-composed text; mirrors the duration estimator
    # (utils/duration.py) so the estimate and the synthesis see the same text.
    import unicodedata
    text = unicodedata.normalize("NFC", text)

    # ── Engine resolution (issue #312) ──────────────────────────────────────
    # The request runs on the engine selected in Settings (POST /engines/select,
    # env var OMNIVOICE_TTS_BACKEND wins), or an explicit per-request `engine`
    # override — same pattern as /ws/tts's `engine` field and /v1/audio/speech's
    # `model`. Omitting both keeps the historical default (OmniVoice), so
    # existing API consumers see no change.
    from services.tts_backend import (
        OmniVoiceBackend, _mask_hf_tokens, active_backend_id, get_backend_class,
    )

    engine_id = engine or active_backend_id()
    try:
        backend_cls = get_backend_class(engine_id)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown TTS engine: {engine_id!r}. "
                "See GET /engines/tts for the list of valid engine ids."
            ),
        )

    _model = None
    _backend = None
    if backend_cls is OmniVoiceBackend:
        # OmniVoice keeps its native path: it carries the full advanced
        # parameter surface (t_shift, layer/position/class controls) that the
        # generic adapter protocol doesn't. Byte-identical to the old behavior.
        _model = await get_model()
    else:
        try:
            ok, msg = backend_cls.is_available()
        except Exception as exc:
            ok, msg = False, f"{type(exc).__name__}: {exc}"
        if not ok:
            raise HTTPException(
                status_code=400,
                detail=f"TTS engine '{engine_id}' is not available: {_mask_hf_tokens(msg)}",
            )
        # Reuse the per-process instance cache shared with the engine
        # health-check route so weights load once, not per request.
        from api.routers.engines import _get_engine_instance
        _backend = _get_engine_instance(backend_cls)

    # ── Routing gate (#21 — no silent CPU fallback). Computed ONCE per request
    # (host caps are constant; the per-request engine= override bypasses the
    # /engines/select gate, so this is the only place it's enforced for synth).
    from core.device_caps import detect_host_caps
    from services.engine_routing import resolve_routing, routing_notice
    _routing = resolve_routing(getattr(backend_cls, "gpu_compat", ("cpu",)), detect_host_caps())
    if _routing["routing_status"] == "unavailable":
        # The engine needs an accelerator this host lacks and has no CPU path.
        raise HTTPException(status_code=400, detail=_routing["routing_reason"])
    _routing_notice = routing_notice(_routing)  # (status, reason) or None

    ref_audio_path = None
    cleanup_ref = False
    used_seed = seed
    resolved_profile_id = None
    history_mode = None  # profile.kind when a profile drives; else inferred at insert

    if profile_id:
        with db_conn() as conn:
            row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if row:
            resolved_profile_id = profile_id
            # `kind` is authoritative (0005): 'design' profiles condition on
            # their deterministic rendered sample + instruct; 'clone' on the
            # user's reference. Lock always wins (it pins a specific take).
            # Rows from pre-0004 DBs mid-upgrade may lack the column → fall
            # back to the legacy is_locked/instruct inference.
            try:
                profile_kind = row["kind"] or "clone"
            except (KeyError, IndexError):
                profile_kind = "design" if (row["instruct"] and not row["is_locked"] and not row["ref_audio_path"]) else "clone"
            history_mode = profile_kind
            if row["is_locked"] and row["locked_audio_path"]:
                ref_audio_path = os.path.join(VOICES_DIR, row["locked_audio_path"])
                if not ref_text:
                    ref_text = row["ref_text"]
                if not instruct:
                    instruct = _profile_instruct(row)
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            elif profile_kind == "design":
                # Rendered sample (if present) carries the voice identity;
                # instruct alone is the fallback for legacy archetype rows.
                ref_audio_path = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
                if ref_audio_path and not ref_text and row["ref_text"]:
                    ref_text = row["ref_text"]
                if not instruct:
                    instruct = _profile_instruct(row)
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            elif row["instruct"] and not row["is_locked"] and not row["ref_audio_path"]:
                # Legacy design-shaped row (pre-0004 archetype materialization
                # failure path): instruct-only conditioning.
                if not instruct:
                    instruct = _profile_instruct(row)
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            else:
                ref_audio_path = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
                if not ref_text and row["ref_text"]:
                    ref_text = row["ref_text"]
                if not instruct and row["instruct"]:
                    instruct = row["instruct"]
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            if language == "Auto":
                language = None
            # #533: a profile's stored language must drive generation when the
            # request didn't pin one. Without this the German (etc.) archetype
            # generates with language=None and the model drifts to English —
            # even though the archetype PREVIEW renders correctly (archetypes.py
            # passes the language). An EXPLICIT non-Auto request language still
            # wins; we only fill the gap. `row` is a sqlite3.Row, so guard the
            # column lookup for pre-language DBs mid-upgrade.
            if language is None:
                try:
                    prof_lang = row["language"]
                except (KeyError, IndexError):
                    prof_lang = None
                if prof_lang and prof_lang != "Auto":
                    language = prof_lang
    elif ref_audio is not None:
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:
                f.write(await ref_audio.read())
                ref_audio_path = f.name
                cleanup_ref = True
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # #308: a transcript-less reference is transcribed with the active ASR
    # backend (whisperx / faster-whisper / mlx-whisper) instead of the model's
    # built-in transformers pipeline, which cannot load whisper-large-v3-turbo
    # on transformers 5.3. On failure ref_text stays None and the model's
    # fallback behaves exactly as before.
    if ref_audio_path and not ref_text:
        from services.asr_backend import transcribe_reference
        # Same #730 hang risk as any whisperx transcribe — bound + reset the pool
        # so a wedged reference transcribe can't brick the backend. This path is
        # best-effort (transcribe_reference returns None on failure → the model's
        # built-in ASR fallback), so a timeout degrades to None rather than
        # failing the whole generate.
        try:
            ref_text = await run_on_gpu_pool_guarded(
                functools.partial(transcribe_reference, ref_audio_path),
                what="Reference transcribe",
            )
        except GpuJobTimeoutError as e:
            logger.warning("reference transcribe hung (%s); using model ASR fallback", e)
            ref_text = None

    # #526: materialize a concrete seed when none was supplied (and no profile
    # pinned one) so the take is reproducible and we can hand it back via the
    # X-Seed header for the "keep this seed" control. An explicit request seed
    # or a profile's stored seed still wins — used_seed is only filled when it
    # is still None here, never overwritten.
    if used_seed is None:
        used_seed = random.randint(0, 2**31 - 1)

    # Expressive-TTS Spec 01: apply the user pronunciation dictionary + inline
    # [[…]] one-off overrides to the text, here — AFTER `language` is fully
    # resolved (a profile may fill it above) so per-language entries match the
    # real render language, and BEFORE the text reaches either inference path
    # (native OmniVoice or a pluggable backend) and the chunk splitter. This is
    # the single point user text → normalized text → model, so the transform
    # covers generate for every engine. Pure text substitution → identical on
    # mac/Win/Linux. A disabled pref or empty dictionary is a pass-through, so
    # plain text stays byte-identical (#G5 backward-compat).
    from core import prefs as _prefs
    _pron_env = os.environ.get("OMNIVOICE_PRONUNCIATION")
    if _pron_env is not None:
        # Env wins (power-user override); "0"/"false"/"no"/"off" disable it.
        _pron_enabled = _pron_env.strip().lower() not in ("0", "false", "no", "off", "")
    else:
        _pron_enabled = bool(_prefs.get("pronunciation_enabled", True))
    if pronounce and _pron_enabled:
        from services.pronunciation import apply_pronunciation, load_entries_from_db
        try:
            _pron_rows = load_entries_from_db()
        except Exception:  # noqa: BLE001 — table missing / DB locked → no-op
            _pron_rows = []
        text = apply_pronunciation(text, _pron_rows, language)
    else:
        # Even with the dictionary off, inline [[…]] overrides are an explicit,
        # in-text authoring choice → always honored (and never left as literal
        # double-bracket text the model would mispronounce).
        from services.pronunciation import apply_inline_overrides
        text = apply_inline_overrides(text)

    start_time = time.time()
    try:
        loop = asyncio.get_running_loop()
        if _backend is not None:
            # Bounded + pool-reset on hang so a wedged generate can't starve the
            # GPU pool and brick the backend ("can't reach backend", #730 class).
            audio_tensor = await run_on_gpu_pool_guarded(
                functools.partial(
                    _run_backend_inference,
                    _backend, text, language, ref_audio_path, ref_text, instruct,
                    duration, num_step, guidance_scale, speed, denoise,
                    postprocess_output, used_seed, effect_preset,
                    max_chunk_chars, crossfade_ms,
                ),
                what="TTS generate",
            )
            # Read after generation: engines with lazy model loading report
            # their real rate only once weights are up.
            sample_rate = _backend.sample_rate
        else:
            audio_tensor = await run_on_gpu_pool_guarded(
                functools.partial(
                    _run_inference,
                    _model, text, language, ref_audio_path, ref_text, instruct, duration,
                    num_step, guidance_scale, speed, t_shift, denoise,
                    postprocess_output, layer_penalty_factor, position_temperature,
                    class_temperature, used_seed, effect_preset,
                    max_chunk_chars, crossfade_ms,
                ),
                what="TTS generate",
            )
            sample_rate = _model.sampling_rate
        # Invisible AudioSeal provenance watermark on the final audio. Embedding
        # was previously only wired into the dub pipeline (dub_generate.py), so
        # plain TTS came out unmarked despite the setting being on. embed_watermark
        # self-gates on the user's watermark setting + AudioSeal availability and
        # passes the audio through unchanged on any failure, so it never breaks
        # generation.
        from services.watermark import embed_watermark
        audio_tensor = await loop.run_in_executor(
            _gpu_pool, embed_watermark, audio_tensor, sample_rate
        )
        gen_time = round(time.time() - start_time, 2)

        audio_id = str(uuid.uuid4())[:8]
        audio_filename = f"{audio_id}.wav"
        audio_path = os.path.join(OUTPUTS_DIR, audio_filename)
        _safe_torchaudio_save(audio_path, audio_tensor, sample_rate)

        audio_dur = round(audio_tensor.shape[-1] / sample_rate, 2)

        # #710: the clip is already generated and saved above. A history-write
        # failure — e.g. "no such table: generation_history" on a DB that missed
        # schema init — must NOT 500 the user's generation. Self-heal the schema
        # once and retry; if it still fails, log and return the audio anyway.
        def _write_history():
            with db_conn() as conn:
                conn.execute(
                    "INSERT INTO generation_history (id, text, mode, language, instruct, profile_id, audio_path, duration_seconds, generation_time, seed, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (audio_id, text[:200], history_mode or ("clone" if ref_audio_path else "design"),
                     language or "Auto", instruct or "", resolved_profile_id,
                     audio_filename, audio_dur, gen_time, used_seed, time.time())
                )
        try:
            _write_history()
        except sqlite3.OperationalError as e:
            logger.warning("generation history write failed (%s); healing schema + retrying", e)
            try:
                ensure_schema()
                _write_history()
            except Exception as e2:
                logger.warning("history write still failed after schema heal; returning audio anyway: %s", e2)
        except Exception as e:
            logger.warning("generation history write failed; returning audio anyway: %s", e)
        event_bus.emit("generation_history", {"action": "created", "id": audio_id})

        buffer = io.BytesIO()
        _safe_torchaudio_save(buffer, audio_tensor, sample_rate, format="wav")
        buffer.seek(0)
        wav_bytes = buffer.read()

        async def _stream_wav():
            chunk_size = 16384
            for i in range(0, len(wav_bytes), chunk_size):
                yield wav_bytes[i:i + chunk_size]

        _resp_headers = {
            "X-Audio-Id": audio_id,
            "X-Gen-Time": str(gen_time),
            "X-Audio-Path": audio_filename,
            "X-Seed": str(used_seed) if used_seed is not None else "",
            "X-Audio-Duration": str(audio_dur),
            "Content-Length": str(len(wav_bytes)),
        }
        # Routing notice (#21): cpu_fallback or accelerated-with-caveat only;
        # the WAV body is binary so the header channel is the carrier.
        if _routing_notice:
            from services.engine_routing import header_safe_reason
            _resp_headers["X-OmniVoice-Routing"] = _routing_notice[0]
            _hr = header_safe_reason(_routing_notice[1])
            if _hr:
                _resp_headers["X-OmniVoice-Routing-Reason"] = _hr
        return StreamingResponse(
            _stream_wav(),
            media_type="audio/wav",
            headers=_resp_headers,
        )
    except HTTPException:
        raise
    except GpuJobTimeoutError as e:
        # A wedged GPU generate — the pool was already reset to restore capacity
        # (#730 class). Report the actionable timeout instead of the misleading
        # "can't reach backend" the frontend shows when the pool starves.
        logger.error("Generate timed out: %s", e)
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        logger.error("Validation failed: %s", e)
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        tb = traceback.format_exc()
        logger.error("Inference failed: %s\n%s", e, tb)
        raise HTTPException(
            status_code=500,
            detail=(
                f"Couldn't synthesize audio. See Settings → Logs → Backend for the full trace. "
                f"Underlying error: {_safe_exc_text(e)}"
            ),
        )
    finally:
        if cleanup_ref and ref_audio_path:
            with contextlib.suppress(OSError):
                os.remove(ref_audio_path)

def _safe_output_path(name):
    if not name:
        return None
    base = os.path.basename(name)
    if base != name:
        return None
    outputs_real = os.path.realpath(OUTPUTS_DIR)
    candidate = os.path.realpath(os.path.join(OUTPUTS_DIR, base))
    if not candidate.startswith(outputs_real + os.sep):
        return None
    return candidate


@router.get("/history")
def list_history():
    """Newest 50 generations whose audio still exists on disk.

    Rows whose WAV was deleted out-of-band (cleared outputs dir, manual
    cleanup) used to come back anyway and render dead players that 404 on
    every fetch; prune them here so the UI never sees them again."""
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM generation_history ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
        alive, stale_ids = [], []
        for r in rows:
            p = _safe_output_path(r["audio_path"]) if r["audio_path"] else None
            if r["audio_path"] and (not p or not os.path.exists(p)):
                stale_ids.append(r["id"])
            else:
                alive.append(dict(r))
        if stale_ids:
            conn.executemany(
                "DELETE FROM generation_history WHERE id=?",
                [(i,) for i in stale_ids],
            )
            logger.info("pruned %d stale history rows (audio file gone)", len(stale_ids))
    return alive

@router.delete("/history")
def clear_history():
    with db_conn() as conn:
        rows = conn.execute("SELECT audio_path FROM generation_history").fetchall()
        for r in rows:
            p = _safe_output_path(r["audio_path"])
            if p and os.path.exists(p):
                with contextlib.suppress(OSError):
                    os.remove(p)
        conn.execute("DELETE FROM generation_history")
    event_bus.emit("generation_history")
    return {"cleared": True}

@router.delete("/history/{history_id}")
def delete_single_history(history_id: str):
    with db_conn() as conn:
        row = conn.execute("SELECT audio_path FROM generation_history WHERE id=?", (history_id,)).fetchone()
        if row and row["audio_path"]:
            p = _safe_output_path(row["audio_path"])
            if p and os.path.exists(p):
                with contextlib.suppress(OSError):
                    os.remove(p)
        conn.execute("DELETE FROM generation_history WHERE id=?", (history_id,))
    event_bus.emit("generation_history", {"action": "deleted", "id": history_id})
    return {"deleted": True}
