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

import logging
import os
from abc import ABC, abstractmethod
from typing import Optional

logger = logging.getLogger("omnivoice.asr")


# ── Protocol ────────────────────────────────────────────────────────────────


class ASRBackend(ABC):
    id: str = "base"
    display_name: str = "Base ASR"

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


# ── WhisperX (cross-platform default — forced-alignment word timing) ────────


class WhisperXBackend(ASRBackend):
    id = "whisperx"
    display_name = "WhisperX (faster-whisper + wav2vec2 forced alignment)"

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

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import whisperx  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, f"whisperx not installed: {e}"

    def _ensure_asr(self):
        if self._asr is not None:
            return
        import whisperx
        import torch
        logger.info(
            "whisperx loading ASR %s on %s (%s)",
            self._model_name, self._device, self._compute_type,
        )
        # PyTorch 2.6 flipped `torch.load(weights_only=True)` to default,
        # which breaks pyannote 3.x's VAD checkpoint (that whisperx ships):
        # each load surfaces a different missing global — `omegaconf.*`,
        # `typing.Any`, etc. The VAD file ships inside the whisperx wheel,
        # so it's as trusted as whisperx itself. Two-layer defence:
        #   (a) allowlist the known pickle globals so the secure load path
        #       actually succeeds, and
        #   (b) monkey-patch `torch.load` to force `weights_only=False` as
        #       a belt-and-braces fallback for anything we missed.
        self._allow_vad_pickle_globals()
        import torch.serialization as _ts
        _orig_top   = torch.load
        _orig_inner = _ts.load
        def _patched(*args, **kwargs):
            # Force — Lightning explicitly passes weights_only=True, so a
            # setdefault wouldn't override it. The VAD pickle ships in the
            # whisperx wheel; trust is the same as trusting whisperx itself.
            kwargs["weights_only"] = False
            return _orig_inner(*args, **kwargs)
        torch.load = _patched
        _ts.load   = _patched
        try:
            self._asr = whisperx.load_model(
                self._model_name,
                device=self._device,
                compute_type=self._compute_type,
                # vad_method="silero" is the default; keep it so short gaps
                # get cleaned up before transcription.
            )
        finally:
            torch.load = _orig_top
            _ts.load   = _orig_inner

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
        # omegaconf config containers — the immediate cause of the error
        # pyannote's VAD emits (`GLOBAL omegaconf.listconfig.ListConfig`).
        try:
            from omegaconf.listconfig import ListConfig
            from omegaconf.dictconfig import DictConfig
            from omegaconf.base import ContainerMetadata, Metadata
            allow += [ListConfig, DictConfig, ContainerMetadata, Metadata]
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
        if allow:
            try:
                add(allow)
            except Exception as e:
                logger.debug("add_safe_globals failed (harmless): %s", e)

    def _get_align(self, language_code: str):
        """Lazy-load the wav2vec2 alignment model for this language. WhisperX
        bundles aligners for ~20 major languages; for the others we fall back
        to faster-whisper's native word timestamps (already in result)."""
        if language_code in self._align_cache:
            return self._align_cache[language_code]
        import whisperx
        try:
            model, metadata = whisperx.load_align_model(
                language_code=language_code, device=self._device,
            )
            self._align_cache[language_code] = (model, metadata)
            return model, metadata
        except Exception as e:
            logger.info(
                "whisperx: no alignment model for language=%r (%s); "
                "falling back to Whisper's native word timestamps",
                language_code, e,
            )
            self._align_cache[language_code] = None
            return None

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        import whisperx
        self._ensure_asr()
        logger.info("whisperx transcribing %s (word_timestamps=%s)", audio_path, word_timestamps)
        audio = whisperx.load_audio(audio_path)
        result = self._asr.transcribe(audio)
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


# ── Faster-Whisper (cross-platform fallback) ────────────────────────────────


