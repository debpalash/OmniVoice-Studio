"""
Audio DSP pipeline — broadcast-grade mastering + configurable effects chain.

The default `apply_mastering()` is the same chain shipped since v0.1.0
(highpass + compressor + light reverb). The new `apply_effects_chain()`
lets callers build custom pipelines from a list of named effects.

All effects use Spotify's `pedalboard` library. When pedalboard isn't
installed, every function degrades gracefully (returns audio unmodified).
"""
import logging
import torch

logger = logging.getLogger("omnivoice.dsp")

# ── Effect presets ──────────────────────────────────────────────────────

EFFECT_PRESETS = {
    "broadcast": {
        "label": "Broadcast",
        "icon": "📻",
        "description": "Radio/podcast standard — warm, compressed, clear.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 80},
            {"type": "compressor", "threshold_db": -18, "ratio": 3.0, "attack_ms": 5, "release_ms": 80},
            {"type": "eq", "low_gain_db": 1.5, "mid_gain_db": 0, "high_gain_db": 2.0},
            {"type": "limiter", "threshold_db": -1.0},
        ],
    },
    "cinematic": {
        "label": "Cinematic",
        "icon": "🎬",
        "description": "Film-quality — spacious reverb, gentle compression.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 60},
            {"type": "compressor", "threshold_db": -15, "ratio": 1.8, "attack_ms": 10, "release_ms": 150},
            {"type": "reverb", "room_size": 0.35, "wet_level": 0.15, "dry_level": 0.85},
            {"type": "limiter", "threshold_db": -1.5},
        ],
    },
    "podcast": {
        "label": "Podcast",
        "icon": "🎙️",
        "description": "Close-mic, intimate — heavy compression, no reverb.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 100},
            {"type": "noise_gate", "threshold_db": -40, "release_ms": 200},
            {"type": "compressor", "threshold_db": -20, "ratio": 4.0, "attack_ms": 2, "release_ms": 60},
            {"type": "eq", "low_gain_db": -1.0, "mid_gain_db": 2.0, "high_gain_db": 1.5},
            {"type": "limiter", "threshold_db": -0.5},
        ],
    },
    "raw": {
        "label": "Raw",
        "icon": "🔇",
        "description": "No processing — model output as-is.",
        "chain": [],
    },
    "warm": {
        "label": "Warm",
        "icon": "☀️",
        "description": "Boosted low-mids, subtle saturation, cozy feel.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 60},
            {"type": "eq", "low_gain_db": 3.0, "mid_gain_db": 1.0, "high_gain_db": -1.0},
            {"type": "compressor", "threshold_db": -16, "ratio": 2.0, "attack_ms": 8, "release_ms": 120},
            {"type": "reverb", "room_size": 0.15, "wet_level": 0.06, "dry_level": 0.94},
        ],
    },
    "bright": {
        "label": "Bright",
        "icon": "✨",
        "description": "Crisp high-end, presence boost, airy feel.",
        "chain": [
            {"type": "highpass", "cutoff_hz": 80},
            {"type": "eq", "low_gain_db": -1.0, "mid_gain_db": 0, "high_gain_db": 4.0},
            {"type": "compressor", "threshold_db": -14, "ratio": 2.5, "attack_ms": 3, "release_ms": 80},
            {"type": "limiter", "threshold_db": -1.0},
        ],
    },
}


def list_effect_presets() -> list[dict]:
    """Return presets for the frontend UI picker."""
    return [
        {"id": k, "label": v["label"], "icon": v["icon"], "description": v["description"]}
        for k, v in EFFECT_PRESETS.items()
    ]


def get_effect_chain(preset_id: str) -> list[dict]:
    """Return the effect chain for a preset. Falls back to empty chain."""
    p = EFFECT_PRESETS.get(preset_id)
    return p["chain"] if p else []


# ── Core DSP functions ──────────────────────────────────────────────────


def apply_mastering(audio_tensor, sample_rate=24000):
    """Applies professional Broadcast-grade DSP (EQ, Compressor, light Reverb) to the clone voice."""
    try:
        from pedalboard import Pedalboard, Compressor, Reverb, HighpassFilter
        import numpy as np
        board = Pedalboard([
            HighpassFilter(cutoff_frequency_hz=60),
            Compressor(threshold_db=-15, ratio=1.5, attack_ms=2.0, release_ms=100),
            Reverb(room_size=0.10, wet_level=0.08, dry_level=0.95)
        ])
        audio_np = audio_tensor.cpu().numpy()
        if audio_np.ndim == 1:
            audio_np = audio_np[np.newaxis, :]
        effected = board(audio_np, sample_rate, reset=False)
        return torch.from_numpy(effected).to(audio_tensor.device)
    except ImportError:
        return audio_tensor # Fail gracefully if pedalboard isn't installed
    except Exception as e:
        logger.warning("Mastering DSP Error: %s", e)
        return audio_tensor


