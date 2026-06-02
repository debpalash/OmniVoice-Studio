"""Unit tests for the archetype-preview quality guard (``api.routers.archetypes``).

Background: the Hype Host / Podcaster / Vlogger previews shipped a loud tonal
*buzz* instead of speech. The renderer pinned ``num_step=16`` + ``seed=42`` and
the "social" sample script collapsed to a near-pure tone at that point; the
old silence-only guard missed it (the buzz is loud, not silent) so the garbage
was cached and served.

These tests cover the fix *without the 5 GB model / a GPU*: they drive the pure
``_spectral_flatness`` / ``_is_unusable_audio`` helpers with synthetic signals,
and assert the render constants didn't regress. The real end-to-end render is
verified manually (spectral flatness back in the speech range + Whisper ASR).
"""
from __future__ import annotations

import math
import os
import sys
import tempfile
import types
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub core.config before the router imports OUTPUTS_DIR / VOICES_DIR from it.
_TMP = tempfile.mkdtemp(prefix="omnivoice_preview_q_")
_config = types.ModuleType("core.config")
_config.DATA_DIR = _TMP
_config.VOICES_DIR = str(Path(_TMP) / "voices")
_config.OUTPUTS_DIR = str(Path(_TMP) / "outputs")
sys.modules["core.config"] = _config

torch = pytest.importorskip("torch")  # noqa: E402

from api.routers import archetypes as arch  # noqa: E402

SR = 24_000
N = SR * 3  # 3 s clips


def _pure_tone(hz: float = 220.0) -> "torch.Tensor":
    t = torch.arange(N, dtype=torch.float32) / SR
    return 0.8 * torch.sin(2 * math.pi * hz * t)


def _white_noise() -> "torch.Tensor":
    g = torch.Generator().manual_seed(0)
    return 0.5 * (torch.rand(N, generator=g) * 2 - 1)


def _speech_like() -> "torch.Tensor":
    """Broadband + harmonic + amplitude-modulated — a coarse stand-in for voiced
    speech: several harmonics (formant-ish), additive noise (consonants), and a
    syllabic envelope (word gaps). Flatness lands between a pure tone and noise.
    """
    g = torch.Generator().manual_seed(1)
    t = torch.arange(N, dtype=torch.float32) / SR
    harm = sum(torch.sin(2 * math.pi * f * t) / (i + 1)
               for i, f in enumerate((130.0, 260.0, 390.0, 520.0)))
    noise = 0.3 * (torch.rand(N, generator=g) * 2 - 1)
    env = 0.5 + 0.5 * torch.sin(2 * math.pi * 4.0 * t).clamp(min=0)  # ~4 Hz syllables
    sig = (harm + noise) * env
    return 0.7 * sig / sig.abs().max()


# ── _spectral_flatness ──────────────────────────────────────────────────────
def test_flatness_orders_tone_below_speech_below_noise():
    tone = arch._spectral_flatness(_pure_tone())
    speech = arch._spectral_flatness(_speech_like())
    noise = arch._spectral_flatness(_white_noise())
    assert tone is not None and speech is not None and noise is not None
    assert tone < arch._DEGENERATE_FLATNESS < speech < noise


def test_flatness_returns_none_on_too_short_or_nonfinite():
    assert arch._spectral_flatness(torch.zeros(16)) is None
    bad = torch.full((4096,), float("nan"))
    assert arch._spectral_flatness(bad) is None


# ── _is_unusable_audio ──────────────────────────────────────────────────────
def test_pure_tone_is_unusable():
    # The degenerate-buzz failure mode: loud (passes the silence guard) but tonal.
    tone = _pure_tone()
    assert tone.abs().max() > 0.02            # not silent
    assert arch._is_unusable_audio(tone) is True


def test_silence_is_unusable():
    assert arch._is_unusable_audio(torch.zeros(N)) is True


def test_speech_like_is_usable():
    assert arch._is_unusable_audio(_speech_like()) is False


# ── Constants didn't regress ────────────────────────────────────────────────
def test_preview_render_constants():
    # 16 steps under-converged on the social script; the fix bumped it.
    assert arch._PREVIEW_NUM_STEP >= 24
    assert 0 < arch._DEGENERATE_FLATNESS < 0.03
