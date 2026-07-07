"""
Regression tests: the mastering pre-stage must not hide a reverb.

A hardcoded Reverb inside apply_mastering() used to bake echo into every
non-raw synthesis regardless of the chosen effect preset (field reports of
echoey voices; the podcast preset even promises "no reverb", and cinematic/
warm got doubled reverb). Reverb is preset-declared only — these tests pin
that contract.

Kept separate from test_effects_chain.py on purpose: that file skips
entirely without pedalboard, while the data-shape guards here must always
run. sys.path for backend imports is handled by tests/conftest.py.
"""

import builtins
import math
import sys

import pytest
import torch

from services.audio_dsp import (
    EFFECT_PRESETS,
    MASTERING_CHAIN,
    apply_mastering,
)


def _stage_types(chain):
    return [fx["type"] for fx in chain]


def _make_test_audio(duration_s=1.0, sample_rate=24000) -> torch.Tensor:
    """Create a test audio tensor with a simple sine wave."""
    t = torch.linspace(0, duration_s, int(duration_s * sample_rate))
    return torch.sin(2 * math.pi * 440 * t).unsqueeze(0)  # 440 Hz sine, mono


class TestMasteringChainHasNoHiddenReverb:
    def test_mastering_chain_contains_no_reverb(self):
        """The recurrence guard: nobody re-adds a reverb outside the preset system."""
        assert "reverb" not in _stage_types(MASTERING_CHAIN)

    def test_mastering_chain_keeps_highpass_and_compressor(self):
        """Removing the reverb must not gut the rest of the pre-stage."""
        types = _stage_types(MASTERING_CHAIN)
        assert "highpass" in types
        assert "compressor" in types


class TestPresetReverbContract:
    @pytest.mark.parametrize("preset_id", ["broadcast", "podcast"])
    def test_no_reverb_presets_stay_reverb_free(self, preset_id):
        """podcast's description literally promises "no reverb"."""
        assert "reverb" not in _stage_types(EFFECT_PRESETS[preset_id]["chain"])

    @pytest.mark.parametrize("preset_id", ["cinematic", "warm"])
    def test_user_chosen_reverb_survives(self, preset_id):
        """Presets that deliberately declare reverb must keep it."""
        assert "reverb" in _stage_types(EFFECT_PRESETS[preset_id]["chain"])


class TestApplyMasteringFunctional:
    def test_returns_same_shape_and_device(self):
        pytest.importorskip("pedalboard")
        audio = _make_test_audio()
        result = apply_mastering(audio, sample_rate=24000)
        assert isinstance(result, torch.Tensor)
        assert result.shape == audio.shape
        assert result.device == audio.device

    def test_no_echo_tail_bleeds_into_silence(self):
        """A burst followed by silence must stay silent after mastering.

        Fails with the old hidden Reverb (its tail rings past the burst);
        passes with highpass + compressor only.
        """
        pytest.importorskip("pedalboard")
        sr = 24000
        burst = _make_test_audio(duration_s=0.25, sample_rate=sr)
        audio = torch.cat([burst, torch.zeros(1, sr)], dim=1)  # + 1 s silence
        result = apply_mastering(audio, sample_rate=sr)
        # Skip 50 ms after the burst so the filters settle; a reverb tail is
        # far louder and longer than that.
        tail = result[:, burst.shape[1] + int(0.05 * sr):]
        assert tail.abs().max().item() < 1e-3

    def test_passthrough_when_pedalboard_missing(self, monkeypatch):
        """Graceful degradation: no pedalboard, audio returned unmodified."""
        real_import = builtins.__import__

        def no_pedalboard(name, *args, **kwargs):
            if name == "pedalboard" or name.startswith("pedalboard."):
                raise ImportError("pedalboard unavailable (simulated)")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", no_pedalboard)
        monkeypatch.delitem(sys.modules, "pedalboard", raising=False)
        audio = _make_test_audio()
        result = apply_mastering(audio, sample_rate=24000)
        assert torch.equal(result, audio)
