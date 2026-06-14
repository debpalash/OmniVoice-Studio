"""
Invisible + visible audio watermarking for OmniVoice Studio.

Two layers:
  1. **Invisible** — AudioSeal (Meta) embeds imperceptible neural watermarks
     that survive compression, resampling, and editing. Encodes a 16-bit
     message identifying OmniVoice as the source.
  2. **Visible** — Optional audio signature tone prepended to exports;
     ffmpeg-based logo overlay for video exports.

Usage:
    from services.watermark import embed_watermark, detect_watermark

    # Embed (returns same shape tensor, watermarked)
    watermarked = embed_watermark(waveform, sample_rate)

    # Detect (returns dict with confidence + metadata)
    result = detect_watermark(waveform, sample_rate)
"""

from __future__ import annotations

import logging
import math
import torch
from typing import Optional

from core.prefs import resolve

logger = logging.getLogger("omnivoice.watermark")

# ── Lazy-loaded AudioSeal models ──────────────────────────────────────────
# Loaded on first use so cold-start isn't penalised when watermarking is off.
_generator = None
_detector = None
_audioseal_available: Optional[bool] = None

# 16-bit message: "OM" in ASCII = 0x4F 0x4D = 0100_1111 0100_1101
# This is our signature — every OmniVoice-generated audio carries it.
OMNI_MESSAGE = [0, 1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1]


def _check_available() -> bool:
    """Check if AudioSeal is installed and importable."""
    global _audioseal_available
    if _audioseal_available is None:
        try:
            import audioseal  # noqa: F401
            _audioseal_available = True
        except ImportError:
            _audioseal_available = False
            logger.info("audioseal not installed — invisible watermarking disabled")
    return _audioseal_available


def _get_generator():
    """Lazy-load the AudioSeal generator model."""
    global _generator
    if _generator is None:
        from audioseal import AudioSeal
        _generator = AudioSeal.load_generator("audioseal_wm_16bits")
        _generator.eval()
        logger.info("AudioSeal generator loaded (16-bit message mode)")
    return _generator


def _get_detector():
    """Lazy-load the AudioSeal detector model."""
    global _detector
    if _detector is None:
        from audioseal import AudioSeal
        _detector = AudioSeal.load_detector("audioseal_detector_16bits")
        _detector.eval()
        logger.info("AudioSeal detector loaded (16-bit message mode)")
    return _detector


def is_enabled() -> bool:
    """Check if invisible watermarking is enabled in user preferences."""
    return resolve("watermark.invisible", default=True) is not False


def is_visible_audio_enabled() -> bool:
    """Check if audible branding tone is enabled for exports."""
    return resolve("watermark.visible_audio", default=False) is True


def is_visible_video_enabled() -> bool:
    """Check if video logo overlay is enabled for exports."""
    return resolve("watermark.visible_video", default=True) is not False


# ── Invisible Watermark ───────────────────────────────────────────────────

@torch.no_grad()
def embed_watermark(
    waveform: torch.Tensor,
    sample_rate: int,
    message: Optional[list[int]] = None,
    *,
    force: bool = False,
) -> torch.Tensor:
    """
    Embed an imperceptible watermark into the audio waveform.

    Args:
        waveform: Audio tensor of shape (channels, samples) or (1, channels, samples)
        sample_rate: Sample rate of the audio
        message: Optional 16-bit message (list of 0/1). Defaults to OMNI_MESSAGE.
        force: Keyword-only. When True, bypass the user's invisible-watermark
            preference (``is_enabled()``) and embed regardless — used by the
            persona-preview path, which mandates a watermark at package time.
            It does NOT bypass availability: when AudioSeal isn't installed the
            call still no-ops and returns the input unchanged. Existing
            positional call sites default to ``force=False`` (unchanged).

    Returns:
        Watermarked waveform (same shape as input).
    """
    if (not force and not is_enabled()) or not _check_available():
        return waveform

    try:
        generator = _get_generator()
        msg = torch.tensor(message or OMNI_MESSAGE, dtype=torch.int32).unsqueeze(0)

        # AudioSeal expects (batch, channels, samples) — normalise input
        original_shape = waveform.shape
        if waveform.dim() == 2:
            audio = waveform.unsqueeze(0)  # (1, C, S)
        elif waveform.dim() == 1:
            audio = waveform.unsqueeze(0).unsqueeze(0)  # (1, 1, S)
        else:
            audio = waveform

        # AudioSeal operates at 16kHz internally; it handles resampling, but
        # we need to inform it of the source rate for correct embedding.
        watermarked = generator(audio, sample_rate=sample_rate, message=msg)

        # Restore original shape
        if len(original_shape) == 2:
            watermarked = watermarked.squeeze(0)
        elif len(original_shape) == 1:
            watermarked = watermarked.squeeze(0).squeeze(0)

        return watermarked

    except Exception as e:
        logger.warning("Watermark embedding failed (passing through original): %s", e)
        return waveform


