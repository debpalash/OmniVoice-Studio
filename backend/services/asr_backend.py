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
import re
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

    def unload(self) -> None:
        """Release the model from memory."""
        pass


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
        self._asr = whisperx.load_model(
            self._model_name,
            device=self._device,
            compute_type=self._compute_type,
            # vad_method="silero" is the default; keep it so short gaps
            # get cleaned up before transcription.
        )

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
        try:
            result = self._asr.transcribe(audio)
        except IndexError as e:
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

    def unload(self) -> None:
        self._asr = None
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

    def __init__(self, model_name: str | None = None):
        self._model_name = model_name or os.environ.get(
            "ASR_MODEL", _MLX_MODEL_DEFAULT,
        )

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
        logger.info(
            "MLX Whisper transcribing %s (model=%s, word_timestamps=%s)",
            audio_path, self._model_name, word_timestamps,
        )
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
            loop = asyncio.get_running_loop()
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


# ── NeMo Parakeet TDT (NVIDIA — English SOTA from ASR Leaderboard) ─────────


class NeMoASRBackend(ASRBackend):
    """NVIDIA Parakeet TDT via NeMo toolkit.

    FastConformer encoder + Token-and-Duration Transducer decoder.
    Beats Whisper large-v3 on English benchmarks (~6% WER).
    Supports 25+ European languages with auto language detection.
    Requires NVIDIA GPU.
    """
    id = "nemo-parakeet"
    display_name = "Parakeet TDT (NVIDIA NeMo — English SOTA)"

    def __init__(self):
        self._model_name = os.environ.get(
            "ASR_MODEL_NEMO", "nvidia/parakeet-tdt-0.6b-v3"
        )
        self._model = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import torch
            if not torch.cuda.is_available():
                return False, "Parakeet TDT requires NVIDIA GPU (CUDA)"
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


_REGISTRY: dict[str, type[ASRBackend]] = {
    "whisperx":        WhisperXBackend,
    "faster-whisper":  FasterWhisperBackend,
    "mlx-whisper":     MLXWhisperBackend,
    "pytorch-whisper": PyTorchWhisperBackend,
    "nemo-parakeet":   NeMoASRBackend,
    "moonshine":       MoonshineASRBackend,
    "funasr":          FunASRBackend,
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


_capture_backend: ASRBackend | None = None


def get_capture_asr_backend() -> ASRBackend:
    """Pick the fastest ASR engine for capture / dictation.

    Priority order (speed-first — word alignment is unnecessary for
    dictation, so we skip WhisperX's forced-alignment overhead):

      1. mlx-whisper Turbo  — Apple Silicon, ~5× faster than large-v3
      2. mlx-whisper large  — still native Metal, faster than CPU int8
      3. faster-whisper     — cross-platform CTranslate2 fallback
      4. pytorch-whisper    — last resort

    The caller should also pass ``word_timestamps=False`` to the returned
    backend to skip per-word timing and shave another ~30% latency.

    Returns a cached singleton so the model stays warm between calls.
    """
    global _capture_backend
    if _capture_backend is not None:
        return _capture_backend

    # Prefer MLX Turbo on Apple Silicon
    ok, _ = MLXWhisperBackend.is_available()
    if ok:
        _capture_backend = MLXWhisperBackend(model_name=_MLX_MODEL_TURBO)
        return _capture_backend

    # Fall back to faster-whisper (CPU int8 on non-Apple)
    ok, _ = FasterWhisperBackend.is_available()
    if ok:
        _capture_backend = FasterWhisperBackend()
        return _capture_backend

    # Last resort
    _capture_backend = PyTorchWhisperBackend()
    return _capture_backend
