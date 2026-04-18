import torch

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
        print(f"Mastering DSP Error: {e}")
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
