"""
TTS adapter interface — Phase 3.1 (ROADMAP.md).

A uniform protocol for every TTS engine. Today we ship:

    • OmniVoiceBackend — wraps the current k2-fsa/OmniVoice model. Zero
      behaviour change for existing callers.
    • VoxCPM2Backend   — thin stub that raises with a clear install hint
      until `pip install voxcpm` is present and enabled.

Callers should use `get_active_tts_backend()` to pick the configured engine
instead of importing a specific class. The selection is controlled by the
`OMNIVOICE_TTS_BACKEND` env var (default: `"omnivoice"`).

The protocol deliberately stays narrow: `generate(...)` returns a 1-channel
tensor sampled at `sample_rate`. Streaming is left for a later pass — the
dub generator consumes whole segments today.
"""
from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from typing import Optional

import torch

logger = logging.getLogger("omnivoice.tts")


# ── Protocol ────────────────────────────────────────────────────────────────


class TTSBackend(ABC):
    """Every TTS engine exposes the same surface, regardless of vendor."""

    #: Unique id for config + UI (e.g. "omnivoice", "voxcpm2").
    id: str = "base"

    #: Human-readable name for the UI.
    display_name: str = "Base TTS"

    #: Output sample rate. May differ per engine (OmniVoice = 24k, VoxCPM2 = 48k).
    @property
    @abstractmethod
    def sample_rate(self) -> int: ...

    #: Languages the engine supports (ISO codes or "multi").
    @property
    @abstractmethod
    def supported_languages(self) -> list[str]: ...

    #: Whether this engine can actually run in the current environment.
    #: Callers use this to fail fast with a clear message instead of loading
    #: a backend that will blow up on first call.
    @classmethod
    @abstractmethod
    def is_available(cls) -> tuple[bool, str]:
        """Return (ok, message). message explains why not, if not."""

    @abstractmethod
    def generate(
        self,
        text: str,
        *,
        ref_audio: Optional[str] = None,
        ref_text: Optional[str] = None,
        instruct: Optional[str] = None,
        language: Optional[str] = None,
        duration: Optional[float] = None,
        num_step: int = 16,
        guidance_scale: float = 2.0,
        speed: float = 1.0,
        **extras,
    ) -> torch.Tensor:
        """Synthesize `text`. Returns a tensor of shape (1, n_samples)."""


# ── OmniVoice adapter (the current default) ─────────────────────────────────


class OmniVoiceBackend(TTSBackend):
    """Wraps `omnivoice.models.omnivoice.OmniVoice`. Zero behaviour change.

    Loads lazily on the first `generate` call, mirrors the existing
    `services.model_manager.get_model()` flow: torch.compile on CUDA,
    fp16, ASR co-loaded.
    """

    id = "omnivoice"
    display_name = "OmniVoice (600 languages, zero-shot)"

    def __init__(self, model=None):
        # The live OmniVoice instance. Reuses the singleton owned by
        # model_manager so memory isn't doubled.
        self._model = model

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import omnivoice.models.omnivoice  # noqa: F401
            return True, "ready"
        except Exception as e:
            return False, f"omnivoice package missing: {e}"

    @property
    def sample_rate(self) -> int:
        if self._model is None:
            return 24000  # canonical OmniVoice rate
        return getattr(self._model, "sampling_rate", 24000)

    @property
    def supported_languages(self) -> list[str]:
        # OmniVoice advertises 600+ zero-shot — `"multi"` is the honest tag.
        return ["multi"]

    def _ensure_loaded(self):
        if self._model is not None:
            return
        # Reuse model_manager's cached instance so we don't double-load.
        from services.model_manager import get_model
        import asyncio
        # Caller is sync; spin up a fresh loop if needed.
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Already inside an async context — caller should await
                # `get_model()` themselves and pass it in via the constructor.
                raise RuntimeError(
                    "OmniVoiceBackend.generate() called inside an async context without a pre-loaded model. "
                    "Pass `model=await get_model()` to the constructor."
                )
            self._model = loop.run_until_complete(get_model())
        except RuntimeError:
            self._model = asyncio.run(get_model())

    def generate(self, text, **kw) -> torch.Tensor:
        self._ensure_loaded()
        language = kw.get("language")
        audios = self._model.generate(
            text=text,
            language=language if language and language != "Auto" else None,
            ref_audio=kw.get("ref_audio"),
            ref_text=kw.get("ref_text"),
            instruct=kw.get("instruct"),
            duration=kw.get("duration"),
            num_step=kw.get("num_step", 16),
            guidance_scale=kw.get("guidance_scale", 2.0),
            speed=kw.get("speed", 1.0),
            denoise=kw.get("denoise", True),
            postprocess_output=kw.get("postprocess_output", True),
        )
        return audios[0]


