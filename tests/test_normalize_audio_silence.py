"""normalize_audio must never amplify a near-silent render into hiss.

Regression for the "blank noise" some generated voices exhibited: the model
occasionally emits near-silence, and peak-normalizing that to -2 dBFS applies
thousands of × of gain, lifting the noise floor to full scale. The silence
floor in normalize_audio prevents that while leaving real audio untouched.
"""
import torch

from services.audio_dsp import normalize_audio


def test_silence_is_not_amplified():
    # A dead render sitting at ~-80 dBFS must stay inaudible, not get scaled up.
    quiet = torch.full((1, 16000), 1e-4, dtype=torch.float32)
    out = normalize_audio(quiet, target_dBFS=-2.0)
    assert out.abs().max().item() < 0.01, "near-silent input must not be amplified to hiss"


def test_all_zeros_stays_zero():
    out = normalize_audio(torch.zeros(1, 8000, dtype=torch.float32))
    assert out.abs().max().item() == 0.0


def test_real_audio_is_normalized_to_target():
    sig = torch.zeros(1, 16000, dtype=torch.float32)
    sig[0, ::100] = 0.1  # real signal peaking well above the silence floor
    out = normalize_audio(sig, target_dBFS=-2.0)
    target = 10 ** (-2.0 / 20.0)  # ~0.794
    assert abs(out.abs().max().item() - target) < 0.02


def test_just_above_floor_is_normalized():
    # 0.01 (-40 dBFS) is above the -50 dBFS floor → should still be normalized.
    sig = torch.zeros(1, 16000, dtype=torch.float32)
    sig[0, 0] = 0.01
    out = normalize_audio(sig, target_dBFS=-2.0)
    assert out.abs().max().item() > 0.5


def test_empty_passthrough():
    assert normalize_audio(torch.zeros(0)).numel() == 0