def normalize_audio(audio_tensor, target_dBFS=-2.0):
    """Peak-normalizes the audio to a standard broadcasting level (-2 dB) to fix F5TTS volume fluctuations."""
    if audio_tensor.numel() == 0:
        return audio_tensor
    max_val = torch.abs(audio_tensor).max()
    if max_val > 0:
        target_amp = 10 ** (target_dBFS / 20.0)
        audio_tensor = audio_tensor * (target_amp / max_val)
    return audio_tensor


def apply_effects_chain(audio_tensor, sample_rate: int, chain: list[dict]) -> torch.Tensor:
    """Apply a chain of named effects to an audio tensor.

    Each item in `chain` is a dict with a `type` key and effect-specific
    parameters. Unknown types are silently skipped.

    Supported types:
        highpass    — cutoff_hz (default 80)
        lowpass     — cutoff_hz (default 8000)
        compressor  — threshold_db, ratio, attack_ms, release_ms
        reverb      — room_size, wet_level, dry_level
        noise_gate  — threshold_db, release_ms
        eq          — low_gain_db, mid_gain_db, high_gain_db
        limiter     — threshold_db
    """
    if not chain:
        return audio_tensor

    try:
        from pedalboard import (
            Pedalboard,
            Compressor,
            Reverb,
            HighpassFilter,
            LowpassFilter,
            NoiseGate,
            Limiter,
            LowShelfFilter,
            HighShelfFilter,
            PeakFilter,
        )
        import numpy as np
    except ImportError:
        logger.debug("pedalboard not installed — effects chain skipped")
        return audio_tensor

    plugins = []
    for fx in chain:
        t = fx.get("type", "").lower()
        try:
            if t == "highpass":
                plugins.append(HighpassFilter(cutoff_frequency_hz=fx.get("cutoff_hz", 80)))
            elif t == "lowpass":
                plugins.append(LowpassFilter(cutoff_frequency_hz=fx.get("cutoff_hz", 8000)))
            elif t == "compressor":
                plugins.append(Compressor(
                    threshold_db=fx.get("threshold_db", -15),
                    ratio=fx.get("ratio", 2.0),
                    attack_ms=fx.get("attack_ms", 5),
                    release_ms=fx.get("release_ms", 100),
                ))
            elif t == "reverb":
                plugins.append(Reverb(
                    room_size=fx.get("room_size", 0.2),
                    wet_level=fx.get("wet_level", 0.1),
                    dry_level=fx.get("dry_level", 0.9),
                ))
            elif t == "noise_gate":
                plugins.append(NoiseGate(
                    threshold_db=fx.get("threshold_db", -40),
                    release_ms=fx.get("release_ms", 200),
                ))
            elif t == "limiter":
                plugins.append(Limiter(threshold_db=fx.get("threshold_db", -1.0)))
            elif t == "eq":
                low = fx.get("low_gain_db", 0)
                mid = fx.get("mid_gain_db", 0)
                high = fx.get("high_gain_db", 0)
                if low:
                    plugins.append(LowShelfFilter(cutoff_frequency_hz=250, gain_db=low))
                if mid:
                    plugins.append(PeakFilter(cutoff_frequency_hz=1500, gain_db=mid, q=1.0))
                if high:
                    plugins.append(HighShelfFilter(cutoff_frequency_hz=4000, gain_db=high))
            else:
                logger.debug("Unknown effect type: %s — skipped", t)
        except Exception as e:
            logger.warning("Failed to create %s effect: %s", t, e)

    if not plugins:
        return audio_tensor

    board = Pedalboard(plugins)
    audio_np = audio_tensor.cpu().numpy()
    if audio_np.ndim == 1:
        audio_np = audio_np[None, :]
    try:
        effected = board(audio_np, sample_rate, reset=False)
        return torch.from_numpy(effected).to(audio_tensor.device)
    except Exception as e:
        logger.warning("Effects chain failed: %s — returning unmodified audio", e)
        return audio_tensor