# ── VoxCPM2 adapter (optional, scaffolded) ──────────────────────────────────


class VoxCPM2Backend(TTSBackend):
    """OpenBMB VoxCPM2 wrapper — `pip install voxcpm` required.

    Ships as a scaffold: the class loads and reports unavailability cleanly
    when the dep isn't installed, so Settings UI can gate the engine selector
    without a hard crash. When `voxcpm` is present, `generate()` delegates to
    the real model.
    """

    id = "voxcpm2"
    display_name = "VoxCPM2 (30 langs, studio 48 kHz)"

    def __init__(self):
        self._model = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import voxcpm  # noqa: F401
        except ImportError:
            return False, (
                "voxcpm package not installed. Install with `pip install voxcpm` "
                "(requires CUDA 12+ and ~8 GB VRAM)."
            )
        if not torch.cuda.is_available():
            return False, "VoxCPM2 requires a CUDA GPU (CUDA 12+)."
        return True, "ready"

    @property
    def sample_rate(self) -> int:
        return 48000

    @property
    def supported_languages(self) -> list[str]:
        # 30 langs per model card.
        return [
            "ar", "my", "zh", "da", "nl", "en", "fi", "fr", "de", "el",
            "he", "hi", "id", "it", "ja", "km", "ko", "lo", "ms", "no",
            "pl", "pt", "ru", "es", "sw", "sv", "tl", "th", "tr", "vi",
        ]

    def _ensure_loaded(self):
        if self._model is not None:
            return
        ok, msg = self.is_available()
        if not ok:
            raise RuntimeError(f"VoxCPM2 unavailable: {msg}")
        from voxcpm import VoxCPM  # type: ignore[import-not-found]
        checkpoint = os.environ.get("OMNIVOICE_VOXCPM_MODEL", "openbmb/VoxCPM2")
        logger.info("Loading VoxCPM2 from %s", checkpoint)
        self._model = VoxCPM.from_pretrained(checkpoint, load_denoiser=False)

    def generate(self, text, **kw) -> torch.Tensor:
        self._ensure_loaded()
        import numpy as np
        # Map our instruct prop onto VoxCPM2's inline "(instruct)prompt" prefix.
        prompt = text
        instruct = kw.get("instruct")
        if instruct:
            prompt = f"({instruct}){text}"
        ref_audio = kw.get("ref_audio")
        ref_text = kw.get("ref_text")
        wav = self._model.generate(
            text=prompt,
            cfg_value=kw.get("guidance_scale", 2.0),
            inference_timesteps=kw.get("num_step", 10),
            reference_wav_path=ref_audio,
            prompt_wav_path=ref_audio if ref_text else None,
            prompt_text=ref_text,
        )
        if isinstance(wav, np.ndarray):
            wav = torch.from_numpy(wav).float()
        if wav.ndim == 1:
            wav = wav.unsqueeze(0)
        return wav


# ── MOSS-TTS-Nano adapter (tiny, CPU-friendly, 20 langs) ────────────────────