@torch.no_grad()
def detect_watermark(
    waveform: torch.Tensor,
    sample_rate: int,
) -> dict:
    """
    Detect whether audio contains an OmniVoice watermark.

    Args:
        waveform: Audio tensor of shape (channels, samples)
        sample_rate: Sample rate of the audio

    Returns:
        Dict with keys:
            is_watermarked: bool
            confidence: float (0.0–1.0)
            message_bits: str (decoded 16-bit message)
            is_omnivoice: bool (true if message matches OMNI_MESSAGE)
    """
    if not _check_available():
        return {
            "is_watermarked": False,
            "confidence": 0.0,
            "message_bits": "",
            "is_omnivoice": False,
            "error": "audioseal not installed",
        }

    try:
        detector = _get_detector()

        # Normalise shape to (batch, channels, samples)
        if waveform.dim() == 2:
            audio = waveform.unsqueeze(0)
        elif waveform.dim() == 1:
            audio = waveform.unsqueeze(0).unsqueeze(0)
        else:
            audio = waveform

        result = detector.detect_watermark(audio, sample_rate=sample_rate, message_threshold=0.5)

        # result is (detection_confidence, decoded_message)
        confidence = float(result[0]) if isinstance(result, tuple) else 0.0
        decoded_msg = result[1] if isinstance(result, tuple) and len(result) > 1 else None

        # Decode message bits
        message_bits = ""
        is_omnivoice = False
        if decoded_msg is not None:
            try:
                bits = decoded_msg.squeeze().tolist()
                if isinstance(bits, list):
                    message_bits = "".join(str(int(b > 0.5)) for b in bits)
                    decoded_list = [int(b > 0.5) for b in bits]
                    is_omnivoice = decoded_list == OMNI_MESSAGE
            except Exception:
                pass

        return {
            "is_watermarked": confidence > 0.5,
            "confidence": round(confidence, 4),
            "message_bits": message_bits,
            "is_omnivoice": is_omnivoice,
            "source": "OmniVoice Studio" if is_omnivoice else "unknown",
        }

    except Exception as e:
        logger.warning("Watermark detection failed: %s", e)
        return {
            "is_watermarked": False,
            "confidence": 0.0,
            "message_bits": "",
            "is_omnivoice": False,
            "error": str(e),
        }


# ── Visible Audio Brand ──────────────────────────────────────────────────

def generate_brand_tone(sample_rate: int = 24000, duration_s: float = 0.4) -> torch.Tensor:
    """
    Generate a short, distinctive audio signature tone.

    A soft ascending three-note chime (C5→E5→G5) that serves as the
    OmniVoice "sound logo". Gentle enough for professional use.

    Returns:
        Tensor of shape (1, samples).
    """
    notes_hz = [523.25, 659.25, 783.99]  # C5, E5, G5
    note_dur = duration_s / len(notes_hz)
    samples_per_note = int(note_dur * sample_rate)
    total_samples = samples_per_note * len(notes_hz)

    tone = torch.zeros(1, total_samples)
    t = torch.linspace(0, note_dur, samples_per_note)

    for idx, freq in enumerate(notes_hz):
        # Sine wave with exponential decay envelope
        envelope = torch.exp(-t * 6.0) * 0.15  # quiet — 15% amplitude
        wave = torch.sin(2 * math.pi * freq * t) * envelope
        start = idx * samples_per_note
        tone[0, start : start + samples_per_note] = wave

    # Fade out the last 20%
    fade_len = int(total_samples * 0.2)
    if fade_len > 0:
        tone[0, -fade_len:] *= torch.linspace(1.0, 0.0, fade_len)

    return tone


def apply_audio_brand(
    waveform: torch.Tensor,
    sample_rate: int,
) -> torch.Tensor:
    """
    Prepend the OmniVoice brand tone to a waveform (for final exports only).

    Returns:
        Tensor with brand tone + original audio concatenated.
    """
    if not is_visible_audio_enabled():
        return waveform

    brand = generate_brand_tone(sample_rate=sample_rate)
    # Add 100ms silence gap between brand and content
    gap = torch.zeros(1, int(0.1 * sample_rate))
    return torch.cat([brand, gap, waveform], dim=-1)


# ── Video Logo Overlay ────────────────────────────────────────────────────

def get_ffmpeg_overlay_args(logo_path: str, duration_s: float = 5.0) -> list[str]:
    """
    Build ffmpeg filter args to overlay the OmniVoice logo in the bottom-right
    corner with a fade-out after `duration_s` seconds.

    Returns:
        List of ffmpeg filter_complex args.
    """
    if not is_visible_video_enabled():
        return []

    # Scale logo to 64px height, place bottom-right with 20px padding,
    # fade out after duration_s seconds.
    filter_str = (
        f"[1:v]scale=-1:64,format=rgba,"
        f"fade=t=out:st={duration_s - 1}:d=1:alpha=1[logo];"
        f"[0:v][logo]overlay=W-w-20:H-h-20:enable='lte(t,{duration_s})'"
    )
    return ["-filter_complex", filter_str]
