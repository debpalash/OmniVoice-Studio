"""
ASR adapter interface — Phase 3.3 (ROADMAP.md).

One protocol, multiple engines. Today we ship:

    • MLXWhisperBackend   — mlx-whisper on Apple Silicon (default when MPS is
                            available). Keeps today's word-level timestamp
                            output shape.
    • PyTorchWhisperBackend — fallback on CUDA / CPU using the existing
                            `_asr_pipe` on the TTS model.

Both return the raw Whisper output dict so `services.segmentation.
segment_transcript(...)` can keep working unchanged.

Selection via `OMNIVOICE_ASR_BACKEND` (default: auto-detect).
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


# ── MLX Whisper (Apple Silicon default) ─────────────────────────────────────


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
    """Pick the best available ASR engine for the current hardware."""
    import torch
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        ok, _ = MLXWhisperBackend.is_available()
        if ok:
            return "mlx-whisper"
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
    if bid not in _REGISTRY:
        raise ValueError(f"Unknown ASR backend: {bid!r}. Known: {list(_REGISTRY)}")
    return _REGISTRY[bid]()