class MossTTSNanoBackend(TTSBackend):
    """OpenMOSS MOSS-TTS-Nano-100M — the low-resource / broad-language pick.

    100M-param autoregressive codec-LM. Runs realtime on a 4-core CPU (no GPU
    required), native 48 kHz stereo output, 20 languages, Apache-2.0. Fills
    two gaps in the existing lineup: the "runs on a fanless laptop" tier and
    the Arabic/Hebrew/Persian/Korean/Turkish coverage that OmniVoice's
    zero-shot does but VoxCPM2 + XTTS lean against.

    Ships as a scaffold — `is_available()` reports the missing install so the
    Settings picker gates the engine cleanly until the user opts in.
    """

    id = "moss-tts-nano"
    display_name = "MOSS-TTS-Nano (20 langs, CPU realtime, 48 kHz)"

    def __init__(self):
        self._model = None
        self._tokenizer = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        # Package isn't on PyPI — users install from the MOSS repo
        # (`pip install -e` of github.com/OpenMOSS/MOSS-TTS-Nano) or we load
        # the HF weights with `trust_remote_code=True`.
        try:
            import transformers  # noqa: F401
        except ImportError:
            return False, "transformers not installed"
        try:
            # MOSS ships its own package alongside the HF weights.
            import moss_tts_nano  # noqa: F401
            return True, "ready"
        except ImportError:
            return False, (
                "moss_tts_nano package not installed. Install from "
                "https://github.com/OpenMOSS/MOSS-TTS-Nano "
                "(`pip install -e .`), then set OMNIVOICE_TTS_BACKEND=moss-tts-nano."
            )

    @property
    def sample_rate(self) -> int:
        return 48000  # native stereo 48 kHz

    @property
    def supported_languages(self) -> list[str]:
        return [
            "zh", "en", "de", "es", "fr", "ja", "it", "he", "ko", "ru",
            "fa", "ar", "pl", "pt", "cs", "da", "sv", "hu", "el", "tr",
        ]

    def _ensure_loaded(self):
        if self._model is not None:
            return
        ok, msg = self.is_available()
        if not ok:
            raise RuntimeError(f"MOSS-TTS-Nano unavailable: {msg}")
        from moss_tts_nano import MossTTSNano  # type: ignore[import-not-found]
        checkpoint = os.environ.get(
            "OMNIVOICE_MOSS_TTS_MODEL", "OpenMOSS-Team/MOSS-TTS-Nano"
        )
        logger.info("Loading MOSS-TTS-Nano from %s", checkpoint)
        self._model = MossTTSNano.from_pretrained(checkpoint, trust_remote_code=True)

    def generate(self, text, **kw) -> torch.Tensor:
        self._ensure_loaded()
        import numpy as np
        ref_audio = kw.get("ref_audio")
        # MOSS is strictly reference-cloning: no instruct / speaker_id / speed.
        # We downgrade gracefully — extras are silently ignored so the common
        # call-site doesn't need to know which engine it's talking to.
        wav = self._model.generate(
            text=text,
            prompt_audio_path=ref_audio,
        )
        if isinstance(wav, np.ndarray):
            wav = torch.from_numpy(wav).float()
        if wav.ndim == 1:
            wav = wav.unsqueeze(0)
        elif wav.ndim == 2 and wav.shape[0] > 1:
            # Model emits stereo; downmix to mono for the dub mixer (which
            # treats TTS output as mono per segment). Cheap mean-channel mix.
            wav = wav.mean(dim=0, keepdim=True)
        return wav


# ── KittenTTS (lightweight English "Turbo" tier) ────────────────────────────


