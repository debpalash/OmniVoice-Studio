"""
Plugin SDK — abstract interface for third-party TTS engines.

Allows community contributors to add support for ElevenLabs, XTTS, Bark,
Fish TTS, etc. without modifying core VoiceStudio code.

Usage:
    1. Create a Python file in backend/plugins/  (e.g. elevenlabs.py)
    2. Subclass `TTSPlugin` and implement the 4 abstract methods
    3. Register via `@register_plugin` decorator or add to PLUGINS dict
    4. The engine will appear in the frontend Settings → TTS Engine picker

Example:
    from services.plugin_sdk import TTSPlugin, register_plugin

    @register_plugin
    class ElevenLabsPlugin(TTSPlugin):
        id = "elevenlabs"
        display_name = "ElevenLabs"
        ...
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Optional

logger = logging.getLogger("omnivoice.plugins")

# ── Plugin registry ──────────────────────────────────────────────────

PLUGINS: dict[str, type["TTSPlugin"]] = {}


def register_plugin(cls: type["TTSPlugin"]) -> type["TTSPlugin"]:
    """Decorator: register a TTS plugin class by its `id`."""
    if not hasattr(cls, "id") or not cls.id:
        raise ValueError(f"Plugin class {cls.__name__} must define a non-empty `id`.")
    PLUGINS[cls.id] = cls
    logger.info("Registered TTS plugin: %s (%s)", cls.id, cls.display_name)
    return cls


def get_plugin(plugin_id: str) -> "TTSPlugin":
    """Instantiate and return a plugin by id."""
    cls = PLUGINS.get(plugin_id)
    if cls is None:
        available = ", ".join(sorted(PLUGINS.keys())) or "none"
        raise KeyError(f"Unknown TTS plugin '{plugin_id}'. Available: {available}")
    return cls()


def list_plugins() -> list[dict]:
    """Return metadata for all registered plugins (for the frontend)."""
    out = []
    for pid, cls in sorted(PLUGINS.items()):
        ok, msg = cls.is_available()
        out.append({
            "id": pid,
            "display_name": cls.display_name,
            "requires_api_key": cls.requires_api_key,
            "is_local": cls.is_local,
            "available": ok,
            "availability_message": msg,
            "supported_languages": cls.supported_languages_hint,
        })
    return out


# ── Abstract base class ─────────────────────────────────────────────


class TTSPlugin(ABC):
    """Base class for all TTS engine plugins.

    Subclass this and implement the abstract methods to add support for
    a new TTS engine (cloud API or local model).
    """

    #: Unique identifier (lowercase, no spaces). Used in API requests.
    id: str = ""

    #: Human-readable name for the UI.
    display_name: str = "Unnamed Plugin"

    #: Whether this engine needs an API key (cloud providers).
    requires_api_key: bool = False

    #: Whether this engine runs locally (no network calls).
    is_local: bool = False

    #: Hint for the UI — list of commonly supported languages.
    supported_languages_hint: list[str] = ["en"]

    @classmethod
    @abstractmethod
    def is_available(cls) -> tuple[bool, str]:
        """Check if the engine can run in the current environment.

        Returns:
            (True, "Ready") if available.
            (False, "pip install ...") with actionable fix instructions.
        """

    @abstractmethod
    def generate(
        self,
        text: str,
        *,
        voice_id: Optional[str] = None,
        language: Optional[str] = None,
        speed: float = 1.0,
        **kwargs,
    ) -> bytes:
        """Generate speech from text.

        Args:
            text: The text to synthesize.
            voice_id: Provider-specific voice identifier.
            language: ISO 639 language code.
            speed: Speech speed multiplier.

        Returns:
            Raw audio bytes (WAV or MP3, depending on provider).
        """

    @abstractmethod
    def list_voices(self) -> list[dict]:
        """Return available voices for this engine.

        Returns:
            List of dicts with at least: {"id": str, "name": str, "language": str}
        """

    def get_sample_rate(self) -> int:
        """Output sample rate. Override if not 24000."""
        return 24000


# ── Built-in plugin: ElevenLabs (example) ────────────────────────────


@register_plugin
class ElevenLabsPlugin(TTSPlugin):
    """ElevenLabs cloud TTS — high-quality voice synthesis.

    Requires: ELEVENLABS_API_KEY environment variable.
    Install:  pip install elevenlabs
    """

    id = "elevenlabs"
    display_name = "ElevenLabs"
    requires_api_key = True
    is_local = False
    supported_languages_hint = [
        "en", "es", "fr", "de", "it", "pt", "pl", "hi", "ar", "zh",
        "ja", "ko", "nl", "tr", "ru", "sv", "id", "fil", "ms", "ro",
        "uk", "el", "cs", "da", "fi", "bg", "hr", "sk", "ta",
    ]

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        import os
        if not os.environ.get("ELEVENLABS_API_KEY"):
            return False, "Set ELEVENLABS_API_KEY environment variable."
        try:
            import elevenlabs  # noqa: F401
            return True, "Ready"
        except ImportError:
            return False, "pip install elevenlabs"

    def generate(self, text, *, voice_id=None, language=None, speed=1.0, **kw) -> bytes:
        import os
        from elevenlabs import ElevenLabs

        client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
        audio_iter = client.text_to_speech.convert(
            text=text,
            voice_id=voice_id or "JBFqnCBsd6RMkjVDRZzb",  # George default
            model_id="eleven_multilingual_v2",
            output_format="mp3_44100_128",
        )
        return b"".join(audio_iter)

    def list_voices(self) -> list[dict]:
        import os
        try:
            from elevenlabs import ElevenLabs
            client = ElevenLabs(api_key=os.environ.get("ELEVENLABS_API_KEY", ""))
            voices = client.voices.get_all()
            return [
                {"id": v.voice_id, "name": v.name, "language": "multi"}
                for v in voices.voices
            ]
        except Exception as e:
            logger.warning("ElevenLabs list_voices failed: %s", e)
            return []

    def get_sample_rate(self) -> int:
        return 44100


# ── Built-in plugin: Bark (local) ────────────────────────────────────


@register_plugin
class BarkPlugin(TTSPlugin):
    """Suno Bark — open-source local TTS with music/effects support.

    Install: pip install suno-bark
    """

    id = "bark"
    display_name = "Bark (Suno)"
    requires_api_key = False
    is_local = True
    supported_languages_hint = ["en", "es", "fr", "de", "it", "pt", "ru", "zh", "ja", "ko"]

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        try:
            from bark import SAMPLE_RATE  # noqa: F401
            return True, "Ready"
        except ImportError:
            return False, "pip install suno-bark"

    def generate(self, text, *, voice_id=None, language=None, speed=1.0, **kw) -> bytes:
        import io
        import numpy as np
        from bark import generate_audio, SAMPLE_RATE
        import scipy.io.wavfile

        speaker = voice_id or "v2/en_speaker_6"
        audio_array = generate_audio(text, history_prompt=speaker)

        buf = io.BytesIO()
        scipy.io.wavfile.write(buf, SAMPLE_RATE, (audio_array * 32767).astype(np.int16))
        return buf.getvalue()

    def list_voices(self) -> list[dict]:
        return [
            {"id": f"v2/en_speaker_{i}", "name": f"English Speaker {i}", "language": "en"}
            for i in range(10)
        ]

    def get_sample_rate(self) -> int:
        return 24000


# ── Auto-discover plugins from backend/plugins/ directory ────────────

def discover_plugins():
    """Import all .py files in backend/plugins/ to trigger @register_plugin."""
    import importlib
    import pathlib

    plugins_dir = pathlib.Path(__file__).parent.parent / "plugins"
    if not plugins_dir.exists():
        return

    for path in plugins_dir.glob("*.py"):
        if path.name.startswith("_"):
            continue
        module_name = f"plugins.{path.stem}"
        try:
            importlib.import_module(module_name)
            logger.info("Loaded plugin module: %s", module_name)
        except Exception as e:
            logger.warning("Failed to load plugin %s: %s", module_name, e)


# Run discovery on import
discover_plugins()
