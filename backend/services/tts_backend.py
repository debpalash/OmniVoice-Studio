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
import re
from abc import ABC, abstractmethod
from typing import Optional

import torch

logger = logging.getLogger("omnivoice.tts")


# ── HF token leak mitigation (Plan 02-04, T-02-12) ─────────────────────────
#
# Token shape is ``hf_`` + 30+ alphanumeric chars per Hugging Face's own
# format. Any error / status string surfaced through the engines API gets
# scrubbed via :func:`_mask_hf_tokens` before serialization so that a
# backend whose ``is_available()`` interpolates ``HF_TOKEN`` into its
# failure message can't accidentally leak it to the frontend. Phase 1's
# ``HFTokenRedactor`` covers logging only — FastAPI response bodies do
# NOT run through the logging filter chain.
_HF_TOKEN_MASK_RE = re.compile(r"hf_[A-Za-z0-9]{30,}")
_HF_TOKEN_MASK = "hf_***REDACTED***"


def _mask_hf_tokens(value):
    """Return ``value`` with any HF-shaped token substring redacted.

    Non-string values pass through unchanged. Used inside
    :func:`list_backends` for the ``reason`` and ``last_error`` fields.
    """
    if not isinstance(value, str):
        return value
    return _HF_TOKEN_MASK_RE.sub(_HF_TOKEN_MASK, value)


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

    #: Whether this engine supports voice design from a text description
    #: (e.g. "young female, warm tone, British accent") without reference audio.
    supports_voice_design: bool = False

    #: Whether this engine already emits mastered, studio-grade audio and should
    #: therefore skip the shared apply_mastering() chain (Compressor + Reverb,
    #: tuned for OmniVoice's 24 kHz output). Studio engines like VoxCPM2 (native
    #: 48 kHz) set this True so their clean output isn't pumped/reverbed. Loudness
    #: normalisation is applied regardless — it's a benign peak scale.
    applies_own_mastering: bool = False

    #: GPU/accelerator targets the engine can run on. Surfaced via the
    #: Engine Compatibility Matrix (Plan 02-04 / ENGINE-06) so users can
    #: tell at a glance which engines will use their hardware. Defaults to
    #: CPU-only — subclasses override with the union of devices their
    #: implementation supports (cuda / mps / rocm / cpu). This is metadata,
    #: not enforced — actual device selection lives in the engine's loader.
    gpu_compat: tuple[str, ...] = ("cpu",)

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
        description: Optional[str] = None,
        num_step: int = 16,
        guidance_scale: float = 2.0,
        speed: float = 1.0,
        **extras,
    ) -> torch.Tensor:
        """Synthesize `text`. Returns a tensor of shape (1, n_samples).

        When `description` is provided and `ref_audio` is None, engines that
        support voice design will create a synthetic voice matching the
        description (e.g. "young female, warm, slight British accent").
        Engines that don't support this will ignore the parameter.
        """

    # ── Lifecycle (Phase 2 will enforce per-engine overrides) ──────────────
    #
    # Today every backend lazily loads its weights on first `generate()` and
    # keeps them in VRAM for the lifetime of the process. Switching engines
    # in Settings therefore leaks the old engine's allocations until the
    # next process restart — measurable on multi-engine sessions on 8 GB
    # MPS Macs.
    #
    # `unload()` is the contract that lets the registry release an engine
    # before instantiating the next one. It is a default no-op on the ABC
    # so this commit does not break any of the 9 existing subclasses; Phase
    # 2 (engine isolation) overrides it per-engine and adds a CI gate that
    # fails when a subclass doesn't implement it.
    #
    # Contract for overriders:
    #   • Idempotent: calling unload() twice must not raise.
    #   • Synchronous: returns after VRAM is freed (or after best-effort
    #     `torch.cuda.empty_cache()` / `torch.mps.empty_cache()`).
    #   • Safe to call before the first generate(): a backend that never
    #     loaded has nothing to release.
    def unload(self) -> None:
        """Release any GPU memory and file handles held by this backend.

        Called by the registry on engine switch and on app shutdown. Default
        is a no-op so engines that haven't migrated keep working; per-engine
        overrides arrive in Phase 2 (see ROADMAP.md). Must be idempotent.
        """
        return None