class KittenTTSBackend(TTSBackend):
    """KittenML/KittenTTS — 25-80 MB ONNX model, 8 preset voices, English only.

    Fills the ElevenLabs-Flash niche: when the caller just needs quick English
    narration (voiceover, demo reads, short phrases) with no reference sample.
    Runs CPU-realtime on any platform — no torch, no CUDA, no mlx. The
    trade-off vs OmniVoice is obvious:
      - No voice cloning (fixed preset voices)
      - English only
      - Much faster + much smaller install

    Preset voice is chosen via `extras["voice"]` (defaults to "Jasper"). Any
    `ref_audio` / `instruct` / `language` arg is ignored with a log line so
    the common call-site doesn't need to know which engine it's talking to.
    """

    id = "kittentts"
    display_name = "KittenTTS (English, 8 preset voices, CPU realtime)"

    PRESET_VOICES = [
        "expr-voice-2-m", "expr-voice-2-f",
        "expr-voice-3-m", "expr-voice-3-f",
        "expr-voice-4-m", "expr-voice-4-f",
        "expr-voice-5-m", "expr-voice-5-f",
    ]
    DEFAULT_VOICE = "expr-voice-2-f"

    def __init__(self):
        self._model = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import kittentts  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, f"kittentts not installed: {e}"

    @property
    def sample_rate(self) -> int:
        # KittenTTS emits 24 kHz mono per its ONNX model config.
        return 24000

    @property
    def supported_languages(self) -> list[str]:
        return ["en"]

    def _ensure_loaded(self):
        if self._model is not None:
            return
        from kittentts import KittenTTS
        checkpoint = os.environ.get(
            "OMNIVOICE_KITTENTTS_MODEL", "KittenML/kitten-tts-mini-0.8"
        )
        logger.info("Loading KittenTTS from %s", checkpoint)
        self._model = KittenTTS(checkpoint)

    def generate(self, text: str, **kw) -> torch.Tensor:
        import numpy as np
        self._ensure_loaded()

        language = kw.get("language")
        if language and language.lower() not in {"en", "english", "auto"}:
            logger.info(
                "KittenTTS is English-only; ignoring language=%r — "
                "use OmniVoice for multilingual synthesis.",
                language,
            )

        voice = kw.get("voice") or self.DEFAULT_VOICE
        if voice not in self.PRESET_VOICES:
            logger.info(
                "KittenTTS: unknown voice %r, falling back to %r. Valid: %s",
                voice, self.DEFAULT_VOICE, self.PRESET_VOICES,
            )
            voice = self.DEFAULT_VOICE

        speed = float(kw.get("speed", 1.0))
        wav_np = self._model.generate(text, voice=voice, speed=speed)
        if not isinstance(wav_np, np.ndarray):
            wav_np = np.asarray(wav_np)
        wav = torch.from_numpy(wav_np).float()
        if wav.ndim == 1:
            wav = wav.unsqueeze(0)
        elif wav.ndim == 2 and wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
        return wav


# ── MLX-Audio (mac-ARM engine multiplexer) ──────────────────────────────────