class FasterWhisperBackend(ASRBackend):
    id = "faster-whisper"
    display_name = "Faster-Whisper (CTranslate2 — Linux/Windows/macOS)"

    def __init__(self):
        # Defaulting to the CTranslate2-converted large-v3 repo. Matches
        # KNOWN_MODELS in api/routers/setup.py so the first-run wizard
        # downloads what the backend will actually load.
        self._model_name = os.environ.get(
            "ASR_MODEL_FASTER", "Systran/faster-whisper-large-v3"
        )
        self._model = None  # lazy — first transcribe() loads weights

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import faster_whisper  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, f"faster-whisper not installed: {e}"

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
        self._model = WhisperModel(
            self._model_name, device=device, compute_type=compute_type
        )

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


# ── MLX Whisper (Apple Silicon optional) ────────────────────────────────────


class MLXWhisperBackend(ASRBackend):
    id = "mlx-whisper"
    display_name = "MLX Whisper (Apple Silicon CoreML)"

    def __init__(self):
        self._model_name = os.environ.get("ASR_MODEL", "mlx-community/whisper-large-v3-mlx")

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import torch
            if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
                return False, "Apple Silicon (MPS) not available."
            import mlx_whisper  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, f"mlx-whisper not installed: {e}"

    def transcribe(self, audio_path: str, *, word_timestamps: bool = True) -> dict:
        import mlx_whisper
        logger.info("MLX Whisper transcribing %s (word_timestamps=%s)", audio_path, word_timestamps)
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=self._model_name,
            word_timestamps=word_timestamps,
        )
        # Normalise to the `chunks` shape the rest of the pipeline expects.
        if "segments" in result and "chunks" not in result:
            result["chunks"] = [
                {"text": seg["text"], "timestamp": (seg["start"], seg["end"])}
                for seg in result["segments"]
            ]
        return result


# ── PyTorch Whisper fallback (CUDA / CPU via pipeline) ─────────────────────


class PyTorchWhisperBackend(ASRBackend):
    id = "pytorch-whisper"
    display_name = "PyTorch Whisper (CUDA / CPU via transformers pipeline)"

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
        # Fall back to grabbing the TTS model's ASR head.
        import asyncio
        from services.model_manager import get_model
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                raise RuntimeError(
                    "PyTorchWhisperBackend needs the ASR pipe — pass it via constructor "
                    "when calling from an async context."
                )
            model = loop.run_until_complete(get_model())
        except RuntimeError:
            model = asyncio.run(get_model())
        self._pipe = getattr(model, "_asr_pipe", None)
        if self._pipe is None:
            raise RuntimeError("Loaded TTS model has no `_asr_pipe` attribute.")

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


# ── Registry ────────────────────────────────────────────────────────────────


_REGISTRY: dict[str, type[ASRBackend]] = {
    "whisperx":        WhisperXBackend,
    "faster-whisper":  FasterWhisperBackend,
    "mlx-whisper":     MLXWhisperBackend,
    "pytorch-whisper": PyTorchWhisperBackend,
}


def list_backends() -> list[dict]:
    out = []
    for bid, cls in _REGISTRY.items():
        ok, msg = cls.is_available()
        out.append({
            "id": bid,
            "display_name": cls.display_name,
            "available": ok,
            "reason": None if ok else msg,
        })
    return out


def _auto_detect() -> str:
    """Pick the best available ASR engine for the current hardware.

    Preference order:
      1. whisperx       — faster-whisper transcription + wav2vec2 forced
                          alignment (±10-30 ms word timing). Best for the
                          dub pipeline because lip-sync quality depends on
                          word-boundary accuracy.
      2. faster-whisper — transcription only (no forced alignment). Slightly
                          looser word boundaries but strictly faster; safe
                          fallback when whisperx isn't installed.
      3. mlx-whisper    — mac-ARM speedup if installed (~10-20% latency win
                          vs faster-whisper int8 on Apple Silicon for
                          large-v3). Optional; faster-whisper remains the
                          baseline so we don't diverge mac-only behaviour.
      4. pytorch-whisper — last resort; requires the TTS model to be loaded
                          so it can reuse `_asr_pipe`.
    """
    ok, _ = WhisperXBackend.is_available()
    if ok:
        return "whisperx"
    ok, _ = FasterWhisperBackend.is_available()
    if ok:
        return "faster-whisper"
    try:
        import torch
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            ok, _ = MLXWhisperBackend.is_available()
            if ok:
                return "mlx-whisper"
    except Exception:
        pass
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
    return _REGISTRY[bid]()