# ── OmniVoice adapter (the current default) ─────────────────────────────────


class OmniVoiceBackend(TTSBackend):
    """Wraps `omnivoice.models.omnivoice.OmniVoice`. Zero behaviour change.

    Loads lazily on the first `generate` call, mirrors the existing
    `services.model_manager.get_model()` flow: torch.compile on CUDA,
    fp16, ASR co-loaded.
    """

    id = "omnivoice"
    display_name = "OmniVoice (600 languages, zero-shot)"
    gpu_compat = ("cuda", "mps", "cpu")

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
        # Caller is sync; spin up a fresh loop if needed. get_running_loop()
        # raises only when *no* loop is running — that's the safe path where
        # we can bootstrap with asyncio.run().
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            self._model = asyncio.run(get_model())
            return
        raise RuntimeError(
            "OmniVoiceBackend.generate() called inside an async context without a pre-loaded model. "
            "Pass `model=await get_model()` to the constructor."
        )

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

    Voice Design: VoxCPM2 uniquely supports creating voices from a text
    description (e.g. "young female, warm tone, British accent") without
    any reference audio. Pass `description=` without `ref_audio=` to use
    this mode.
    """

    id = "voxcpm2"
    display_name = "VoxCPM2 (30 langs, studio 48 kHz, voice design)"
    supports_voice_design = True
    applies_own_mastering = True  # native 48 kHz studio output — skip apply_mastering()
    gpu_compat = ("cuda", "mps", "cpu")

    def __init__(self):
        self._model = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import voxcpm  # noqa: F401
        except ImportError:
            return False, (
                "voxcpm package not installed. Install with `pip install voxcpm` "
                "(requires Python ≥3.10, PyTorch ≥2.5). CUDA ≥12 recommended "
                "for full speed; MPS (Apple Silicon) and CPU also supported."
            )
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

        ref_audio = kw.get("ref_audio")
        ref_text = kw.get("ref_text")
        description = kw.get("description")
        instruct = kw.get("instruct")

        # ── Voice Design mode: description-only, no reference audio ─────
        # VoxCPM2's `generate_from_description()` creates a synthetic voice
        # matching a natural-language description. This is the P0 feature
        # from the roadmap — text → voice without any audio sample.
        if description and not ref_audio:
            logger.info(
                "VoxCPM2: voice design mode — generating from description: %r",
                description[:80],
            )
            wav = self._model.generate(
                text=text,
                voice_description=description,
                cfg_value=kw.get("guidance_scale", 2.0),
                inference_timesteps=kw.get("num_step", 10),
            )
            if isinstance(wav, np.ndarray):
                wav = torch.from_numpy(wav).float()
            if wav.ndim == 1:
                wav = wav.unsqueeze(0)
            return wav

        # ── Standard clone / instruct mode ──────────────────────────────
        # Map our instruct prop onto VoxCPM2's inline "(instruct)prompt" prefix.
        prompt = text
        if instruct:
            prompt = f"({instruct}){text}"
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
    gpu_compat = ("cuda", "cpu")

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
    # KittenTTS ships as an ONNX CPU graph; no CUDA/MPS path today.
    gpu_compat = ("cpu",)

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
    # mlx is Apple-Silicon-only; CPU is the practical fallback when the
    # mlx framework is installed but the user lacks an Apple GPU.
    gpu_compat = ("mps", "cpu")

    # A curated subset surfaced by default — the full mlx-audio roster is
    # larger but these cover the useful tiers: small multilingual (Kokoro),
    # voice-clone (CSM), voice-design (Qwen3), European (Kugel), lightweight
    # VITS (MeloTTS). Users can point at any HF repo via OMNIVOICE_MLX_AUDIO_MODEL.
    CURATED_MODELS = {
        "kokoro":      "mlx-community/Kokoro-82M-bf16",
        "csm":         "mlx-community/csm-1b-8bit",
        "qwen3-tts":   "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit",
        "dia":         "mlx-community/Dia-1.6B",
        "chatterbox":  "mlx-community/Chatterbox-TTS-4bit",
        "melotts":     "mlx-community/MeloTTS-English-v3-MLX",
        "outetts":     "mlx-community/Llama-OuteTTS-1.0-1B-4bit",
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


# ── CosyVoice adapter (Alibaba FunAudioLLM, Apache-2.0) ────────────────────


class CosyVoiceBackend(TTSBackend):
    """FunAudioLLM CosyVoice — multilingual zero-shot TTS (9 langs + 18 dialects).

    Supports v1 (300M), v2 (0.5B), and v3 (0.5B, latest). Installation is
    non-trivial (git clone --recursive + SoX) so we ship as an optional
    scaffold: ``is_available()`` reports the missing install cleanly.

    Set ``OMNIVOICE_COSYVOICE_MODEL`` to the pretrained model directory path
    (e.g. ``pretrained_models/Fun-CosyVoice3-0.5B``). The directory must
    contain the CosyVoice checkpoint files.

    Install:
        git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git
        cd CosyVoice && pip install -r requirements.txt
        # Ubuntu: sudo apt-get install sox libsox-dev
        # macOS:  brew install sox
    """

    id = "cosyvoice"
    display_name = "CosyVoice 3 (9 langs, zero-shot, instruct, Apache-2.0)"
    # CosyVoice's official inference path expects CUDA; CPU works but slow.
    # MPS support not verified upstream — flagged for Phase 6 confirmation.
    gpu_compat = ("cuda", "cpu")

    # CosyVoice language tags used for cross-lingual synthesis.
    LANG_TAGS = {
        "zh": "<|zh|>", "en": "<|en|>", "ja": "<|ja|>",
        "ko": "<|ko|>", "yue": "<|yue|>", "de": "<|de|>",
        "es": "<|es|>", "fr": "<|fr|>", "it": "<|it|>",
        "ru": "<|ru|>",
    }

    def __init__(self):
        self._model = None

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            from cosyvoice.cli.cosyvoice import AutoModel  # noqa: F401
            return True, "ready"
        except ImportError:
            return False, (
                "cosyvoice package not installed. Install from "
                "https://github.com/FunAudioLLM/CosyVoice "
                "(git clone --recursive + pip install -r requirements.txt + SoX). "
                "Then set OMNIVOICE_COSYVOICE_MODEL to your model directory."
            )

    @property
    def sample_rate(self) -> int:
        if self._model is not None:
            return self._model.sample_rate
        return 24000  # v3 default

    @property
    def supported_languages(self) -> list[str]:
        return ["zh", "en", "ja", "ko", "yue", "de", "es", "fr", "it", "ru"]

    def _ensure_loaded(self):
        if self._model is not None:
            return
        ok, msg = self.is_available()
        if not ok:
            raise RuntimeError(f"CosyVoice unavailable: {msg}")
        from cosyvoice.cli.cosyvoice import AutoModel  # type: ignore[import-not-found]
        model_dir = os.environ.get(
            "OMNIVOICE_COSYVOICE_MODEL",
            "pretrained_models/Fun-CosyVoice3-0.5B",
        )
        logger.info("Loading CosyVoice from %s", model_dir)
        self._model = AutoModel(model_dir=model_dir)

    def generate(self, text: str, **kw) -> torch.Tensor:
        import numpy as np
        self._ensure_loaded()

        ref_audio = kw.get("ref_audio")
        ref_text = kw.get("ref_text")
        instruct = kw.get("instruct")
        language = kw.get("language")

        # Pick the right inference method based on what the caller provides:
        # 1. instruct + ref_audio → inference_instruct2 (emotion/dialect/speed)
        # 2. ref_audio + ref_text → inference_zero_shot (voice cloning)
        # 3. ref_audio only → inference_cross_lingual (with lang tag)
        # 4. nothing → inference_sft (built-in speakers, v1/SFT model only)
        pieces = []
        if instruct and ref_audio:
            # Instruct mode: "用四川话说<|endofprompt|>"
            if not instruct.endswith("<|endofprompt|>"):
                instruct = f"{instruct}<|endofprompt|>"
            results = self._model.inference_instruct2(
                text, instruct, ref_audio, stream=False,
            )
        elif ref_audio and ref_text:
            results = self._model.inference_zero_shot(
                text, ref_text, ref_audio, stream=False,
            )
        elif ref_audio:
            # Cross-lingual: prefix text with language tag if available.
            lang_tag = ""
            if language:
                full_lang = language.lower()
                lang_key = full_lang[:2] if len(full_lang) > 2 else full_lang
                lang_tag = self.LANG_TAGS.get(full_lang) or self.LANG_TAGS.get(lang_key, "")
            results = self._model.inference_cross_lingual(
                f"{lang_tag}{text}", ref_audio, stream=False,
            )
        else:
            # No ref audio — try SFT with first available speaker.
            spks = self._model.list_available_spks()
            spk = spks[0] if spks else "中文女"
            results = self._model.inference_sft(text, spk, stream=False)

        for chunk in results:
            wav = chunk.get("tts_speech")
            if wav is None:
                continue
            if isinstance(wav, np.ndarray):
                wav = torch.from_numpy(wav).float()
            if not isinstance(wav, torch.Tensor):
                wav = torch.tensor(wav, dtype=torch.float32)
            pieces.append(wav)

        if not pieces:
            raise RuntimeError("CosyVoice produced no audio")
        wav = torch.cat(pieces, dim=-1)
        if wav.ndim == 1:
            wav = wav.unsqueeze(0)
        return wav


# ── IndexTTS2 adapter ───────────────────────────────────────────────────────
#
# The concrete class lives in ``backend/engines/indextts/__init__.py`` so
# that ``services.tts_backend`` itself does NOT import
# ``services.subprocess_backend`` at module load time. That separation
# breaks the import cycle:
#
#     services.subprocess_backend  ──imports──>  services.tts_backend (TTSBackend)
#     services.tts_backend         ──exports──>  TTSBackend + registry
#     engines.indextts             ──imports──>  services.subprocess_backend
#                                  ──exports──>  IndexTTS2Backend
#
# The registry below resolves IndexTTS2Backend lazily via the
# ``_LAZY_REGISTRY`` indirection — see ``get_backend_class`` and
# ``list_backends``. This was driven by Plan 02-03 (Step 3); see
# ``engines/indextts/__init__.py`` for the actual class body.


# ``IndexTTS2Backend`` is re-exported from ``backend/engines/indextts``
# via the module-level ``__getattr__`` hook at the bottom of this file
# (PEP 562). Callers can still write::
#
#     from services.tts_backend import IndexTTS2Backend
#
# and they receive the same class object as ``engines.indextts.IndexTTS2Backend``.
# The deferred lookup is what breaks the
# ``services.subprocess_backend ↔ services.tts_backend`` cycle.


# ── GPT-SoVITS adapter (most popular voice cloning, 57k★) ──────────────────


class GPTSoVITSBackend(TTSBackend):
    """RVC-Boss GPT-SoVITS — the most popular open-source voice cloning system.

    57k GitHub stars, RTF 0.014 (10× faster than VoxCPM2). Supports zero-shot
    and few-shot voice cloning with excellent naturalness. Chinese, English,
    Japanese, Cantonese, Korean.

    GPT-SoVITS runs as a standalone API server (api_v2.py) because it doesn't
    ship a clean pip-installable package. This adapter connects to that server
    over HTTP. Start the server before using this backend:

        cd GPT-SoVITS
        python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml

    Set ``OMNIVOICE_GPTSOVITS_URL`` to the server URL (default: http://127.0.0.1:9880).

    License: MIT — fully permissive, commercial use OK.
    """

    id = "gpt-sovits"
    display_name = "GPT-SoVITS (5 langs, zero-shot, RTF 0.014, MIT)"
    # Server-side; whichever device GPT-SoVITS itself uses (CUDA preferred).
    gpu_compat = ("cuda", "cpu")

    def __init__(self):
        self._url = os.environ.get("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        # GPT-SoVITS runs as an external API server — check if it's reachable.
        import urllib.request
        url = os.environ.get("OMNIVOICE_GPTSOVITS_URL", "http://127.0.0.1:9880")
        try:
            req = urllib.request.Request(f"{url}/", method="GET")
            urllib.request.urlopen(req, timeout=2)
            return True, "ready (server reachable)"
        except Exception:
            return False, (
                f"GPT-SoVITS server not reachable at {url}. "
                "Start it with: python api_v2.py -a 127.0.0.1 -p 9880 "
                "-c GPT_SoVITS/configs/tts_infer.yaml"
            )

    @property
    def sample_rate(self) -> int:
        return 32000  # GPT-SoVITS outputs 32 kHz

    @property
    def supported_languages(self) -> list[str]:
        return ["zh", "en", "ja", "yue", "ko"]

    def generate(self, text: str, **kw) -> torch.Tensor:
        import urllib.request
        import urllib.parse

        ref_audio = kw.get("ref_audio")
        ref_text = kw.get("ref_text", "")
        language = kw.get("language", "en")

        # Map language codes to GPT-SoVITS format
        lang_map = {
            "zh": "zh", "en": "en", "ja": "ja", "yue": "yue", "ko": "ko",
            "chinese": "zh", "english": "en", "japanese": "ja",
        }
        text_lang = lang_map.get(language.lower() if language else "en", "en")

        # Build request params
        params = {
            "text": text,
            "text_language": text_lang,
        }
        if ref_audio:
            params["refer_wav_path"] = ref_audio
            params["prompt_text"] = ref_text or ""
            params["prompt_language"] = text_lang

        speed = kw.get("speed", 1.0)
        if speed != 1.0:
            params["speed_factor"] = str(speed)

        query = urllib.parse.urlencode(params)
        url = f"{self._url}/?{query}"

        try:
            req = urllib.request.Request(url, method="POST")
            with urllib.request.urlopen(req, timeout=120) as resp:
                audio_bytes = resp.read()
        except Exception as e:
            raise RuntimeError(
                f"GPT-SoVITS API call failed: {e}. "
                f"Ensure the server is running at {self._url}"
            )

        # Parse the WAV response
        import io
        import torchaudio
        wav, sr = torchaudio.load(io.BytesIO(audio_bytes))
        if sr != self.sample_rate:
            wav = torchaudio.functional.resample(wav, sr, self.sample_rate)
        if wav.ndim == 1:
            wav = wav.unsqueeze(0)
        elif wav.ndim == 2 and wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
        return wav


# ── Sherpa-ONNX adapter (universal ONNX runtime, WASM-ready) ───────────────


class SherpaOnnxBackend(TTSBackend):
    """k2-fsa/sherpa-onnx — unified C++ ONNX runtime for TTS (and ASR).

    Sherpa-ONNX wraps 20+ TTS engines (VITS, MeloTTS, Piper, Kokoro, Matcha,
    CosyVoice, etc.) under a single runtime with pre-built wheels for:
      • Linux / Windows / macOS (x86 + ARM)
      • Android / iOS
      • WebAssembly (browser)

    This is the bridge to browser-based OmniVoice: the same engine runs natively
    on desktop and compiles to WASM for the web UI.

    Install: pip install sherpa-onnx
    Models: download from https://github.com/k2-fsa/sherpa-onnx/releases

    Set ``OMNIVOICE_SHERPA_MODEL`` to the model directory path.
    """

    id = "sherpa-onnx"
    display_name = "Sherpa-ONNX (20+ engines, WASM-ready, universal runtime)"
    # Sherpa-ONNX uses the onnxruntime providers — CPU is the universal
    # baseline; CUDA provider is available on Linux/Windows installs.
    gpu_compat = ("cuda", "cpu")

    def __init__(self):
        self._tts = None
        self._model_dir = os.environ.get("OMNIVOICE_SHERPA_MODEL", "")

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            import sherpa_onnx  # noqa: F401
            return True, "ready"
        except ImportError as e:
            return False, (
                f"sherpa-onnx not installed: {e}. "
                "Install with: pip install sherpa-onnx. "
                "Download models from https://github.com/k2-fsa/sherpa-onnx/releases"
            )

    @property
    def sample_rate(self) -> int:
        if self._tts is not None:
            return self._tts.sample_rate
        return 22050  # VITS default

    @property
    def supported_languages(self) -> list[str]:
        return ["multi"]  # depends on loaded model

    def _ensure_loaded(self):
        if self._tts is not None:
            return
        ok, msg = self.is_available()
        if not ok:
            raise RuntimeError(f"Sherpa-ONNX unavailable: {msg}")
        import sherpa_onnx

        if not self._model_dir:
            raise RuntimeError(
                "OMNIVOICE_SHERPA_MODEL not set. Point it to a sherpa-onnx "
                "TTS model directory (containing model.onnx + tokens.txt)."
            )

        # Auto-detect model type from directory contents
        model_onnx = os.path.join(self._model_dir, "model.onnx")
        tokens = os.path.join(self._model_dir, "tokens.txt")

        if not os.path.isfile(model_onnx):
            raise RuntimeError(
                f"No model.onnx found in {self._model_dir}. "
                "Download a model from https://github.com/k2-fsa/sherpa-onnx/releases"
            )

        logger.info("Loading sherpa-onnx TTS from %s", self._model_dir)
        tts_config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=model_onnx,
                    tokens=tokens,
                ),
            ),
        )
        self._tts = sherpa_onnx.OfflineTts(tts_config)

    def generate(self, text: str, **kw) -> torch.Tensor:
        import numpy as np
        self._ensure_loaded()

        speed = float(kw.get("speed", 1.0))
        # sherpa-onnx speaker ID (for multi-speaker VITS models)
        sid = int(kw.get("speaker_id", 0))

        audio = self._tts.generate(text, sid=sid, speed=speed)
        wav = np.array(audio.samples, dtype=np.float32)
        wav = torch.from_numpy(wav).unsqueeze(0)  # (1, n_samples)
        return wav


# ── Registry ────────────────────────────────────────────────────────────────


# ── Lazy registry entry for subprocess-isolated backends ──────────────────
#
# Backends that live in their own module (to avoid an import cycle with
# ``services.subprocess_backend``) register here as ``(module_path,
# attribute_name)``. ``_REGISTRY`` resolves the entry on first access via
# the descriptor below.

_LAZY_REGISTRY: dict[str, tuple[str, str]] = {
    "indextts2": ("engines.indextts", "IndexTTS2Backend"),
    # Phase 4 Plan 04-01 (GGUF-03): hardware-adaptive GGUF runtime wrapper.
    # Lazy so the import of services.tts_backend doesn't pull
    # huggingface_hub + soundfile transitively when callers only need
    # the in-process OmniVoice. Resolves on first attribute / item access.
    "omnivoice-gguf": ("engines.omnivoice_gguf", "OmniVoiceGGUFBackend"),
    # Phase 3 Plan 03-01 (TTS-01): Supertonic-3 lives in its own engine
    # package for the same import-cycle reason as IndexTTS2 (its backend
    # module imports services.subprocess_backend which in turn imports
    # this module for TTSBackend). The class is resolved on first
    # attribute access via the LazyRegistry below.
    "supertonic3": ("engines.supertonic3", "Supertonic3Backend"),
}


class _LazyRegistry(dict):
    """A dict that resolves selected keys via a deferred import.

    Keys in ``_LAZY_REGISTRY`` are not present in ``self`` until first
    access; ``__getitem__`` / ``__contains__`` / iteration all import
    them on demand. Everything else behaves like a normal dict — the
    registry-sandbox fixture in
    ``tests/backend/services/test_tts_backend_registry.py`` still gets
    snapshot semantics because once a lazy key is resolved it's stored
    in self exactly like a non-lazy key.
    """

    def __contains__(self, key) -> bool:  # noqa: D401
        return dict.__contains__(self, key) or key in _LAZY_REGISTRY

    def __getitem__(self, key):
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        if key in _LAZY_REGISTRY:
            mod_path, attr = _LAZY_REGISTRY[key]
            import importlib

            cls = getattr(importlib.import_module(mod_path), attr)
            self[key] = cls
            return cls
        raise KeyError(key)

    def __iter__(self):
        # Yield resolved keys first, then any lazy keys that haven't been
        # resolved yet. Resolving inside __iter__ would trigger a side
        # effect on every list_backends() call — we keep iteration light
        # and let the caller's __getitem__ trigger the import.
        seen: set[str] = set()
        for k in dict.__iter__(self):
            seen.add(k)
            yield k
        for k in _LAZY_REGISTRY:
            if k not in seen:
                yield k

    def items(self):
        for k in self:
            yield k, self[k]

    def keys(self):
        return list(iter(self))

    def values(self):
        return [self[k] for k in self]


_REGISTRY: dict[str, type[TTSBackend]] = _LazyRegistry({
    "omnivoice":     OmniVoiceBackend,
    "cosyvoice":     CosyVoiceBackend,
    "kittentts":     KittenTTSBackend,
    "mlx-audio":     MLXAudioBackend,
    "voxcpm2":       VoxCPM2Backend,
    "moss-tts-nano": MossTTSNanoBackend,
    # "indextts2": resolved lazily via _LAZY_REGISTRY -> engines.indextts
    "gpt-sovits":    GPTSoVITSBackend,
    "sherpa-onnx":   SherpaOnnxBackend,
})


# ── ENGINE-06 last-error cache ─────────────────────────────────────────────
#
# Populated by `list_backends()` whenever a backend's `is_available()`
# returns ok=False or raises an exception. Cleared per-id when the same
# backend reports ok=True. Surfaced via the `last_error` field on each
# registry entry so the Compat Matrix UI (Plan 02-04) can show the most
# recent failure even between calls — and prove which engine is the source
# of a hung Settings panel.
_LAST_ERRORS: dict[str, str] = {}



# Short install hints surfaced as tooltips on the Settings → Engines UI.
# Helps users understand what pip package to install and where.
_INSTALL_HINTS: dict[str, str] = {
    "omnivoice":     "pip install omnivoice  (bundled — no extra install needed)",
    "cosyvoice":     "git clone --recursive FunAudioLLM/CosyVoice + pip install -r requirements.txt + SoX",
    "kittentts":     "pip install kittentts  (ONNX, CPU-only, ~80 MB)",
    "mlx-audio":     "pip install mlx-audio  (Apple Silicon only)",
    "voxcpm2":       "pip install voxcpm     (CPU/MPS supported; CUDA recommended for speed)",
    "moss-tts-nano": "git clone OpenMOSS/MOSS-TTS-Nano && pip install -e .  (not on PyPI)",
    "indextts2":     "git clone index-tts/index-tts && uv pip install -e .  (NOT uv sync --all-extras)",
    "gpt-sovits":    "External API server — start api_v2.py on port 9880",
    "sherpa-onnx":   "pip install sherpa-onnx  (universal ONNX runtime, WASM-ready)",
    "omnivoice-gguf":"Bundled — runs the C++ omnivoice-tts binary in bin/. Quants download lazily from Serveurperso/OmniVoice-GGUF on first generate.",
    "supertonic3":   "uv sync --extra supertonic  (CPU-only ONNX, 31 langs, ~400 MB model on first use; OpenRAIL-M model license)",
}


def list_backends() -> list[dict]:
    """Enumerate every registered backend with its availability state.

    Per-entry shape (ENGINE-05 + ENGINE-06):

        {
          "id":             str,
          "display_name":   str,
          "available":      bool,
          "reason":         Optional[str],          # message when not available
          "install_hint":   Optional[str],
          "last_error":     Optional[str],          # cached most-recent failure
          "isolation_mode": "in-process" | "subprocess",
          "gpu_compat":     list[str],              # subset of {cuda, mps, rocm, cpu}
        }

    Guarantees (ENGINE-05): a backend whose `is_available()` raises does
    NOT prevent the list from returning. The exception is captured into
    the `reason`/`last_error` fields for that one entry and every other
    backend is still listed normally.

    Security (Plan 02-04 / T-02-12): any HF-shaped token substring in
    ``reason`` or ``last_error`` is redacted before the entry is
    serialized — :func:`_mask_hf_tokens`. The frontend can render these
    fields verbatim without leaking credentials.
    """
    # Detect subprocess-isolated backends via a duck-typed marker rather
    # than `issubclass(cls, SubprocessBackend)`. Test fixtures (e.g. the
    # token_resolver suite) purge `sys.modules["services"]` between tests
    # for DB isolation, which produces a re-imported SubprocessBackend
    # class object that no longer == the one this test's subclasses closed
    # over. The marker attribute is set on SubprocessBackend itself, so
    # subclasses inherit it through any re-import path.
    out: list[dict] = []
    for bid, cls in _REGISTRY.items():
        try:
            ok, msg = cls.is_available()
        except Exception as exc:
            ok = False
            msg = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "list_backends: %s.is_available() raised — degrading "
                "gracefully so the picker still renders: %s",
                bid, msg,
            )
        if ok:
            _LAST_ERRORS.pop(bid, None)
        else:
            # Mask any HF token inside the failure message BEFORE it lands
            # in the in-memory cache — otherwise a later list_backends()
            # call would re-surface the unmasked string.
            _LAST_ERRORS[bid] = _mask_hf_tokens(msg)
        # ENGINE-06 isolation_mode: duck-typed marker for SubprocessBackend
        # subclasses (see services.subprocess_backend.SubprocessBackend).
        if getattr(cls, "_is_subprocess_isolated", False):
            isolation = "subprocess"
        else:
            isolation = "in-process"
        out.append({
            "id": bid,
            "display_name": cls.display_name,
            "available": ok,
            "reason": None if ok else _mask_hf_tokens(msg),
            "install_hint": _INSTALL_HINTS.get(bid),
            "last_error": _LAST_ERRORS.get(bid),
            "isolation_mode": isolation,
            "gpu_compat": list(getattr(cls, "gpu_compat", ("cpu",))),
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


# ── PEP 562 lazy attribute re-export ───────────────────────────────────────
#
# Allows ``from services.tts_backend import IndexTTS2Backend`` to keep
# working even though the class itself lives in ``engines.indextts``.
# Triggers the engines.indextts import on first attribute access, which
# is after this module has finished loading — so no import cycle.

def __getattr__(name: str):  # pragma: no cover - exercised via tests
    if name in _LAZY_REGISTRY:
        return _REGISTRY[name if name in _REGISTRY else None]
    if name == "IndexTTS2Backend":
        return _REGISTRY["indextts2"]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