class MLXAudioBackend(TTSBackend):
    """Blaizzy/mlx-audio — Apple-Silicon-only wrapper over 14+ TTS engines
    (Kokoro, CSM, Dia, Qwen3-TTS, Chatterbox, MeloTTS, OuteTTS, Spark,
    Higgs-Audio, Voxtral, LongCat-AudioDiT, KugelAudio, MingOmni, Soprano).

    Exposed as a single backend with a `model_id` selector so the Settings
    UI can surface an engine picker within one adapter. The user switches
    models by setting `OMNIVOICE_MLX_AUDIO_MODEL` or picking from the UI —
    no code change per engine. Default is Kokoro (82M, multilingual, small).

    Availability: requires mlx (Apple Silicon only). Skipped entirely on
    Linux/Windows/mac-Intel; the dep is platform-gated in pyproject.toml.
    """

    id = "mlx-audio"
    display_name = "MLX-Audio (mac-ARM, 14+ engines: Kokoro, CSM, Dia, Qwen3, …)"

    # A curated subset surfaced by default — the full mlx-audio roster is
    # larger but these cover the useful tiers: small multilingual (Kokoro),
    # voice-clone (CSM), voice-design (Qwen3), European (Kugel), lightweight
    # VITS (MeloTTS). Users can point at any HF repo via OMNIVOICE_MLX_AUDIO_MODEL.
    CURATED_MODELS = {
        "kokoro":      "mlx-community/Kokoro-82M-bf16",
        "csm":         "mlx-community/csm-1b-8bit",
        "qwen3-tts":   "mlx-community/Qwen3-TTS-1.7B-4bit",
        "dia":         "mlx-community/Dia-1.6B",
        "chatterbox":  "mlx-community/Chatterbox",
        "melotts":     "mlx-community/MeloTTS",
        "outetts":     "mlx-community/OuteTTS-0.3-500M",
    }
    DEFAULT_MODEL_KEY = "kokoro"

    def __init__(self):
        self._model = None
        self._sr = 24000  # most mlx-audio engines emit 24 kHz mono
        key = os.environ.get("OMNIVOICE_MLX_AUDIO_MODEL", self.DEFAULT_MODEL_KEY)
        # Accept either a curated key ("kokoro") or a full HF repo id
        # ("mlx-community/Kokoro-82M-bf16") — flexibility for power users.
        self._model_id = self.CURATED_MODELS.get(key, key)

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import mlx_audio  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, (
                f"mlx-audio not installed: {e}. "
                "This backend is Apple Silicon only — available on mac-ARM dev "
                "installs; not shipped on Linux/Windows/mac-Intel."
            )

    @property
    def sample_rate(self) -> int:
        return self._sr

    @property
    def supported_languages(self) -> list[str]:
        # Per-model; Kokoro supports 8, Qwen3 ~4, Kugel 24. Return "multi"
        # so the language picker doesn't gate by engine — each engine
        # silently ignores languages it doesn't know.
        return ["multi"]

    def _ensure_loaded(self):
        if self._model is not None:
            return
        from mlx_audio.tts.utils import load_model
        logger.info("Loading mlx-audio model %s", self._model_id)
        self._model = load_model(self._model_id)

    def generate(self, text: str, **kw) -> torch.Tensor:
        import numpy as np
        self._ensure_loaded()

        voice     = kw.get("voice")
        ref_audio = kw.get("ref_audio")
        language  = kw.get("language")
        speed     = float(kw.get("speed", 1.0))

        # mlx-audio's generate(...) returns an iterator of result objects,
        # each with a .audio attribute. Different engines accept different
        # kwargs (voice for Kokoro, ref_audio for CSM, instruct for Qwen3)
        # — we pass them all and let the engine ignore what it doesn't use.
        kwargs = {"text": text, "speed": speed}
        if voice:     kwargs["voice"] = voice
        if ref_audio: kwargs["ref_audio"] = ref_audio
        if language:  kwargs["lang_code"] = language[:2].lower()

        pieces = []
        try:
            for result in self._model.generate(**kwargs):
                audio = getattr(result, "audio", result)
                if hasattr(audio, "numpy"):
                    audio = audio.numpy()
                pieces.append(np.asarray(audio, dtype=np.float32))
        except TypeError:
            # Some engines don't accept lang_code / ref_audio. Retry with
            # only the universal kwargs.
            pieces = []
            for result in self._model.generate(text=text, speed=speed):
                audio = getattr(result, "audio", result)
                if hasattr(audio, "numpy"):
                    audio = audio.numpy()
                pieces.append(np.asarray(audio, dtype=np.float32))

        if not pieces:
            raise RuntimeError(f"mlx-audio ({self._model_id}) produced no audio")
        wav_np = np.concatenate(pieces, axis=-1)
        wav = torch.from_numpy(wav_np).float()
        if wav.ndim == 1:
            wav = wav.unsqueeze(0)
        elif wav.ndim == 2 and wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
        return wav


# ── Registry ────────────────────────────────────────────────────────────────


_REGISTRY: dict[str, type[TTSBackend]] = {
    "omnivoice":     OmniVoiceBackend,
    "kittentts":     KittenTTSBackend,
    "mlx-audio":     MLXAudioBackend,
    "voxcpm2":       VoxCPM2Backend,
    "moss-tts-nano": MossTTSNanoBackend,
}


def list_backends() -> list[dict]:
    """Enumerate every registered backend with its availability state.
    Shape matches what a Settings-UI engine picker wants.
    """
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


def get_backend_class(backend_id: str) -> type[TTSBackend]:
    if backend_id not in _REGISTRY:
        raise ValueError(f"Unknown TTS backend: {backend_id!r}. Known: {list(_REGISTRY)}")
    return _REGISTRY[backend_id]


def active_backend_id() -> str:
    # Env var > persisted UI choice > default. Env wins so power-users can
    # pin a backend without the Settings picker silently undoing it.
    from core import prefs
    return prefs.resolve("tts_backend", env="OMNIVOICE_TTS_BACKEND", default="omnivoice")


def get_active_tts_backend(*, model=None) -> TTSBackend:
    """Instantiate the configured backend. Pass `model=` for OmniVoice to
    reuse an already-loaded model from `model_manager`.
    """
    cls = get_backend_class(active_backend_id())
    if cls is OmniVoiceBackend:
        return OmniVoiceBackend(model=model)
    return cls()
