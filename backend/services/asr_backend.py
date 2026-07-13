"""
ASR adapter interface — Phase 3.3 (ROADMAP.md).

One protocol, multiple engines. Today we ship:

    • FasterWhisperBackend — CTranslate2-based (the engine WhisperX uses).
                            Default on Linux, Windows, mac-Intel. Also fast
                            on mac-ARM so we use it as the cross-platform
                            baseline and only prefer MLX on mac-ARM when
                            explicitly installed.
    • MLXWhisperBackend   — mlx-whisper on Apple Silicon. Optional speedup,
                            only available when mlx wheels install (mac-ARM).
    • PyTorchWhisperBackend — last-resort fallback using the existing
                            `_asr_pipe` on the TTS model.

Both return the raw Whisper output dict so `services.segmentation.
segment_transcript(...)` can keep working unchanged — new backends normalise
their output to the `{"chunks": [{"text", "timestamp": (start, end)}]}`
shape the segmenter expects.

Selection via `OMNIVOICE_ASR_BACKEND` (default: auto-detect, prefers
faster-whisper because it's available on every platform we ship to).
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import contextlib
import threading
import time
from utils.containment import contain_system_exit

from abc import ABC, abstractmethod
from collections import OrderedDict
from typing import Optional

logger = logging.getLogger("omnivoice.asr")

# A single ASR transcribe must never block a request indefinitely. The chunked
# dub pipeline already bounds each chunk (OMNIVOICE_TRANSCRIBE_CHUNK_TIMEOUT_S);
# the *whole-file* paths (dub QC re-transcribe, dictation, OpenAI-compat) ran
# unbounded, so a slow/stuck transcribe — e.g. large-v3 on a VRAM-starved GPU
# where the resident TTS model contends for memory — hung the request *and* tied
# up a GPU-pool worker, surfacing in the UI as the misleading "can't reach the
# local backend" (TamKieu / Vietnam report). Bound them so a hang becomes a fast,
# actionable error instead. Generous default (whole-file large-v3 on CPU is slow
# but valid); override with the env var for very long single files.
ASR_TRANSCRIBE_TIMEOUT_S = float(os.environ.get("OMNIVOICE_ASR_TRANSCRIBE_TIMEOUT_S", "300.0"))


class ASRTimeoutError(TimeoutError):
    """Raised when a whole-file transcribe exceeds ASR_TRANSCRIBE_TIMEOUT_S.

    Carries a user-actionable message: the backend is alive (this is not a
    connection failure) — the ASR model is too heavy for the available compute.
    """


def reset_pool_after_wedge(executor, *, what: str = "ASR") -> bool:
    """Abandon a GPU pool whose worker is wedged on a timed-out transcribe (#730).

    Python can't kill the stuck thread, but dropping the poisoned pool means the
    next submit (a retry, the next chunk, or a concurrent TTS generate) gets a
    fresh worker instead of queueing behind the wedged one. This is the ONE
    recovery mechanism shared by every transcribe path — the whole-file guards
    (via :func:`run_transcribe_guarded`) and the chunked dub stream both route
    through it, so the semantics can't drift between them again.

    Best-effort: an executor without ``reset()`` (a plain ThreadPoolExecutor in
    tests) is a no-op, and a failing reset never raises — this runs on the very
    failure path it's trying to recover from. Returns True when a reset ran.
    """
    _reset = getattr(executor, "reset", None)
    if not callable(_reset):
        return False
    try:
        _reset()
        logger.warning(
            "%s transcribe wedged — abandoned the GPU-pool worker to restore "
            "capacity (#730).", what,
        )
        return True
    except Exception:
        logger.exception("GPU pool reset after %s timeout failed", what)
        return False


# ── Consecutive-timeout streak → recommend the crash-isolated engine ────────
# A pool reset restores *capacity*, but the wedged CTranslate2/whisperx thread
# keeps its VRAM until the process exits. When guarded transcribes keep timing
# out back-to-back in one session, resets clearly aren't recovering the
# underlying hang — the durable fix is the crash-isolated sidecar engine
# (services.subprocess_asr, #393), whose child process CAN be hard-killed to
# reclaim the hung call and its VRAM. We only *recommend* it (log + error
# message); we never switch engines automatically (owner rule: no silent
# behavior divergence).
_TIMEOUT_STREAK_FOR_ISOLATED_HINT = 2
_timeout_streak = 0
_timeout_streak_lock = threading.Lock()


def _note_transcribe_timeout() -> int:
    global _timeout_streak
    with _timeout_streak_lock:
        _timeout_streak += 1
        return _timeout_streak


def _note_transcribe_success() -> None:
    global _timeout_streak
    with _timeout_streak_lock:
        _timeout_streak = 0


def _isolated_engine_hint(streak: int) -> str:
    """User-facing recommendation once resets stop recovering (streak ≥ 2).

    Empty when the streak is below the threshold, or when the user is already
    on the isolated engine (recommending it to itself would be noise — the
    base message's smaller-model/CPU guidance is all that's left)."""
    if streak < _TIMEOUT_STREAK_FOR_ISOLATED_HINT:
        return ""
    try:
        if active_backend_id() == "faster-whisper-isolated":
            return ""
    except Exception:  # noqa: BLE001 — the hint must never break the error path
        pass
    logger.warning(
        "%d consecutive ASR transcribe timeouts this session — pool resets are "
        "not recovering the hang. Recommend switching the ASR engine to "
        "'Faster-Whisper (crash-isolated subprocess)' [faster-whisper-isolated] "
        "in Settings → Engines. Not switching automatically (#730).", streak,
    )
    return (
        f"This is {streak} transcribe timeouts in a row this session, so pool "
        "resets aren't recovering the underlying hang. Recommended: switch the "
        "ASR engine to 'Faster-Whisper (crash-isolated subprocess)' "
        "(faster-whisper-isolated) in Settings → Engines — it runs "
        "transcription in a separate process that can be force-killed to "
        "reclaim a hung transcribe and its VRAM. OmniVoice never switches "
        "engines automatically."
    )


async def run_transcribe_guarded(executor, fn, *, what: str = "ASR",
                                 timeout: float = ASR_TRANSCRIBE_TIMEOUT_S,
                                 timeout_env: str = "OMNIVOICE_ASR_TRANSCRIBE_TIMEOUT_S"):
    """Run a blocking transcribe ``fn`` in ``executor`` with a hard wall-clock
    bound. On timeout, raise :class:`ASRTimeoutError` with guidance instead of
    letting the request hang forever.

    ``run_in_executor`` cannot cancel the underlying thread, so a wedged
    transcribe (a CTranslate2 / whisperx / VAD hang seen on some Windows + CUDA
    setups, #730) keeps occupying its GPU-pool worker. With a 1–2 worker pool
    that starves every *other* request — including TTS generate — and the next
    thing the user does surfaces as "Can't reach the local backend" even though
    the process is alive. So on timeout we also ``reset()`` the pool when it
    supports it (``_ResilientGpuPool``): the wedged thread is abandoned and the
    next submit gets a fresh worker, restoring capacity without an app restart.
    The orphaned thread still holds its VRAM until the process exits, which is
    why the message still recommends a smaller ASR model / Flush as the durable
    fix. Executors without ``reset`` (a plain ThreadPoolExecutor in tests) just
    get the bound + actionable error.
    """
    loop = asyncio.get_running_loop()
    # Same SystemExit containment as the TTS pool (#1133 class): an ASR
    # dependency written as a CLI must not be able to shut the backend down.
    fut = loop.run_in_executor(executor, contain_system_exit(fn, what))
    try:
        result = await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        # Free the poisoned pool so a hung transcribe can't keep starving TTS /
        # other ASR work (the "can't reach backend" symptom, #730).
        reset_pool_after_wedge(executor, what=what)
        streak = _note_transcribe_timeout()
        msg = (
            f"{what} transcription exceeded {timeout:.0f}s and was abandoned — "
            "the backend is running, but the ASR model is too heavy for the "
            "available compute. Most often the GPU is VRAM-starved: the resident "
            "TTS model and a large ASR model (large-v3) contend for memory. "
            "Capacity was restored automatically, but for a durable fix Flush the "
            "TTS model to free VRAM, pick a smaller ASR model in Settings → "
            f"Models, or set ASR to CPU. (Raise {timeout_env} "
            "for very long transcribes.)"
        )
        hint = _isolated_engine_hint(streak)
        if hint:
            msg += " " + hint
        raise ASRTimeoutError(msg)
    # A completed transcribe (even a failed-but-returned one) proves the pool
    # isn't hung — only genuine timeouts count toward the consecutive streak.
    _note_transcribe_success()
    return result


def _compute_type_candidates(device: str) -> list[str]:
    """Per-device compute_type fallback chain. int8 is supported by every
    CTranslate2 CUDA+CPU build; float16/int8_float16 only on GPUs with efficient
    fp16 — so degrade rather than crash (#551). Honors an ASR_COMPUTE_TYPE env
    override (power users on exotic hardware can pin int8/float32)."""
    import os
    override = os.environ.get("ASR_COMPUTE_TYPE")
    if override:
        return [override]
    return ["float16", "int8_float16", "int8"] if device == "cuda" else ["int8", "float32"]


def _is_compute_type_error(msg: str) -> bool:
    low = msg.lower()
    return "compute type" in low or "efficient float16" in low


def _decode_audio_16k_mono(audio_path: str):
    """Decode `audio_path` to a 16 kHz mono float32 waveform using OmniVoice's
    *validated* ffmpeg, instead of whisperx.load_audio's bare ``"ffmpeg"`` PATH
    lookup.

    whisperx (and openai-whisper) shell out to a literal ``"ffmpeg"`` resolved
    against the OS PATH. On Windows that resolves to whatever the system finds
    first — a WindowsApps alias stub or a corrupt/wrong-arch download — which
    passes `which` but explodes at spawn with ``[WinError 193] %1 is not a valid
    Win32 application``. whisperx only catches `CalledProcessError`, so the
    spawn-time `OSError` escapes and the dub/batch path reports the opaque
    "Transcription produced no segments" (#479). ``find_ffmpeg()`` probes each
    candidate with ``-version`` and returns a runnable binary (the bundled
    imageio-ffmpeg / Tauri sidecar) — or None, so we can raise an actionable
    error. This also fixes the imageio case a PATH-prepend can't: its binary is
    named ``ffmpeg-<plat>-vN.exe``, not ``ffmpeg``, so bare lookup never finds
    it. Mirrors whisperx.audio.load_audio's command exactly (16 kHz, mono, s16le).
    """
    import subprocess

    import numpy as np

    from services.ffmpeg_utils import find_ffmpeg

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(
            "Cannot transcribe: ffmpeg is missing or not runnable. Install "
            "ffmpeg (or let OmniVoice's bundled binary download), then retry. "
            "On Windows a '[WinError 193]' here means the ffmpeg binary is "
            "corrupt or the wrong architecture — reinstall it or clear the "
            "imageio-ffmpeg cache."
        )
    cmd = [
        ffmpeg, "-nostdin", "-threads", "0", "-i", audio_path,
        "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", "16000", "-",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, check=True).stdout
    except OSError as e:
        # Belt-and-suspenders: find_ffmpeg() already -version-validated this
        # binary, so a WinError 193 here is unexpected — surface it clearly
        # rather than letting it become "no segments".
        raise RuntimeError(
            f"ffmpeg at {ffmpeg!r} could not be executed ({e}). Reinstall "
            "ffmpeg or clear the imageio-ffmpeg cache."
        ) from e
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode(errors="replace")[:500]
        raise RuntimeError(f"Failed to decode audio for transcription: {stderr}") from e
    return np.frombuffer(out, np.int16).flatten().astype(np.float32) / 32768.0


# ── Protocol ────────────────────────────────────────────────────────────────


class ASRBackend(ABC):
    id: str = "base"
    display_name: str = "Base ASR"
    # Accelerator families this backend can use, in preference order; always
    # includes a fallback. Subset of {cuda, rocm, mps, xpu, cpu}. Mirrors the
    # TTSBackend.gpu_compat contract so engine_routing.resolve_routing() can
    # surface the effective device per host (no silent CPU fallback). The
    # conservative default is CPU-only; subclasses declare what they really run
    # on. (ROCm is intentionally NOT claimed yet for any ASR engine — see the
    # per-engine notes; an unverified `rocm` claim would route ROCm hosts to a
    # broken GPU path, strictly worse than the honest `cpu_fallback`.)
    gpu_compat: tuple[str, ...] = ("cpu",)

    @classmethod
    @abstractmethod
    def is_available(cls) -> tuple[bool, str]:
        ...

    @abstractmethod
    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        """Return the raw Whisper output dict. Callers (`segment_transcript`)
        know how to read it — this stays deliberately untyped so new engines
        that already speak the shape plug in with zero adapter work.
        """

    def ensure_loaded(self) -> None:
        """Eagerly load the model weights, raising the real cause on failure.

        Backends load lazily inside ``transcribe()`` by default, so a load
        failure (missing weights, CUDA/cuDNN mismatch, torch-2.6 weights-only
        VAD regression, import error) first surfaces buried in per-chunk
        errors — and is retried on *every* chunk. The transcribe preflight
        calls this so the genuine cause is surfaced once, up front, as a clean
        terminal error event instead of N cryptic per-chunk failures (#578).

        Default is a no-op; backends that hold a heavy model override it to
        trigger their lazy loader. It MUST raise the underlying exception (not
        swallow it) so the caller can classify and surface it.
        """
        pass

    def unload(self) -> None:
        """Release the model from memory."""
        pass


# ── WhisperX (cross-platform default — forced-alignment word timing) ────────


def _harden_speechbrain_lazy_imports() -> None:
    """Make speechbrain 1.x's lazy-import guard fire on Windows too (#630/#611/#647).

    speechbrain 1.x exposes optional integrations (``k2_fsa``, ``numba`` losses,
    ``spacy``/``flair`` nlp) as ``LazyModule`` redirects living in ``sys.modules``.
    Stray introspection — PyTorch's op-registration machinery, pickling, a
    ``dir()``/``hasattr`` walk — touches one of these during ``whisperx.load_model``
    (pyannote → speechbrain), which would *actually* import the optional package.
    speechbrain guards against that by suppressing the import when the triggering
    frame is the stdlib ``inspect`` module — but the check is
    ``filename.endswith("/inspect.py")``, a hardcoded POSIX separator. On Windows
    the frame filename uses backslashes (``...\\Lib\\inspect.py``), so the guard
    misses, the redirect imports ``speechbrain.integrations.k2_fsa`` → ``import k2``
    → k2 isn't installed → ``ImportError: Lazy import of LazyModule(...k2_fsa...)
    failed``. That bubbles out of WhisperX and aborts transcription with zero
    segments. WhisperX is the *default* ASR, so this is a Windows-only break of a
    cross-platform-default feature (P0 parity).

    Fix the whole class — every optional-integration redirect, not just k2 — by
    re-implementing ``LazyModule.ensure_module`` with an ``os.sep``-agnostic
    basename check. Idempotent and a no-op on macOS/Linux (basename match is a
    strict superset of the old forward-slash check) and when speechbrain is
    absent. A genuine access from real user code with k2 missing still raises
    ImportError unchanged — only inspect-triggered spurious imports are
    suppressed, on every platform.
    """
    try:
        from speechbrain.utils import importutils as _iu
    except Exception:  # speechbrain not installed / import side-effect — nothing to harden
        return
    if getattr(_iu.LazyModule, "_omnivoice_xplat_guard", False):
        return
    import importlib as _importlib
    import inspect as _inspect
    import sys as _sys
    import warnings as _warnings

    def ensure_module(self, stacklevel):
        importer_frame = None
        try:
            importer_frame = _inspect.getframeinfo(_sys._getframe(stacklevel + 1))
        except AttributeError:
            _warnings.warn(
                "Failed to inspect frame to check if we should ignore importing a "
                "module lazily (OmniVoice cross-platform guard)."
            )
        if importer_frame is not None:
            # Normalise BOTH separators explicitly (not os.path.basename, which is
            # host-dependent) so the guard is correct regardless of which os.path
            # flavour is active. Upstream's `.endswith("/inspect.py")` matched only
            # POSIX paths — that is the Windows-only bug (#630/#611/#647).
            base = importer_frame.filename.replace("\\", "/").rsplit("/", 1)[-1]
            if base == "inspect.py":
                raise AttributeError()
        if self.lazy_module is None:
            try:
                if self.package is None:
                    self.lazy_module = _importlib.import_module(self.target)
                else:
                    self.lazy_module = _importlib.import_module(f".{self.target}", self.package)
            except Exception as e:  # noqa: BLE001 — match upstream: wrap as ImportError
                raise ImportError(f"Lazy import of {repr(self)} failed") from e
        return self.lazy_module

    _iu.LazyModule.ensure_module = ensure_module
    _iu.LazyModule._omnivoice_xplat_guard = True
    logger.debug("speechbrain LazyModule guard hardened for cross-platform inspect.py check")


#: wav2vec2 aligners, keyed by (language, device). Shared across backends: the
#: aligner is independent of whatever produced the segments, so MLX (which
#: transcribes on the GPU) reuses exactly the aligner WhisperX would have used.
_ALIGN_CACHE: dict[tuple[str, str], object] = {}

#: Forced alignment is torch/wav2vec2 (not CTranslate2), so unlike Whisper itself
#: it *can* run on MPS — measured on an M2: 20.3 s vs 28.4 s for a 30 s chunk, with
#: byte-identical word timings. So MPS is preferred, but torchaudio's MPS coverage
#: is uneven across aligner models, and a failure here would silently cost us the
#: ±10-30 ms timing that lip-sync depends on. Hence: try MPS, fall back to **CPU**,
#: and only then give up and keep Whisper's own looser timestamps.
_ALIGN_DEVICE_ENV = "OMNIVOICE_ALIGN_DEVICE"


def load_align_model(language_code: str, device: str):
    """Lazy-load (and cache) the wav2vec2 aligner for a language.

    Returns ``(model, metadata)``, or ``None`` when no aligner exists for the
    language — WhisperX bundles them for ~20 major languages only, and the
    caller then keeps Whisper's own (looser) word timestamps."""
    key = (language_code, device)
    if key in _ALIGN_CACHE:
        return _ALIGN_CACHE[key]
    try:
        import whisperx

        model, metadata = whisperx.load_align_model(
            language_code=language_code, device=device,
        )
        _ALIGN_CACHE[key] = (model, metadata)
    except Exception as e:  # noqa: BLE001 — missing aligner is normal, not fatal
        logger.info(
            "no wav2vec2 aligner for language=%r (%s); "
            "falling back to Whisper's native word timestamps",
            language_code, e,
        )
        _ALIGN_CACHE[key] = None
    return _ALIGN_CACHE[key]


def forced_align(segments: list, audio, language_code: str, device: str | None = None) -> list:
    """Snap word boundaries to the audio with wav2vec2 forced alignment.

    This is what buys the dub pipeline its ±10-30 ms word timing (vs Whisper's
    own ±100-300 ms), and lip-sync quality depends on it. It takes *plain
    segments*, so it is deliberately independent of which engine transcribed
    them — which is what lets the MLX backend transcribe on the GPU and still
    get WhisperX-grade timing.

    Returns the aligned segments, or the originals unchanged if alignment isn't
    available (no aligner for the language, whisperx not installed, or the
    alignment itself failed). Never raises: worse timing beats no transcript.
    """
    if not segments:
        return segments

    pinned = device or os.environ.get(_ALIGN_DEVICE_ENV)
    if pinned:
        devices = [pinned]
    elif _mps_available():
        devices = ["mps", "cpu"]  # fast path, then the always-works path
    else:
        devices = ["cpu"]

    for i, dev in enumerate(devices):
        align = load_align_model(language_code, dev)
        if align is None:
            return segments  # no aligner for this language — not a device problem
        model_a, metadata = align
        try:
            import whisperx

            result = whisperx.align(
                segments, model_a, metadata, audio, dev, return_char_alignments=False,
            )
            return result.get("segments", segments)
        except Exception as e:  # noqa: BLE001
            last = i == len(devices) - 1
            if last:
                logger.warning(
                    "forced alignment failed on %s: %s — using native word timestamps", dev, e,
                )
                return segments
            logger.info("forced alignment failed on %s (%s) — retrying on %s", dev, e, devices[i + 1])
    return segments


class WhisperXBackend(ASRBackend):
    id = "whisperx"
    display_name = "WhisperX (faster-whisper + wav2vec2 forced alignment)"
    # CTranslate2 backend: CUDA fp16 or CPU int8 (see _pick_device). ROCm not
    # claimed — CTranslate2 has no upstream HIP build, so a ROCm host honestly
    # gets cpu_fallback rather than a false GPU promise.
    gpu_compat = ("cuda", "cpu")

    def __init__(self):
        self._model_name = os.environ.get("ASR_MODEL_WHISPERX", "large-v3")
        self._asr = None
        self._align_cache = {}  # language_code → (align_model, metadata)
        self._device, self._compute_type = self._pick_device()

    @staticmethod
    def _pick_device() -> tuple[str, str]:
        # CUDA fp16 when available; otherwise CPU int8 (fastest CPU path,
        # negligible WER regression vs fp32 for whisper-large-v3).
        try:
            import torch
            if torch.cuda.is_available():
                return "cuda", "float16"
        except Exception:
            pass
        return "cpu", "int8"

    # Peak VRAM (GB) to load *and transcribe* whisper large-v3 per CTranslate2
    # compute type (weights + encoder/decoder workspace, with headroom). #723:
    # on an 8 GB card with the TTS model resident, loading fp16 large-v3 dies
    # as a *native* CUDA OOM abort — the process is killed, no Python
    # exception ever fires, and the UI reports "Can't reach the local
    # backend". The only defense is to never start that load, so the device
    # pick is re-checked against actually-free VRAM right before loading.
    _CUDA_VRAM_BUDGET_GB = {"float16": 5.0, "int8_float16": 3.5, "int8": 3.0}

    #: Budget multiplier by model size (budgets above are for large-v3).
    _MODEL_VRAM_SCALE = (
        ("large", 1.0), ("turbo", 0.55), ("medium", 0.5),
        ("small", 0.25), ("base", 0.15), ("tiny", 0.1),
    )

    @staticmethod
    def _free_vram_gb():
        """Device-wide free VRAM in GB (counts other processes), or None."""
        try:
            import torch
            if torch.cuda.is_available():
                free, _total = torch.cuda.mem_get_info()
                return free / 1024**3
        except Exception:  # noqa: BLE001 — preflight must never block ASR
            pass
        return None

    @classmethod
    def _model_scale(cls, model_name: str) -> float:
        name = (model_name or "").lower()
        for key, scale in cls._MODEL_VRAM_SCALE:
            if key in name:
                return scale
        return 1.0  # unknown → assume large

    def _degrade_for_vram(self, device: str, compute_type: str) -> tuple[str, str]:
        """Downgrade the CUDA compute type (or fall to CPU) if free VRAM can't
        hold the model — preventing the un-catchable native OOM abort (#723).
        Opt-out: OMNIVOICE_ASR_VRAM_PREFLIGHT=0."""
        if device != "cuda" or os.environ.get(
            "OMNIVOICE_ASR_VRAM_PREFLIGHT", "1"
        ).strip().lower() in ("0", "false", "no"):
            return device, compute_type
        free = self._free_vram_gb()
        if free is None:
            return device, compute_type
        scale = self._model_scale(self._model_name)
        candidates = list(self._CUDA_VRAM_BUDGET_GB)
        start = candidates.index(compute_type) if compute_type in candidates else 0
        for ct in candidates[start:]:
            if free >= self._CUDA_VRAM_BUDGET_GB[ct] * scale:
                if ct != compute_type:
                    logger.warning(
                        "whisperx VRAM preflight: %.1f GB free < %.1f GB needed "
                        "for %s %s — degrading to %s (#723)",
                        free, self._CUDA_VRAM_BUDGET_GB[compute_type] * scale,
                        self._model_name, compute_type, ct,
                    )
                return device, ct
        logger.warning(
            "whisperx VRAM preflight: %.1f GB free is too little for %s on CUDA "
            "(needs ≥%.1f GB even at int8) — using CPU int8 instead. Free VRAM "
            "(flush the TTS model, or close other GPU apps) for GPU-speed ASR. (#723)",
            free, self._model_name,
            self._CUDA_VRAM_BUDGET_GB["int8"] * scale,
        )
        return "cpu", "int8"

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import whisperx  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, f"whisperx not installed: {e}"
        except Exception as e:  # noqa: BLE001
            # The import can fail while loading a native dep — CTranslate2's .so
            # is rejected by hardened kernels / newer glibc with "cannot enable
            # executable stack" (#692), an OSError, not an ImportError. An
            # availability probe must REPORT 'unusable here', never raise, so
            # engine selection falls back instead of crashing the ASR preflight.
            return False, f"whisperx failed to load ({type(e).__name__}): {e}"

    def ensure_loaded(self) -> None:
        # Surface a whisperx/CTranslate2/torch load failure at preflight (once,
        # with the real cause) instead of buried per-chunk and retried N times
        # (#578). Re-raises whatever `_ensure_asr` raises after its fp16→int8
        # and OOM→CPU fallbacks are exhausted.
        self._ensure_asr()

    def _ensure_asr(self):
        if self._asr is not None:
            return
        # Patch speechbrain's lazy-import guard BEFORE whisperx pulls in pyannote
        # → speechbrain, or a stray k2_fsa redirect import aborts ASR on Windows
        # (#630/#611/#647). No-op on macOS/Linux and when speechbrain is absent.
        _harden_speechbrain_lazy_imports()
        import whisperx
        # #723: re-check the CUDA pick against *currently free* VRAM — the TTS
        # model may have claimed the card since __init__. A too-big load dies
        # as a native abort (whole process, no exception), so it must be
        # avoided up front rather than caught below.
        self._device, self._compute_type = self._degrade_for_vram(
            self._device, self._compute_type
        )
        logger.info(
            "whisperx loading ASR %s on %s (%s)",
            self._model_name, self._device, self._compute_type,
        )
        # PyTorch 2.6 flipped `torch.load(weights_only=True)` to default,
        # which breaks pyannote 3.x's VAD checkpoint (that whisperx ships):
        # each load surfaces a different missing global — `omegaconf.*`,
        # `typing.Any`, etc. The fix is to allowlist the pickle globals the
        # VAD file contains via `torch.serialization.add_safe_globals` so
        # the secure `weights_only=True` load path succeeds *without* us
        # disabling it.
        #
        # An earlier defensive layer (monkey-patching `torch.load` to force
        # `weights_only=False` for the duration of `whisperx.load_model`)
        # was removed in P0 Wave 1: it defeated PyTorch's secure unpickler
        # globally for any code that ran during that window, which is the
        # opposite of what the surrounding comment claimed. If a downstream
        # callee deserialised an attacker-controlled pickle in that window
        # it would have executed arbitrary code with no warning. The
        # allowlist below is the only correct mitigation; if pyannote ever
        # ships a checkpoint with a new pickle class, the load fails loudly
        # and we extend `_allow_vad_pickle_globals()`.
        self._allow_vad_pickle_globals()
        try:
            self._asr = whisperx.load_model(
                self._model_name,
                device=self._device,
                compute_type=self._compute_type,
                # vad_method="silero" is the default; keep it so short gaps
                # get cleaned up before transcription.
            )
        except (ValueError, RuntimeError) as e:
            # #551: GPUs without efficient fp16 (older Maxwell/Pascal, GTX 16xx)
            # or a CTranslate2/cuDNN binary mismatch raise a *ValueError*
            # ("Requested float16 compute type, but the target device or backend
            # do not support efficient float16 computation") at load — not an
            # OOM, not a RuntimeError. Retry on the SAME device with the next
            # compute_type candidate (cuda: int8_float16 → int8) before touching
            # the OOM→CPU path, so we degrade rather than crash every chunk.
            if _is_compute_type_error(str(e)):
                candidates = _compute_type_candidates(self._device)
                try:
                    nxt = candidates[candidates.index(self._compute_type) + 1:]
                except ValueError:
                    nxt = [c for c in candidates if c != self._compute_type]
                for ct in nxt:
                    logger.warning(
                        "whisperx %s unsupported on %s — retrying with %s. Detail: %s",
                        self._compute_type, self._device, ct, e,
                    )
                    self._compute_type = ct
                    try:
                        self._asr = whisperx.load_model(
                            self._model_name,
                            device=self._device,
                            compute_type=self._compute_type,
                        )
                        return
                    except (ValueError, RuntimeError) as e2:
                        if _is_compute_type_error(str(e2)):
                            e = e2
                            continue
                        raise
                # Exhausted compute-type candidates on this device — re-raise.
                raise
            # CUDA OOM: a resident TTS model + the GPU worker pool can starve
            # VRAM on small (e.g. 8 GB laptop) GPUs, so loading large-v3 on
            # CUDA dies here — which previously surfaced as a bare 500 from
            # /dub/transcribe with no guidance. Fall back to CPU (slower, but
            # dubbing still works and keeps the same model/accuracy) instead.
            # Only triggers on a CUDA OOM, so the MPS/CPU paths are untouched.
            if self._device == "cuda" and "out of memory" in str(e).lower():
                logger.warning(
                    "whisperx CUDA OOM loading %s — retrying on CPU (slower). "
                    "Free VRAM (Flush the TTS model) for GPU-speed ASR. Detail: %s",
                    self._model_name, e,
                )
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001 — cache clear is best-effort
                    pass
                self._device, self._compute_type = "cpu", "int8"
                self._asr = whisperx.load_model(
                    self._model_name,
                    device=self._device,
                    compute_type=self._compute_type,
                )
            else:
                raise

    @staticmethod
    def _allow_vad_pickle_globals():
        """Register the pickle classes that pyannote's VAD checkpoint contains.

        Without this, PyTorch 2.6's secure unpickler refuses to load the file
        even if the call explicitly passes `weights_only=False` later — the
        allowlist is per-process and harmless to re-apply. Each class we add
        is one that has surfaced in the wild from pyannote/omegaconf/pytorch-
        lightning pickles; extending the list is safe.
        """
        try:
            import torch.serialization as _ts
        except Exception:
            return
        add = getattr(_ts, "add_safe_globals", None)
        if add is None:
            return  # older torch — secure unpickler didn't exist

        allow = []
        # omegaconf config containers + every node wrapper type the library
        # exposes. pyannote's VAD checkpoint pickles `ListConfig` /
        # `DictConfig` trees whose leaves are `AnyNode`/`ValueNode`/etc., so
        # allowlist the whole family in one pass rather than waiting for
        # users to hit each one in turn. All of these are pure metadata
        # containers — no executable side effects.
        try:
            import omegaconf.nodes as _ocn
            import omegaconf.base as _ocb
            from omegaconf.listconfig import ListConfig
            from omegaconf.dictconfig import DictConfig
            allow += [ListConfig, DictConfig]
            for _modname in ("nodes", "base"):
                _mod = _ocn if _modname == "nodes" else _ocb
                for _name in dir(_mod):
                    _obj = getattr(_mod, _name, None)
                    if isinstance(_obj, type) and _obj.__module__ == f"omegaconf.{_modname}":
                        allow.append(_obj)
        except Exception:
            pass
        # `EnumNode` references real enum classes at unpickle time; allow
        # the base Enum/IntEnum/Flag types so configs using enums load.
        try:
            import enum
            allow += [enum.Enum, enum.IntEnum, enum.Flag, enum.IntFlag]
        except Exception:
            pass
        # torch utility types that aren't in the secure unpickler's
        # default allowlist. `TorchVersion` is a `str` subclass that
        # pyannote/lightning serialise as metadata; `Size` is the shape
        # tuple type used in tensor metadata. Both are inert data.
        try:
            from torch.torch_version import TorchVersion
            import torch as _torch
            allow += [TorchVersion, _torch.Size]
        except Exception:
            pass
        # PyTorch Lightning serialises `hyper_parameters` as
        # `argparse.Namespace` (or an AttributeDict subclass thereof) so
        # configs roundtrip. Allowlist the Namespace constructor — it is
        # just an attribute bag with no executable side effects.
        try:
            import argparse
            allow += [argparse.Namespace]
        except Exception:
            pass
        # pyannote-specific metadata classes that travel with the VAD
        # checkpoint. Only the inert data-only types are allowlisted —
        # the `Model` / `Task` / `Dataset` classes from the same modules
        # do real work in `__init__` and stay off the allowlist.
        try:
            from pyannote.audio.core.model import Introspection, Output
            from pyannote.audio.core.task import Problem, Resolution, Specifications
            allow += [Introspection, Output, Problem, Resolution, Specifications]
        except Exception:
            pass
        # Python typing primitives that show up in config annotations.
        try:
            import typing
            allow += [typing.Any]
        except Exception:
            pass
        # pytorch-lightning's OrderedDict-backed state dict helpers.
        try:
            from collections import OrderedDict, defaultdict
            allow += [OrderedDict, defaultdict]
        except Exception:
            pass
        # Plain-data builtins. pyannote's VAD checkpoint pickles config
        # entries that resolve to bare builtin constructors (`GLOBAL list`,
        # `GLOBAL int`, …) and the secure unpickler refuses each one
        # without an explicit allowlist. These constructors only build
        # inert data primitives — no side effects, no code paths — so the
        # full set is safe to allowlist together, which avoids users
        # hitting them one-at-a-time as the checkpoint deserialises.
        allow += [
            list, dict, tuple, set, frozenset,
            int, float, bool, str, bytes, bytearray, complex,
            type(None), slice, range,
        ]
        # numpy scalar/array constructors that show up in pyannote configs
        # (sample rates, hop sizes saved as numpy ints/floats). Each is a
        # pure data type — safe to allowlist.
        try:
            import numpy as _np
            allow += [
                _np.ndarray, _np.dtype,
                _np.int8, _np.int16, _np.int32, _np.int64,
                _np.uint8, _np.uint16, _np.uint32, _np.uint64,
                _np.float16, _np.float32, _np.float64,
                _np.bool_, _np.complex64, _np.complex128,
            ]
            # numpy.core was renamed to numpy._core in 1.25+. Both modules
            # expose the same reconstruct helpers; allowlist whichever ships.
            for _modname in ("numpy._core.multiarray", "numpy.core.multiarray"):
                try:
                    _mod = __import__(_modname, fromlist=["_reconstruct", "scalar"])
                    for _attr in ("_reconstruct", "scalar"):
                        _fn = getattr(_mod, _attr, None)
                        if _fn is not None:
                            allow.append(_fn)
                except Exception:
                    pass
        except Exception:
            pass
        # pathlib types — config files sometimes save cache directories as
        # Path objects so the checkpoint can be relocated.
        try:
            import pathlib
            allow += [
                pathlib.PurePath, pathlib.PurePosixPath, pathlib.PureWindowsPath,
                pathlib.Path, pathlib.PosixPath, pathlib.WindowsPath,
            ]
        except Exception:
            pass
        if allow:
            try:
                add(allow)
            except Exception as e:
                logger.debug("add_safe_globals failed (harmless): %s", e)

    def _get_align(self, language_code: str):
        """Lazy-load the wav2vec2 alignment model for this language. WhisperX
        bundles aligners for ~20 major languages; for the others we fall back
        to faster-whisper's native word timestamps (already in result)."""
        return load_align_model(language_code, self._device)

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        import whisperx  # used for whisperx.align() below
        self._ensure_asr()
        logger.info("whisperx transcribing %s (word_timestamps=%s)", audio_path, word_timestamps)
        # Decode via OmniVoice's validated ffmpeg, NOT whisperx.load_audio's bare
        # "ffmpeg" PATH lookup which yields [WinError 193] -> "no segments" on
        # Windows (#479). Same 16 kHz mono s16le array whisperx expects.
        audio = _decode_audio_16k_mono(audio_path)
        try:
            result = self._asr.transcribe(audio)
        except IndexError:
            # WhisperX pipeline crashes with IndexError if VAD produces 0 segments
            logger.info("whisperx transcribe threw IndexError (likely 0 VAD segments). Returning empty result.")
            result = {"segments": [], "language": "en"}
            
        lang = result.get("language", "en")

        # Forced alignment when available — drastically improves word boundary
        # accuracy (±10-30 ms vs Whisper's ±100-300 ms). Skip for rare-language
        # audio where no wav2vec2 aligner exists.
        if word_timestamps:
            align = self._get_align(lang)
            if align is not None:
                model_a, metadata = align
                try:
                    result = whisperx.align(
                        result["segments"], model_a, metadata, audio,
                        self._device, return_char_alignments=False,
                    )
                except Exception as e:
                    logger.warning("whisperx alignment failed: %s — using raw timestamps", e)

        # Normalise to the shape segment_transcript(...) expects: chunks +
        # segments + language metadata. whisperx's post-align result has
        # `segments` with `words: [{word, start, end, score}]`.
        segments = result.get("segments", [])
        chunks = [
            {"text": seg.get("text", ""),
             "timestamp": (seg.get("start"), seg.get("end"))}
            for seg in segments
        ]
        return {
            "chunks": chunks,
            "segments": [
                {
                    "text": seg.get("text", ""),
                    "start": seg.get("start"),
                    "end": seg.get("end"),
                    "words": seg.get("words", []) if word_timestamps else [],
                }
                for seg in segments
            ],
            "language": lang,
        }

    def unload(self) -> None:
        self._asr = None
        self._align_cache.clear()
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

# ── Faster-Whisper (cross-platform fallback) ────────────────────────────────


class FasterWhisperBackend(ASRBackend):
    id = "faster-whisper"
    display_name = "Faster-Whisper (CTranslate2 — Linux/Windows/macOS)"
    # CTranslate2: CUDA or CPU (no upstream ROCm/HIP build — see WhisperX note).
    gpu_compat = ("cuda", "cpu")

    def __init__(self):
        # Defaulting to the CTranslate2-converted large-v3 repo. Matches
        # KNOWN_MODELS in api/routers/setup.py so the first-run wizard
        # downloads what the backend will actually load.
        self._model_name = os.environ.get(
            "ASR_MODEL_FASTER", "Systran/faster-whisper-large-v3"
        )
        self._model = None  # lazy — first transcribe() loads weights
        # Set by _ensure_model() to the device/compute_type that actually loaded
        # (after the #551 compute_type / #255 OOM→CPU fallback chain).
        self._device: str | None = None
        self._compute_type: str | None = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import faster_whisper  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, f"faster-whisper not installed: {e}"
        except Exception as e:  # noqa: BLE001
            # faster-whisper pulls in CTranslate2, whose .so is rejected by
            # hardened kernels / newer glibc ("cannot enable executable stack",
            # #692) — an OSError. Report unavailable so we fall back, not crash.
            return False, f"faster-whisper failed to load ({type(e).__name__}): {e}"

    def _ensure_model(self):
        if self._model is not None:
            return
        from faster_whisper import WhisperModel
        # Device / compute-type auto-pick:
        #   - CUDA present → GPU fp16
        #   - Apple Silicon / CPU → CPU int8 (fastest on CPU, negligible
        #     WER regression vs fp32 for whisper-large-v3)
        device, compute_type = "cpu", "int8"
        try:
            import torch
            if torch.cuda.is_available():
                device, compute_type = "cuda", "float16"
        except Exception:
            pass
        logger.info(
            "faster-whisper loading %s on %s (%s)",
            self._model_name, device, compute_type,
        )
        # Try the per-device compute_type chain (cuda: float16 → int8_float16 →
        # int8; cpu: int8 → float32). A GPU without efficient fp16 (older
        # Maxwell/Pascal, GTX 16xx, or a CTranslate2/cuDNN mismatch) raises a
        # *ValueError* at construction (#551) — degrade to the next candidate
        # instead of failing every chunk. A genuine CUDA OOM falls back to CPU
        # (slower, same model/accuracy), preserving the existing #255 behaviour.
        candidates = _compute_type_candidates(device)
        if compute_type in candidates:
            candidates = candidates[candidates.index(compute_type):]
        last_err: Exception | None = None
        while True:
            for ct in candidates:
                try:
                    self._model = WhisperModel(
                        self._model_name, device=device, compute_type=ct
                    )
                    self._device, self._compute_type = device, ct
                    return
                except (ValueError, RuntimeError) as e:
                    last_err = e
                    if _is_compute_type_error(str(e)):
                        logger.warning(
                            "faster-whisper %s unsupported on %s — trying next "
                            "compute_type. Detail: %s", ct, device, e,
                        )
                        continue
                    if device == "cuda" and "out of memory" in str(e).lower():
                        # Stop scanning GPU candidates; fall back to CPU below.
                        break
                    raise
            # Exhausted candidates for this device. If we were on CUDA and the
            # last failure was an OOM, retry on CPU with its candidates (#255).
            if device == "cuda" and last_err is not None and (
                "out of memory" in str(last_err).lower()
            ):
                logger.warning(
                    "faster-whisper CUDA OOM loading %s — retrying on CPU "
                    "(slower). Free VRAM (Flush the TTS model) for GPU-speed "
                    "ASR. Detail: %s", self._model_name, last_err,
                )
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001 — cache clear is best-effort
                    pass
                device = "cpu"
                candidates = _compute_type_candidates(device)
                compute_type = candidates[0]
                continue
            # All candidates exhausted (and no OOM→CPU retry available) — surface
            # the last error.
            raise last_err

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        self._ensure_model()
        logger.info(
            "faster-whisper transcribing %s (word_timestamps=%s)",
            audio_path, word_timestamps,
        )
        # faster-whisper returns a generator of Segment objects + an Info
        # struct. Materialise the generator so downstream consumers can
        # index / re-iterate.
        segments_iter, info = self._model.transcribe(
            audio_path,
            word_timestamps=word_timestamps,
            vad_filter=True,  # built-in Silero VAD — cleaner segment starts
        )
        segments = list(segments_iter)
        # Normalise to the shape segment_transcript(...) expects: a dict with
        # `chunks` (for backwards compat with mlx output) AND `segments` +
        # `language` (so callers that peek at language metadata keep working).
        chunks = [
            {"text": seg.text, "timestamp": (seg.start, seg.end)}
            for seg in segments
        ]
        out = {
            "chunks": chunks,
            "segments": [
                {
                    "text": seg.text,
                    "start": seg.start,
                    "end": seg.end,
                    "words": (
                        [
                            {
                                "word": w.word,
                                "start": w.start,
                                "end": w.end,
                                "probability": w.probability,
                            }
                            for w in (seg.words or [])
                        ]
                        if word_timestamps
                        else []
                    ),
                }
                for seg in segments
            ],
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        }
        return out

    def unload(self) -> None:
        # #memory: this cleared self._asr — an attribute FasterWhisperBackend
        # never assigns — so the actual model in self._model was never freed and
        # a warm faster-whisper stayed resident for the life of the process.
        # Clear the real handle so the model is released.
        self._model = None
        self._asr = None  # harmless if a subclass ever used it; keeps idempotence
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


# ── MLX Whisper (Apple Silicon optional) ────────────────────────────────────

# Default model for general transcription (dub pipeline etc.)
_MLX_MODEL_DEFAULT = "mlx-community/whisper-large-v3-mlx"
# Turbo model for dictation / capture — 5× faster, 0.8B params vs 1.5B.
_MLX_MODEL_TURBO = "mlx-community/whisper-large-v3-turbo"


class MLXWhisperBackend(ASRBackend):
    id = "mlx-whisper"
    display_name = "MLX Whisper (Apple Silicon CoreML)"
    gpu_compat = ("mps", "cpu")

    def __init__(self, model_name: str | None = None):
        self._model_name = model_name or os.environ.get(
            "ASR_MODEL", _MLX_MODEL_DEFAULT,
        )

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        # #390: shared platform gate FIRST — one rule for MLX-Audio + MLX-Whisper.
        # Returns False on Linux/Windows/mac-Intel before any package import, so
        # a stray mlx-whisper wheel never reports available or advertises `mps`.
        from core.device_caps import mlx_supported
        ok, why = mlx_supported()
        if not ok:
            return False, why
        try:
            import mlx_whisper  # noqa: F401
            return True, "ready"
        # Catch OSError/RuntimeError too, not just ImportError: in a
        # PyInstaller bundle mlx's native dylib/metallib can fail to load
        # even when the package imports, raising OSError/RuntimeError. We must
        # report unavailable (so the picker falls back) rather than crash the
        # registry scan (Wave 4.4).
        except (ImportError, OSError, RuntimeError) as e:
            return False, f"mlx-whisper unavailable: {e}"

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        import mlx_whisper
        logger.info(
            "MLX Whisper transcribing %s (model=%s, word_timestamps=%s)",
            audio_path, self._model_name, word_timestamps,
        )
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=self._model_name,
            word_timestamps=word_timestamps,
        )
        # Forced alignment, same as WhisperX (#1127). On Apple Silicon this
        # backend replaces WhisperX for dubbing — CTranslate2 has no Metal
        # build, so WhisperX transcribes on the CPU while this runs the *same*
        # whisper-large-v3 on the GPU. But lip-sync accuracy depends on
        # wav2vec2 word boundaries, not just on being fast, so we keep them:
        # Whisper's own timestamps are ±100-300 ms, the aligner's are ±10-30 ms.
        # Degrades gracefully — a language with no aligner keeps MLX's native
        # word timings rather than failing.
        if word_timestamps and result.get("segments"):
            result["segments"] = forced_align(
                result["segments"],
                _decode_audio_16k_mono(audio_path),
                result.get("language", "en"),
            )
        # Normalise to the `chunks` shape the rest of the pipeline expects.
        if "segments" in result:
            result["chunks"] = [
                {"text": seg.get("text", ""),
                 "timestamp": (seg.get("start"), seg.get("end"))}
                for seg in result["segments"]
            ]
        return result

    def warmup(self) -> None:
        """Eagerly load model weights into memory so first transcribe is instant.

        mlx_whisper internally caches via a class-level ModelHolder singleton.
        Calling ``load_model`` triggers the download (if needed) and loads
        weights onto the GPU — subsequent transcribe() calls hit the warm cache.
        """
        import time
        t0 = time.perf_counter()
        try:
            from mlx_whisper.transcribe import ModelHolder
            import mlx.core as mx
            # load_model populates the class-level singleton; after this call
            # the model is resident in unified memory.
            ModelHolder.get_model(self._model_name, dtype=mx.float16)
            dt = time.perf_counter() - t0
            logger.info("MLX Whisper model '%s' warmed up in %.1fs", self._model_name, dt)
        except Exception as e:
            dt = time.perf_counter() - t0
            logger.warning("MLX Whisper warmup failed after %.1fs: %s", dt, e)


# ── PyTorch Whisper fallback (CUDA / CPU via pipeline) ─────────────────────


class PyTorchWhisperBackend(ASRBackend):
    id = "pytorch-whisper"
    display_name = "PyTorch Whisper (CUDA / CPU via transformers pipeline)"
    # Pure transformers pipeline → runs wherever torch does (CUDA, MPS, CPU).
    # ROCm-via-HIP would also work but is left unclaimed pending verification.
    gpu_compat = ("cuda", "mps", "cpu")

    def __init__(self, asr_pipe=None):
        # Reuses the `_asr_pipe` attached to the TTS model when available.
        self._pipe = asr_pipe

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import transformers  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, f"transformers not installed: {e}"

    def _ensure_pipe(self):
        if self._pipe is not None:
            return
        # Build a standalone transformers Whisper pipeline on demand. This runs
        # on PyTorch's own stack (cuDNN 9 ships with torch), so it works as a
        # fallback on machines where WhisperX / faster-whisper can't load
        # cuDNN 8 (the `cudnn_ops_infer64_8.dll` failure, issue #255) — and it
        # needs neither OMNIVOICE_PRELOAD_TTS_ASR=1 nor a loaded TTS model.
        # When the TTS model already has an ASR head, dub_core passes it via the
        # constructor and this path is skipped.
        import torch
        from transformers import pipeline as hf_pipeline
        from services.model_manager import get_best_device

        model_name = os.environ.get(
            "OMNIVOICE_PYTORCH_ASR_MODEL", "openai/whisper-large-v3-turbo"
        )
        device = get_best_device()
        asr_dtype = torch.float16 if str(device).startswith("cuda") else torch.float32
        logger.info(
            "PyTorchWhisperBackend: loading standalone ASR pipeline %s on %s",
            model_name, device,
        )
        try:
            self._pipe = hf_pipeline(
                "automatic-speech-recognition",
                model=model_name,
                dtype=asr_dtype,
                device_map=device,
            )
        except Exception as e:
            # #549: an incomplete transformers install fails to build the ASR
            # pipeline (e.g. "Could not import module 'AutoFeatureExtractor'").
            # The raw error is opaque; re-raise with an actionable next step so
            # the toast tells the user how to recover instead of "no segments".
            raise RuntimeError(
                "transformers ASR pipeline failed to import (AutoFeatureExtractor) "
                "— your transformers install is incomplete; reinstall with "
                "`uv pip install --reinstall transformers`, or use faster-whisper "
                "(OmniVoice's default ASR) which avoids the transformers pipeline. "
                f"Underlying: {e}"
            ) from e

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        import soundfile as sf
        import torch
        self._ensure_pipe()
        audio_np, sr = sf.read(audio_path, dtype="float32")
        if audio_np.ndim > 1:
            audio_np = audio_np.mean(axis=1)
        bs = 16 if torch.cuda.is_available() else 2
        result = self._pipe(
            {"array": audio_np, "sampling_rate": sr},
            return_timestamps="word" if word_timestamps else True,
            chunk_length_s=15,
            batch_size=bs,
        )
        return result if isinstance(result, dict) else {"chunks": [], "raw": result}


# ── NeMo Parakeet TDT (NVIDIA — Open ASR Leaderboard SOTA, 25 langs) ────────


class NeMoASRBackend(ASRBackend):
    """NVIDIA Parakeet TDT via NeMo toolkit.

    FastConformer encoder + Token-and-Duration Transducer decoder.
    Beats Whisper large-v3 on English benchmarks (~6% WER).
    Supports 25 (mostly European) languages with auto language detection.
    CUDA or CPU — parakeet-tdt-0.6b-v3 measured RTF 0.08–0.23 on an Apple
    Silicon M2 *CPU* (2026-07-02), ~20× faster than faster-whisper large-v3
    int8 on the same host, so the old hard CUDA gate was a false claim.
    """
    id = "nemo-parakeet"
    gpu_compat = ("cuda", "cpu")
    display_name = "Parakeet TDT (NVIDIA NeMo — 25 langs, CUDA/CPU)"

    def __init__(self):
        self._model_name = os.environ.get(
            "ASR_MODEL_NEMO", "nvidia/parakeet-tdt-0.6b-v3"
        )
        self._model = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        # No CUDA gate: the 0.6B TDT model is comfortably faster than realtime
        # on CPU (see class docstring), so availability is a pure dependency
        # check and engine_routing picks the effective device from gpu_compat.
        try:
            import torch  # noqa: F401
        except ImportError:
            return False, "PyTorch not installed"
        try:
            import nemo.collections.asr  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, f"nemo_toolkit[asr] not installed: {e}"

    def _ensure_model(self):
        if self._model is not None:
            return
        import nemo.collections.asr as nemo_asr
        logger.info("NeMo loading %s", self._model_name)
        self._model = nemo_asr.models.ASRModel.from_pretrained(
            model_name=self._model_name
        )

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        self._ensure_model()
        logger.info(
            "NeMo Parakeet transcribing %s (word_timestamps=%s)",
            audio_path, word_timestamps,
        )
        outputs = self._model.transcribe(
            [audio_path], timestamps=word_timestamps
        )
        # NeMo returns a list of Hypothesis objects with .text and optional
        # .timestep / .alignments. Normalise to OmniVoice's expected shape.
        hyp = outputs[0] if outputs else None
        if hyp is None:
            return {"chunks": [], "segments": [], "language": "en"}

        text = hyp.text if hasattr(hyp, "text") else str(hyp)

        # Extract word-level timestamps if available
        words = []
        segments_out = []
        if word_timestamps and hasattr(hyp, "timestep") and hyp.timestep:
            try:
                # NeMo timestep format varies by model version
                ts = hyp.timestep
                if isinstance(ts, dict) and "word" in ts:
                    for w in ts["word"]:
                        words.append({
                            "word": w.get("char", w.get("word", "")),
                            "start": w.get("start_offset", 0),
                            "end": w.get("end_offset", 0),
                        })
            except Exception as e:
                logger.debug("NeMo timestamp extraction: %s", e)

        # Build a single segment from the full transcription
        # (NeMo doesn't natively split into VAD segments like Whisper)
        if text.strip():
            segments_out.append({
                "text": text,
                "start": words[0]["start"] if words else 0.0,
                "end": words[-1]["end"] if words else None,
                "words": words,
            })

        chunks = [
            {"text": seg["text"], "timestamp": (seg["start"], seg["end"])}
            for seg in segments_out
        ]
        return {
            "chunks": chunks,
            "segments": segments_out,
            "language": "en",  # Parakeet v3 auto-detects but doesn't expose it cleanly
        }

    def unload(self) -> None:
        self._model = None
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


# ── Moonshine (edge-optimized, variable-length — from ASR Leaderboard) ─────


class MoonshineASRBackend(ASRBackend):
    """Moonshine ASR via moonshine-voice or ONNX runtime.

    Optimized for edge/CPU deployment. Variable-length processing
    (no 30s padding waste like Whisper). Sub-200ms latency.
    Great for live capture and CPU-only environments.
    """
    id = "moonshine"
    gpu_compat = ("cpu",)  # edge/CPU-optimized by design
    display_name = "Moonshine (edge-optimized, ONNX)"

    def __init__(self):
        self._model_name = os.environ.get(
            "ASR_MODEL_MOONSHINE", "moonshine/base"
        )
        self._transcriber = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import moonshine_onnx  # noqa: F401
            return True, "ready (moonshine_onnx)"
        except ImportError:
            pass
        try:
            from moonshine_voice import Transcriber  # noqa: F401
            return True, "ready (moonshine_voice)"
        except ImportError:
            pass
        return False, (
            "moonshine not installed. Install with: "
            "uv pip install moonshine-onnx  (or moonshine-voice)"
        )

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        logger.info(
            "Moonshine transcribing %s (model=%s)",
            audio_path, self._model_name,
        )
        # Try moonshine_onnx first (lighter), then moonshine_voice
        try:
            import moonshine_onnx
            text = moonshine_onnx.transcribe(audio_path, model=self._model_name)
            if isinstance(text, list):
                text = " ".join(text)
        except ImportError:
            from moonshine_voice import Transcriber
            if self._transcriber is None:
                self._transcriber = Transcriber(model=self._model_name)
            text = self._transcriber.transcribe_file(audio_path)
            if isinstance(text, list):
                text = " ".join(text)

        # Moonshine returns plain text without timestamps in basic mode.
        # Build minimal segments structure.
        segments_out = []
        if text and text.strip():
            # Get audio duration for rough segment bounds
            try:
                import soundfile as sf
                info = sf.info(audio_path)
                duration = info.duration
            except Exception:
                duration = None

            segments_out.append({
                "text": text.strip(),
                "start": 0.0,
                "end": duration,
                "words": [],
            })

        chunks = [
            {"text": seg["text"], "timestamp": (seg["start"], seg["end"])}
            for seg in segments_out
        ]
        return {
            "chunks": chunks,
            "segments": segments_out,
            "language": "en",
        }

    def unload(self) -> None:
        self._transcriber = None


# ── sherpa-onnx live dictation (ONNX, CPU, streaming + offline) ─────────────


def _load_audio_16k_mono_f32(audio_path: str):
    """Decode any audio file to 16 kHz mono float32 in [-1, 1] for sherpa.

    Prefers soundfile (WAV/FLAC — the dictation buffers are already WAV) and
    resamples to 16 kHz when needed; falls back to OmniVoice's validated ffmpeg
    for containers soundfile can't read (WebM/Opus). 16 kHz is sherpa's cheapest
    feed; it resamples internally too, but doing it here keeps the contract tight.
    """
    import numpy as np
    try:
        import soundfile as sf
        data, sr = sf.read(audio_path, dtype="float32", always_2d=False)
        if getattr(data, "ndim", 1) > 1:
            data = data.mean(axis=1)
        data = np.ascontiguousarray(data, dtype=np.float32)
        if sr != 16000:
            # Lightweight linear resample — adequate for ASR features.
            n = int(round(len(data) * 16000 / sr))
            if n > 0:
                xp = np.linspace(0.0, 1.0, num=len(data), endpoint=False)
                x = np.linspace(0.0, 1.0, num=n, endpoint=False)
                data = np.interp(x, xp, data).astype(np.float32)
            sr = 16000
        return data, sr
    except Exception:
        # Container soundfile can't read (WebM/Opus) — use the validated ffmpeg
        # path, which already yields 16 kHz mono float32.
        return _decode_audio_16k_mono(audio_path), 16000


class SherpaDictationBackend(ASRBackend):
    """k2-fsa/sherpa-onnx ONNX dictation engine (CPU, live + offline).

    One :class:`ASRBackend` instance is bound to one of the seven sherpa
    dictation models (see :mod:`services.sherpa_dictation`). For the offline
    ``transcribe(path)`` contract it runs an ``OfflineRecognizer`` for offline
    models and a one-shot ``OnlineRecognizer`` decode for streaming models
    (so ``POST /transcribe`` works for every sherpa model). The *live* WS path
    drives the streaming recognizer incrementally — see ``capture_ws.py``.

    CPU provider only (cross-platform default-parity rule); no CUDA dep.
    """
    id = "sherpa-onnx-asr"
    display_name = "Sherpa-ONNX dictation (live, CPU — streaming + offline)"
    gpu_compat = ("cpu",)

    def __init__(self, model_id: str | None = None):
        from services import sherpa_dictation as _sd
        mid = model_id or os.environ.get(
            "OMNIVOICE_SHERPA_ASR_MODEL", _sd.DEFAULT_MODEL_ID
        )
        spec = _sd.get_spec(mid)
        if spec is None:
            raise ValueError(
                f"Unknown sherpa dictation model {mid!r}. Known: "
                f"{[s.id for s in _sd.list_specs()]}"
            )
        self._spec = spec
        self._rec = None  # lazy OfflineRecognizer / OnlineRecognizer
        # One backend is shared across live-dictation WS sessions (see
        # get_sherpa_dictation_backend), so guard the one-time recognizer build
        # against two sessions racing to construct it concurrently. Each session
        # still owns its own decode stream — only the recognizer is shared.
        self._rec_lock = threading.Lock()

    @property
    def spec(self):
        return self._spec

    @property
    def streaming(self) -> bool:
        return self._spec.streaming

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        from services.sherpa_dictation import sherpa_available
        return sherpa_available()

    def ensure_loaded(self) -> None:
        self._ensure_rec()

    def warmup(self) -> None:
        """Eagerly build the recognizer so the FIRST live-dictation session
        doesn't pay the 1.3–2.5s ONNX-session load (#888 'instant first
        dictation'). Called by the background capture-ASR preload; idempotent,
        and the built recognizer is reused across sessions via
        get_sherpa_dictation_backend (the same singleton the preload warms)."""
        self._ensure_rec()

    def _ensure_rec(self):
        if self._rec is not None:
            return
        with self._rec_lock:
            if self._rec is not None:
                return
            from services import sherpa_dictation as _sd
            if self._spec.streaming:
                self._rec = _sd.build_online_recognizer(self._spec)
            else:
                self._rec = _sd.build_offline_recognizer(self._spec)

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        self._ensure_rec()
        logger.info(
            "sherpa-onnx dictation transcribing %s (model=%s, kind=%s)",
            audio_path, self._spec.id, self._spec.kind,
        )
        samples, sr = _load_audio_16k_mono_f32(audio_path)
        if self._spec.streaming:
            text = self._decode_online_oneshot(samples, sr)
        else:
            text = self._decode_offline(samples, sr)
        return _sherpa_result(text, samples, sr)

    def _decode_offline(self, samples, sr) -> str:
        s = self._rec.create_stream()
        s.accept_waveform(sr, samples)
        self._rec.decode_stream(s)
        return (s.result.text or "").strip()

    def _decode_online_oneshot(self, samples, sr) -> str:
        """One-shot decode of a whole buffer through the streaming recognizer
        (for the non-streaming ``transcribe()`` / partial re-decode path)."""
        import numpy as np
        s = self._rec.create_stream()
        s.accept_waveform(sr, samples)
        tail = np.zeros(int(0.5 * sr), dtype=np.float32)
        s.accept_waveform(sr, tail)
        s.input_finished()
        while self._rec.is_ready(s):
            self._rec.decode_stream(s)
        return (self._rec.get_result(s) or "").strip()

    def unload(self) -> None:
        self._rec = None
        import gc
        gc.collect()


def _sherpa_result(text: str, samples, sr) -> dict:
    """Normalise a sherpa decode to OmniVoice's ``{chunks, segments, language,
    text}`` contract. sherpa gives plain text (no VAD split), so emit a single
    segment spanning the buffer — same shape Moonshine uses."""
    text = (text or "").strip()
    try:
        duration = round(len(samples) / float(sr), 3)
    except Exception:
        duration = None
    segments = []
    if text:
        segments.append({"text": text, "start": 0.0, "end": duration, "words": []})
    chunks = [{"text": s["text"], "timestamp": (s["start"], s["end"])} for s in segments]
    return {"chunks": chunks, "segments": segments, "language": "auto", "text": text}


# ── Registry ────────────────────────────────────────────────────────────────


# ── FunASR (SenseVoice — all-in-one multilingual, opt-in alternative, #182) ──

# SenseVoice emits rich tokens like `<|en|><|NEUTRAL|><|Speech|>` around the
# text; strip them when no postprocessor is applied.
_FUNASR_TAG_RE = re.compile(r"<\|[^|>]*\|>")


def _ms_to_s(value):
    """Milliseconds → seconds (FunASR reports ms). None on bad input."""
    try:
        return round(float(value) / 1000.0, 3)
    except (TypeError, ValueError):
        return None


def _clean_funasr_text(text):
    return _FUNASR_TAG_RE.sub("", str(text or "")).strip()


def _normalize_funasr(res) -> dict:
    """Normalise FunASR ``generate()`` output → OmniVoice's
    ``{chunks, segments, language}`` shape (the same one the Whisper backends
    return, consumed by ``services.segmentation``). Defensive about FunASR's
    output variations: prefers VAD ``sentence_info`` (ms timestamps + optional
    ``spk`` speaker id) and falls back to a single utterance from ``text``.
    Pure — testable without funasr installed.
    """
    item = (res[0] if isinstance(res, (list, tuple)) and res else res) or {}
    if not isinstance(item, dict):
        item = {"text": str(item)}
    language = item.get("language") or item.get("lang") or None

    segments = []
    for s in item.get("sentence_info") or []:
        if not isinstance(s, dict):
            continue
        txt = _clean_funasr_text(s.get("text", ""))
        if not txt:
            continue
        seg = {"text": txt, "start": _ms_to_s(s.get("start", 0)) or 0.0, "end": _ms_to_s(s.get("end"))}
        spk = s.get("spk")
        if spk is not None:
            seg["speaker"] = f"Speaker {int(spk) + 1}" if isinstance(spk, (int, float)) else str(spk)
        segments.append(seg)

    if not segments:
        txt = _clean_funasr_text(item.get("text", ""))
        if txt:
            ts = item.get("timestamp") or []  # [[start_ms, end_ms], ...]
            start = _ms_to_s(ts[0][0]) if ts else 0.0
            end = _ms_to_s(ts[-1][1]) if ts else None
            segments.append({"text": txt, "start": start or 0.0, "end": end})

    chunks = [{"text": seg["text"], "timestamp": (seg["start"], seg.get("end"))} for seg in segments]
    return {"chunks": chunks, "segments": segments, "language": language}


class FunASRBackend(ASRBackend):
    """FunASR — SenseVoiceSmall + FSMN-VAD. All-in-one multilingual ASR:
    transcription + punctuation across 50+ languages, with optional speaker
    diarization via the cam++ model. Opt-in alternative to WhisperX (issue
    #182); WhisperX remains the cross-platform default.
    """
    id = "funasr"
    gpu_compat = ("cuda", "cpu")  # FunASR: CUDA or CPU
    display_name = "FunASR (SenseVoice — 50+ languages, all-in-one)"

    def __init__(self):
        self._model_name = os.environ.get("ASR_MODEL_FUNASR", "iic/SenseVoiceSmall")
        self._vad_model = os.environ.get("ASR_FUNASR_VAD", "fsmn-vad")
        # cam++ speaker model → inline diarization (Phase 2). Set ASR_FUNASR_SPK=""
        # to disable and fall back to the dub pipeline's pyannote/heuristic path.
        self._spk_model = os.environ.get("ASR_FUNASR_SPK", "cam++")
        self._model = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import funasr  # noqa: F401
            return True, "ready"
        except ImportError:
            return False, "funasr not installed. Install with: uv pip install funasr"

    def _ensure_model(self):
        if self._model is not None:
            return
        from funasr import AutoModel
        kwargs = {"model": self._model_name, "vad_model": self._vad_model, "disable_update": True}
        if self._spk_model:
            kwargs["spk_model"] = self._spk_model
        logger.info("FunASR loading %s (vad=%s, spk=%s)", self._model_name, self._vad_model, self._spk_model or "off")
        self._model = AutoModel(**kwargs)

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        self._ensure_model()
        logger.info("FunASR transcribing %s", audio_path)
        res = self._model.generate(input=audio_path, cache={}, language="auto", use_itn=True)
        return _normalize_funasr(res)

    def unload(self) -> None:
        self._model = None
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


# ── OpenAI-compatible remote transcription (#877 — Qwen3-ASR / FunASR / any
#    compatible server, today, without waiting on transformers to catch up) ──
#
# transformers doesn't yet ship a stable Qwen3-ASR integration (issue #877),
# but a self-hosted Qwen3-ASR/FunASR/SenseVoice server exposing an
# OpenAI-compatible `POST /v1/audio/transcriptions` endpoint — or OpenAI's own
# Whisper API — is usable right now. This backend is a pure network client:
# no model runs locally, so it needs no install and claims no GPU.
#
# Settings mirror the LLM-providers convention exactly (services/
# llm_providers.py): base_url/model are plain settings_store text rows; the
# API key is Fernet-encrypted via settings_store.set_secret/get_secret — never
# a .env row, never echoed back to the client. Optional: some self-hosted
# servers (vLLM, LM Studio-style) don't check the key at all.

_ASR_OPENAI_COMPAT_BASE_URL_KEY = "asr.openai_compat.base_url"
_ASR_OPENAI_COMPAT_MODEL_KEY = "asr.openai_compat.model"
_ASR_OPENAI_COMPAT_SECRET_NAME = "asr_openai_compat_key"


def resolve_openai_compat_asr_base_url() -> str:
    from services import settings_store
    return (
        os.environ.get("ASR_OPENAI_COMPAT_BASE_URL")
        or settings_store.get_text(_ASR_OPENAI_COMPAT_BASE_URL_KEY)
        or ""
    )


def resolve_openai_compat_asr_model() -> str:
    from services import settings_store
    return (
        os.environ.get("ASR_OPENAI_COMPAT_MODEL")
        or settings_store.get_text(_ASR_OPENAI_COMPAT_MODEL_KEY)
        or "whisper-1"
    )


def resolve_openai_compat_asr_api_key() -> Optional[str]:
    """Env → encrypted stored key → None. Unlike LLM providers, no 'local'
    sentinel: many self-hosted transcription servers accept an empty/omitted
    Authorization header outright, so the OpenAI SDK is constructed with
    ``api_key="not-needed"`` (a non-empty placeholder the SDK requires) when
    this returns None, rather than treating a keyless server as unconfigured.
    """
    from services import settings_store
    return os.environ.get("ASR_OPENAI_COMPAT_API_KEY") or settings_store.get_secret(
        _ASR_OPENAI_COMPAT_SECRET_NAME
    )


def openai_compat_asr_has_key() -> bool:
    """Whether a key is configured, without ever decrypting it — mirrors
    llm_providers.has_key()'s no-plaintext-round-trip contract."""
    from services import settings_store
    if os.environ.get("ASR_OPENAI_COMPAT_API_KEY"):
        return True
    return _ASR_OPENAI_COMPAT_SECRET_NAME in settings_store.list_secret_names()


def probe_openai_compat_server(
    base_url: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
    *,
    timeout_s: float = 8.0,
) -> dict:
    """Cheap reachability probe for the Settings "Test connection" button.

    ``GET {base_url}/models`` — no audio is uploaded, no transcription runs.
    The Settings route probes the PERSISTED config (the panel saves first,
    then tests — same stale-config contract as /llm-providers/{id}/test);
    the optional arguments override it for programmatic/test use: ``None``
    falls back to the persisted setting, and for ``api_key`` an explicit
    ``""`` probes without a key (many self-hosted servers need none). Never
    raises, never logs or echoes the key; ``detail`` is passed through
    core.scrub so a leaked token or home path can't reach the UI.

    Returns ``{ok, status, latency_ms, http_status, models_count,
    model_found, detail}`` where ``status`` is a machine code the frontend
    maps to a translated message:

      not_configured   no base URL anywhere
      invalid_url      base URL without an http(s):// scheme
      ok               2xx — ``model_found`` says whether the configured
                       model appears in the server's list (None = unknown)
      ok_no_models     404/405/501 — reachable, but no /models endpoint
                       (some minimal transcription servers); transcription
                       may still work
      auth_failed      401/403 — the server rejected the key
      http_error       any other status (see ``http_status``)
      timeout          no answer within ``timeout_s``
      unreachable      connection failed (wrong port, server down, DNS…)
    """
    from time import perf_counter

    from core.scrub import scrub_text

    base = (base_url if base_url is not None else resolve_openai_compat_asr_base_url()).strip().rstrip("/")
    mdl = (model if model is not None else resolve_openai_compat_asr_model()).strip()
    if api_key is None:
        key = resolve_openai_compat_asr_api_key()
    else:
        key = api_key.strip() or None

    out: dict = {
        "ok": False,
        "status": "not_configured",
        "latency_ms": None,
        "http_status": None,
        "models_count": None,
        "model_found": None,
        "detail": None,
    }
    if not base:
        return out
    if not base.startswith(("http://", "https://")):
        out["status"] = "invalid_url"
        return out

    import httpx

    headers = {"Authorization": f"Bearer {key}"} if key else {}
    t0 = perf_counter()
    try:
        with httpx.Client(
            timeout=httpx.Timeout(timeout_s, connect=min(5.0, timeout_s)),
            follow_redirects=True,
        ) as client:
            resp = client.get(f"{base}/models", headers=headers)
    except httpx.TimeoutException as exc:
        out.update(
            status="timeout",
            latency_ms=round((perf_counter() - t0) * 1000.0, 1),
            detail=scrub_text(f"{type(exc).__name__}: {exc}"),
        )
        return out
    except Exception as exc:  # noqa: BLE001 — ConnectError, UnsupportedProtocol, SSL…
        out.update(
            status="unreachable",
            latency_ms=round((perf_counter() - t0) * 1000.0, 1),
            detail=scrub_text(f"{type(exc).__name__}: {exc}"),
        )
        return out

    out["latency_ms"] = round((perf_counter() - t0) * 1000.0, 1)
    out["http_status"] = resp.status_code

    if 200 <= resp.status_code < 300:
        out.update(ok=True, status="ok")
        try:
            data = resp.json()
            entries = data.get("data") if isinstance(data, dict) else data
            if isinstance(entries, list):
                ids = [e.get("id") for e in entries if isinstance(e, dict) and e.get("id")]
            else:
                ids = None
        except Exception:  # noqa: BLE001 — non-JSON 200 still proves reachability
            ids = None
        if ids is not None:
            out["models_count"] = len(ids)
            out["model_found"] = mdl in ids if mdl else None
        return out

    if resp.status_code in (401, 403):
        out["status"] = "auth_failed"
    elif resp.status_code in (404, 405, 501):
        # Reachable server without a /models endpoint — the transcription
        # route may still work, so this is a (qualified) success.
        out.update(ok=True, status="ok_no_models")
    else:
        out["status"] = "http_error"
        out["detail"] = scrub_text((resp.text or "")[:300]) or None
    return out


class OpenAICompatASRBackend(ASRBackend):
    """Remote transcription via any OpenAI-compatible server.

    Adapts whatever the server returns into this module's expected shape.
    Prefers `response_format="verbose_json"` for real per-segment timestamps
    (OpenAI's own API and most compatible servers support it); falls back to
    plain text with rough single-segment bounds — mirroring
    MoonshineASRBackend's degraded shape — for minimal servers that reject it.
    """
    id = "openai-compat-asr"
    display_name = "OpenAI-compatible (remote server)"
    gpu_compat = ("cpu",)  # network client only — no local compute

    def __init__(self):
        self._base_url = resolve_openai_compat_asr_base_url()
        self._model = resolve_openai_compat_asr_model()

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        if not resolve_openai_compat_asr_base_url():
            return False, "Configure a server endpoint in Settings → Engines"
        try:
            import openai  # noqa: F401
        except ImportError:
            return False, "openai package not installed. Install with: uv pip install openai"
        return True, "ready"

    def _client(self):
        from openai import OpenAI
        api_key = resolve_openai_compat_asr_api_key() or "not-needed"
        # max_retries=0: mirrors llm_skills.resolve_skill_client — a
        # rate-limited/slow server retrying inside the SDK would blow past
        # whatever bounded timeout the caller (dub transcribe, dictation)
        # expects from a single call.
        return OpenAI(base_url=self._base_url, api_key=api_key, max_retries=0)

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        logger.info(
            "OpenAI-compat ASR transcribing %s (base_url=%s, model=%s)",
            audio_path, self._base_url, self._model,
        )
        client = self._client()
        try:
            with open(audio_path, "rb") as f:
                try:
                    resp = client.audio.transcriptions.create(
                        file=f, model=self._model, response_format="verbose_json",
                    )
                except Exception:
                    # Minimal/older compatible servers reject verbose_json
                    # outright — retry plain before treating it as a real
                    # failure. Re-open: the SDK may have partially consumed
                    # the file handle on the first attempt.
                    f.seek(0)
                    resp = client.audio.transcriptions.create(
                        file=f, model=self._model, response_format="json",
                    )
        except Exception as exc:
            # Never leak a raw SDK/httpx exception object (auth headers,
            # connection internals) straight into a user-facing message —
            # same convention as generation.py's _safe_exc_text (#977 class).
            raise RuntimeError(
                f"OpenAI-compatible ASR server at {self._base_url!r} failed: "
                f"{type(exc).__name__}: {exc}"
            ) from exc
        return self._adapt_response(resp)

    @staticmethod
    def _adapt_response(resp) -> dict:
        segments_out = []
        # verbose_json: resp.segments is a list of objects with start/end/text.
        raw_segments = getattr(resp, "segments", None)
        if raw_segments:
            for seg in raw_segments:
                seg_dict = seg if isinstance(seg, dict) else seg.model_dump()
                segments_out.append({
                    "text": (seg_dict.get("text") or "").strip(),
                    "start": seg_dict.get("start", 0.0),
                    "end": seg_dict.get("end", 0.0),
                    "words": [],  # word-level timing isn't part of this API
                })
        else:
            # Plain text response (json/text format) — single-segment shape,
            # matching MoonshineASRBackend's degraded fallback exactly.
            text = (getattr(resp, "text", None) or "").strip()
            if text:
                segments_out.append({"text": text, "start": 0.0, "end": None, "words": []})
        chunks = [
            {"text": seg["text"], "timestamp": (seg["start"], seg["end"])}
            for seg in segments_out
        ]
        language = getattr(resp, "language", None) or "en"
        return {"chunks": chunks, "segments": segments_out, "language": language}


def _isolated_faster_whisper():
    """Lazy import so the subprocess_asr → subprocess_backend chain isn't
    pulled in at registry definition time."""
    from services.subprocess_asr import IsolatedFasterWhisperBackend
    return IsolatedFasterWhisperBackend


class _LazyASRRegistry(dict):
    """Registry with one lazily-resolved entry (Wave 4.2). Mirrors the TTS
    registry's lazy pattern so listing/selecting the crash-isolated ASR
    backend doesn't import the subprocess stack unless it's used."""

    _LAZY = {"faster-whisper-isolated": _isolated_faster_whisper}

    def __contains__(self, key):
        return dict.__contains__(self, key) or key in self._LAZY

    def __getitem__(self, key):
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        if key in self._LAZY:
            cls = self._LAZY[key]()
            self[key] = cls
            return cls
        raise KeyError(key)

    def __iter__(self):
        seen = set()
        # Snapshot the live keys before yielding — see _LazyRegistry.__iter__ in
        # tts_backend.py. A concurrent lazy __getitem__ inserts into self, and
        # list_backends() runs in a FastAPI threadpool, so a *live* dict iterator
        # held open across the per-engine is_available() probes would raise
        # "dictionary changed size during iteration". list() consumes it
        # atomically under the GIL, closing the window.
        for k in list(dict.__iter__(self)):
            seen.add(k)
            yield k
        for k in self._LAZY:
            if k not in seen:
                yield k

    def items(self):
        for k in self:
            yield k, self[k]


_REGISTRY: dict[str, type[ASRBackend]] = _LazyASRRegistry({
    "whisperx":        WhisperXBackend,
    "faster-whisper":  FasterWhisperBackend,
    "mlx-whisper":     MLXWhisperBackend,
    "pytorch-whisper": PyTorchWhisperBackend,
    "nemo-parakeet":   NeMoASRBackend,
    "moonshine":       MoonshineASRBackend,
    "funasr":          FunASRBackend,
    "sherpa-onnx-asr": SherpaDictationBackend,
    "openai-compat-asr": OpenAICompatASRBackend,
    # "faster-whisper-isolated": resolved lazily (crash-isolated subprocess).
})


# Short install hints surfaced as tooltips on the Settings → Engines UI
# (parity with tts_backend._INSTALL_HINTS).
_INSTALL_HINTS: dict[str, str] = {
    "whisperx":        "pip install whisperx  (CTranslate2 + wav2vec2 alignment; CUDA or CPU)",
    "faster-whisper":  "pip install faster-whisper  (CTranslate2; cross-platform, CUDA or CPU)",
    "mlx-whisper":     "pip install mlx-whisper  (Apple Silicon only)",
    "pytorch-whisper": "Bundled with transformers — no extra install (CUDA/MPS/CPU)",
    "nemo-parakeet":   (
        "No safe install path in this app yet — nemo_toolkit's ASR extras pin "
        "transformers>=4.57,<4.58, which conflicts with OmniVoice's own "
        "transformers>=5.3 requirement and WILL break the backend "
        "(ImportError on startup) if installed into this shared venv. Do NOT "
        "install nemo_toolkit here. If you want to try Parakeet TDT, set it "
        "up in a separate/dedicated Python environment — not the one "
        "OmniVoice manages; in-app isolation for this engine is tracked "
        "separately."
    ),
    "moonshine":       "pip install useful-moonshine  (edge/CPU-optimized ASR)",
    "funasr":          "pip install funasr  (SenseVoiceSmall + FSMN-VAD; CUDA or CPU)",
    "sherpa-onnx-asr": "uv add sherpa-onnx  (ONNX live dictation; CPU, cross-platform)",
    "openai-compat-asr": (
        "No install needed — configure a server endpoint in Settings → "
        "Engines. Points OmniVoice at any OpenAI-compatible transcription "
        "server (a self-hosted Qwen3-ASR/FunASR/SenseVoice server, OpenAI's "
        "own Whisper API, or similar) — a path to Qwen3-ASR today, without "
        "waiting on a direct transformers integration."
    ),
    "faster-whisper-isolated": (
        "No extra install (reuses faster-whisper). Escape hatch for hanging "
        "transcribes: runs ASR in a separate process that can be force-killed "
        "to reclaim a hung transcribe and its VRAM (#730). Slightly slower per "
        "call than in-process faster-whisper."
    ),
}

# Most-recent failure per backend, so a transient probe error survives between
# Settings refreshes (parity with tts_backend._LAST_ERRORS).
_LAST_ERRORS: dict[str, str] = {}


def list_backends() -> list[dict]:
    """Enumerate every ASR backend with the **same 11-key shape as TTS** so the
    Engine Compatibility Matrix renders all families uniformly.

    Per-entry: id, display_name, available, reason (scrubbed), install_hint,
    last_error, isolation_mode, gpu_compat, effective_device, routing_status,
    routing_reason. A backend whose ``is_available()`` raises is reported
    ``available: false`` (never a 500), exactly like TTS.
    """
    from core.device_caps import detect_host_caps
    from core.scrub import scrub_text
    from services.engine_routing import routing_fields
    caps = detect_host_caps()

    out: list[dict] = []
    for bid, cls in _REGISTRY.items():
        try:
            ok, msg = cls.is_available()
        except Exception as exc:
            ok = False
            msg = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "asr list_backends: %s.is_available() raised — degrading "
                "gracefully so the picker still renders: %s", bid, msg,
            )
        if ok:
            _LAST_ERRORS.pop(bid, None)
        else:
            _LAST_ERRORS[bid] = scrub_text(msg)
        isolation = "subprocess" if getattr(cls, "_is_subprocess_isolated", False) else "in-process"
        gpu_compat = getattr(cls, "gpu_compat", ("cpu",))
        out.append({
            "id": bid,
            "display_name": cls.display_name,
            "available": ok,
            # ASR previously emitted `reason` UNMASKED — scrub it now (closes a
            # pre-existing token-leak gap, matching TTS's redaction guarantee).
            "reason": None if ok else scrub_text(msg),
            "install_hint": _INSTALL_HINTS.get(bid),
            "last_error": _LAST_ERRORS.get(bid),
            "isolation_mode": isolation,
            "gpu_compat": list(gpu_compat),
            **routing_fields(gpu_compat, caps),
        })
    return out


def _probe_available(cls) -> bool:
    """``is_available()`` that never raises. A probe that explodes (e.g. a native
    lib that refuses to load — CTranslate2's exec-stack rejection, #692) means the
    engine is unusable on this host, so treat it as unavailable and fall through
    to the next candidate rather than crash engine selection."""
    try:
        ok, _ = cls.is_available()
        return bool(ok)
    except Exception:  # noqa: BLE001
        logger.warning(
            "ASR auto-detect: %s.is_available() raised — treating as unavailable",
            cls.__name__, exc_info=True,
        )
        return False


def _mps_available() -> bool:
    try:
        import torch

        return bool(hasattr(torch.backends, "mps") and torch.backends.mps.is_available())
    except Exception:  # noqa: BLE001 — no torch / no MPS
        return False


def _auto_detect() -> str:
    """Pick the best available ASR engine **for this hardware**.

    The order used to be whisperx-first, unconditionally — and that quietly cost
    Apple Silicon users a 4.4x slowdown on every dub (#1127). WhisperX and
    faster-whisper are CTranslate2, which has **no Metal backend**: on a Mac they
    transcribe on the *CPU*, no matter what GPU is sitting there. Measured on an
    M2, one 30 s dub chunk, whisper-large-v3: **90.4 s on WhisperX (CPU) vs 20.5 s
    on MLX (GPU)** — 3x slower than realtime, which is how a 16-minute video turned
    into a ~48-minute transcribe and looked like a hang.

    So the pick is device-aware:

      1. mlx-whisper    — **Apple Silicon only.** Runs the *same* whisper-large-v3
                          on the GPU, and we layer WhisperX's wav2vec2 forced
                          alignment on top (see MLXWhisperBackend.transcribe), so
                          word timing — and therefore lip-sync — is unchanged.
                          Same model, same alignment, ~4x the speed.
      2. whisperx       — everywhere else: faster-whisper + wav2vec2 forced
                          alignment (±10-30 ms word timing). On CUDA it uses the
                          GPU, so it remains the right default there.
      3. faster-whisper — transcription only (no forced alignment); safe fallback
                          when whisperx isn't installed.
      4. pytorch-whisper — last resort; requires the TTS model to be loaded so it
                          can reuse `_asr_pipe`.

    Auto-detect only. An explicit ``OMNIVOICE_ASR_BACKEND`` or the ``asr_backend``
    pref still wins, so anyone who pinned an engine keeps it.
    """
    if _mps_available() and _probe_available(MLXWhisperBackend):
        return "mlx-whisper"
    if _probe_available(WhisperXBackend):
        return "whisperx"
    if _probe_available(FasterWhisperBackend):
        return "faster-whisper"
    return "pytorch-whisper"


def active_backend_id() -> str:
    explicit = os.environ.get("OMNIVOICE_ASR_BACKEND")
    if explicit:
        return explicit
    from core import prefs
    picked = prefs.get("asr_backend")
    if picked:
        return picked
    return _auto_detect()


# Subprocess-isolated backends must be process-wide singletons: their
# ``__init__`` registers an atexit shutdown hook and the instance owns the
# sidecar child process, so a fresh instance per request would leak handler
# entries and respawn the sidecar (reloading its model) on every transcribe.
# Same rationale as api.routers.engines._ENGINE_INSTANCES.
_ISOLATED_INSTANCES: dict[str, "ASRBackend"] = {}


def get_active_asr_backend(*, asr_pipe=None) -> ASRBackend:
    bid = active_backend_id()
    if bid == "pytorch-whisper":
        return PyTorchWhisperBackend(asr_pipe=asr_pipe)
    if bid == "mlx-whisper":
        return MLXWhisperBackend()
    if bid == "faster-whisper":
        return FasterWhisperBackend()
    if bid == "whisperx":
        return WhisperXBackend()
    if bid not in _REGISTRY:
        raise ValueError(f"Unknown ASR backend: {bid!r}. Known: {list(_REGISTRY)}")
    cls = _REGISTRY[bid]
    if getattr(cls, "_is_subprocess_isolated", False):
        inst = _ISOLATED_INSTANCES.get(bid)
        if inst is None:
            inst = cls()
            _ISOLATED_INSTANCES[bid] = inst
        return inst
    return cls()


# ── Reference-transcript cache (#1032) ──────────────────────────────────────
# `get_active_asr_backend()` returns a FRESH backend instance per call for the
# whisper family, so every `transcribe_reference` used to reload whisper
# weights from scratch — a multi-second (CPU: tens of seconds) hit on EVERY
# /generate whose reference clip has no stored transcript (#308 introduced the
# call; profiles saved without a transcript hit it per request). The reference
# audio is identical across those requests, so cache the *transcript* keyed by
# the file's content hash: no model or VRAM is held, repeated generates with
# the same clip skip ASR entirely. Bounded LRU; failures (None) are never
# cached so a transient ASR problem still retries next request.
_REF_TRANSCRIPT_CACHE_MAX = 64
_ref_transcript_cache: "OrderedDict[str, str]" = OrderedDict()
_ref_transcript_lock = threading.Lock()


def _ref_audio_fingerprint(audio_path: str) -> str | None:
    """sha256 of the clip's bytes, or None when unreadable (→ no caching).

    Content-keyed (not path-keyed) because ad-hoc clone uploads land in a new
    NamedTemporaryFile per request — the path changes, the bytes don't.
    Reference clips are seconds long, so hashing is negligible next to ASR."""
    import hashlib
    try:
        h = hashlib.sha256()
        with open(audio_path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def transcribe_reference(audio_path: str) -> str | None:
    """Transcribe a voice-clone reference clip with the active ASR backend.

    Voice cloning without a user-supplied transcript used to fall through to
    ``OmniVoice.load_asr_model()`` — a transformers ``pipeline()`` load of
    whisper-large-v3-turbo that fails outright on transformers 5.3 (#308),
    even when whisperx / faster-whisper / mlx-whisper are installed and
    working. Route the reference transcript through the registry instead, so
    the model-attached pipeline is only reached when it is genuinely the last
    resort. Returns ``None`` on any failure — callers pass ``ref_text=None``
    through and the model's built-in fallback still gets its chance.

    Results are cached by audio content (#1032) — see the cache notes above.
    """
    fingerprint = _ref_audio_fingerprint(audio_path)
    if fingerprint is not None:
        with _ref_transcript_lock:
            cached = _ref_transcript_cache.get(fingerprint)
            if cached is not None:
                _ref_transcript_cache.move_to_end(fingerprint)
                return cached
    try:
        backend = get_active_asr_backend()
    except Exception as e:  # noqa: BLE001 — never let ASR break generation
        logger.warning("transcribe_reference: no ASR backend available (%s)", e)
        return None
    if isinstance(backend, PyTorchWhisperBackend):
        # The registry fell through to the model-attached pipeline; let the
        # model load it lazily rather than constructing a second copy here.
        return None
    try:
        result = backend.transcribe(audio_path, word_timestamps=False)
    except Exception as e:  # noqa: BLE001 — degrade to the model fallback
        logger.warning(
            "transcribe_reference: %s failed (%s) — deferring to the model's "
            "built-in ASR fallback",
            backend.id, e,
        )
        return None
    result = result or {}
    text = result.get("text") or " ".join(
        (seg.get("text") or "").strip() for seg in result.get("segments", [])
    )
    text = (text or "").strip()
    if text and fingerprint is not None:
        with _ref_transcript_lock:
            _ref_transcript_cache[fingerprint] = text
            _ref_transcript_cache.move_to_end(fingerprint)
            while len(_ref_transcript_cache) > _REF_TRANSCRIPT_CACHE_MAX:
                _ref_transcript_cache.popitem(last=False)
    return text or None


_capture_backend: ASRBackend | None = None
# The sherpa model id the cached capture backend was built for, so a model
# switch in Settings rebuilds the singleton instead of serving the old model.
_capture_backend_key: str | None = None
# Guards the read-modify-write of the two globals above. Both the background
# capture-ASR preload (runs in the GPU-pool thread) and the live-dictation WS
# handlers (run on the event loop) resolve/replace the singleton, so the
# check-then-build must be atomic to avoid two threads each building a model.
_capture_backend_lock = threading.Lock()

# ── Idle release of the warm capture/dictation ASR (#1101 class) ────────────
#
# The TTS model has always been idle-unloaded (model_manager.idle_worker), but
# the capture ASR singleton above was not: once you dictated even once, its
# model stayed resident for the life of the process. Measured on a 16 GB M2:
# the backend sits at ~6.2 GB idle — TTS 3.8 GB plus ~2 GB of warm ASR — while
# an actual generate costs only ~116 MB on top. That baseline, not any spike, is
# what pushes a 16 GB machine into memory pressure until the OS kills the
# backend mid-generate — the death behind #1076/#1092/#1093/#1101. Freeing
# 3.8 GB of TTS while silently holding 2 GB of ASR forever was the asymmetry.
#
# Reclaiming it costs a model re-warm on the next dictation (~1.4 s for
# mlx-whisper turbo) and only after a full idle timeout — the same bargain the
# TTS model already makes.
_capture_last_used: float = 0.0
# Live dictation streams hold the singleton for the WHOLE session while calling
# nothing that would refresh `_capture_last_used`, so a long session could have
# its model unloaded mid-sentence. A lease pins it for exactly that window.
_capture_leases: int = 0


def _touch_capture() -> None:
    """Mark the capture backend as used now (resets its idle clock)."""
    global _capture_last_used
    _capture_last_used = time.monotonic()


@contextlib.contextmanager
def capture_lease():
    """Pin the warm capture backend for the duration of a live session, so the
    idle reaper can never unload the model out from under an open dictation
    stream. Releasing the lease restarts the idle clock."""
    global _capture_leases
    with _capture_backend_lock:
        _capture_leases += 1
    try:
        yield
    finally:
        with _capture_backend_lock:
            _capture_leases = max(0, _capture_leases - 1)
        _touch_capture()


def release_idle_capture_backend(idle_s: float, *, now: float | None = None) -> bool:
    """Unload the warm capture/dictation ASR once it has gone unused for
    ``idle_s`` seconds. Returns True when a model was actually released.

    No-ops while a live session holds a lease, when nothing is loaded, or when
    the model was used recently. Never raises — a failed unload must not take
    the idle worker down with it."""
    global _capture_backend, _capture_backend_key
    now = time.monotonic() if now is None else now
    with _capture_backend_lock:
        if _capture_backend is None or _capture_leases > 0:
            return False
        if now - _capture_last_used < idle_s:
            return False
        backend, _capture_backend, _capture_backend_key = _capture_backend, None, None
    try:
        backend.unload()
    except Exception:  # noqa: BLE001 — a stuck unload must not kill idle_worker
        logger.warning("capture ASR unload failed", exc_info=True)
    logger.info(
        "Idle timeout reached. Unloading capture ASR (%s) to free memory.",
        type(backend).__name__,
    )
    return True


def get_sherpa_dictation_backend(model_id: str) -> "SherpaDictationBackend":
    """Return a shared, warm-cached :class:`SherpaDictationBackend` for
    ``model_id``, building it at most once and reusing the recognizer across
    live-dictation WS sessions.

    Live sessions previously constructed a FRESH backend per WebSocket connect,
    so every session reloaded the ONNX recognizer (1.3–2.5s "loading…") and the
    #888 background preload was a no-op. This reuses the SAME module-level
    ``_capture_backend`` singleton the preload warms (when the ids match), and
    rebuilds on a model switch — identical invalidation to
    :func:`get_capture_asr_backend`. Thread-safe: the recognizer is shared;
    each session creates its own decode stream (see capture_ws)."""
    global _capture_backend, _capture_backend_key
    _touch_capture()  # any handout resets the idle clock
    with _capture_backend_lock:
        if (isinstance(_capture_backend, SherpaDictationBackend)
                and _capture_backend_key == model_id):
            return _capture_backend
        backend = SherpaDictationBackend(model_id=model_id)
        _capture_backend = backend
        _capture_backend_key = model_id
        return backend


def dictation_model_id() -> str | None:
    """The selected sherpa dictation model id, or None when dictation is off /
    no sherpa model is chosen. Env var wins (power-user pin), then prefs."""
    explicit = os.environ.get("OMNIVOICE_SHERPA_ASR_MODEL")
    if explicit:
        return explicit
    try:
        from core import prefs
        if not prefs.get("dictation.enabled", True):
            return None
        mid = prefs.get("dictation.model_id")
    except Exception:
        return None
    from services.sherpa_dictation import is_sherpa_model
    return mid if is_sherpa_model(mid) else None


def get_capture_asr_backend() -> ASRBackend:
    """Pick the fastest ASR engine for capture / dictation.

    Selection order:

      0. sherpa-onnx dictation — when ``dictation.model_id`` names one of the
         seven sherpa models (live/CPU; the new live-dictation path).
      1. mlx-whisper Turbo     — Apple Silicon, ~5× faster than large-v3
      2. mlx-whisper large     — still native Metal, faster than CPU int8
      3. faster-whisper        — cross-platform CTranslate2 fallback
      4. pytorch-whisper       — last resort

    The caller should also pass ``word_timestamps=False`` to the returned
    backend to skip per-word timing and shave another ~30% latency.

    Returns a cached singleton so the model stays warm between calls; the
    singleton is rebuilt if the selected sherpa model changes.
    """
    global _capture_backend, _capture_backend_key

    _touch_capture()  # any handout resets the idle clock (#1101 class)
    # Atomic resolve+build so the preload thread and a WS session (which may
    # call get_sherpa_dictation_backend concurrently) can't both build a model.
    with _capture_backend_lock:
        # 0. Honor an explicit sherpa dictation model selection.
        sherpa_id = dictation_model_id()
        if sherpa_id:
            ok, _ = SherpaDictationBackend.is_available()
            if ok:
                if not (isinstance(_capture_backend, SherpaDictationBackend)
                        and _capture_backend_key == sherpa_id):
                    try:
                        _capture_backend = SherpaDictationBackend(model_id=sherpa_id)
                        _capture_backend_key = sherpa_id
                    except Exception as e:  # noqa: BLE001 — fall through to Whisper
                        logger.warning(
                            "sherpa dictation model %r unavailable (%s) — falling "
                            "back to Whisper capture engine", sherpa_id, e,
                        )
                        _capture_backend = None
                        _capture_backend_key = None
                if _capture_backend is not None:
                    return _capture_backend
            else:
                logger.info(
                    "dictation.model_id=%r selected but sherpa-onnx not installed — "
                    "falling back to Whisper capture engine", sherpa_id,
                )

        if _capture_backend is not None and _capture_backend_key is None:
            return _capture_backend

        # Prefer MLX Turbo on Apple Silicon
        ok, _ = MLXWhisperBackend.is_available()
        if ok:
            _capture_backend = MLXWhisperBackend(model_name=_MLX_MODEL_TURBO)
            _capture_backend_key = None
            return _capture_backend

        # Fall back to faster-whisper (CPU int8 on non-Apple)
        ok, _ = FasterWhisperBackend.is_available()
        if ok:
            _capture_backend = FasterWhisperBackend()
            _capture_backend_key = None
            return _capture_backend

        # Last resort
        _capture_backend = PyTorchWhisperBackend()
        _capture_backend_key = None
        return _capture_backend
