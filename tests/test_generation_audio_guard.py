"""Generation audio guards (#629).

A numerical glitch (seen on MPS) could leave NaN/inf in the rendered audio,
which writes an unreadable WAV that then fails decoding with an opaque
"ffmpeg returned error code: 183 / Invalid data" — surfaced to the user as a
misleading "ran out of memory". Two guards: sanitize non-finite samples before
any encode, and classify a decode/ffmpeg failure as unreadable-audio (not OOM).
"""
import os
import sys

import pytest
import torch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from api.routers.generation import _sanitize_audio, _oom_friendly_reraise  # noqa: E402


def test_sanitize_replaces_non_finite_with_silence():
    t = torch.tensor([0.1, float("nan"), float("inf"), -float("inf"), 0.2])
    out = _sanitize_audio(t)
    assert torch.isfinite(out).all()
    assert out[0].item() == pytest.approx(0.1)
    assert out[1].item() == 0.0 and out[2].item() == 0.0 and out[3].item() == 0.0


def test_sanitize_leaves_finite_audio_unchanged():
    t = torch.tensor([0.0, 0.5, -0.5, 0.25])
    out = _sanitize_audio(t)
    assert torch.equal(out, t)


def test_sanitize_passes_through_non_tensor():
    assert _sanitize_audio(None) is None
    obj = object()
    assert _sanitize_audio(obj) is obj


def test_ffmpeg_decode_failure_is_not_labelled_oom():
    err = RuntimeError(
        "Decoding failed. ffmpeg returned error code: 183\n"
        "Invalid data found when processing input"
    )
    with pytest.raises(RuntimeError) as ei:
        _oom_friendly_reraise(err)
    msg = str(ei.value)
    assert "unreadable audio" in msg
    assert "out of memory" not in msg


def test_generic_failure_still_uses_oom_hint():
    with pytest.raises(RuntimeError) as ei:
        _oom_friendly_reraise(RuntimeError("CUDA error: out of memory"))
    assert "ran out of memory" in str(ei.value)


def test_unsupported_instruct_is_a_validation_error_not_oom():
    # #664: free-form prose in the instruct field must surface as a 400-mapped
    # ValueError with the instruct guidance — NOT a 500 "ran out of memory".
    err = ValueError(
        "Unsupported instruct items found in Speak with high energy:\n"
        "  'Speak with high energy' -> 'speak with high energy' (unsupported)\n\n"
        "Valid English items: male, whisper, ..."
    )
    with pytest.raises(ValueError) as ei:
        _oom_friendly_reraise(err)
    msg = str(ei.value)
    assert "Unsupported instruct items" in msg
    assert "ran out of memory" not in msg


def test_instruct_error_wrapped_in_runtimeerror_is_still_validation():
    # A lower layer can wrap the original ValueError; we must classify on the
    # message signature, not the type, so the route still returns a clean 400.
    err = RuntimeError(
        "model.generate failed: Conflicting instruct items within the same "
        "category: 'male' vs 'female'."
    )
    with pytest.raises(ValueError) as ei:
        _oom_friendly_reraise(err)
    assert "Conflicting instruct items" in str(ei.value)
    assert "ran out of memory" not in str(ei.value)


def test_broken_pipe_is_a_lost_pipe_not_oom():
    # #715: a "[Errno 32] Broken pipe" surfacing from generation means the
    # backend's stdout/stderr pipe to the desktop shell closed mid-render (an
    # orphaned/relaunched backend) — NOT out of memory. Telling the user to
    # press Flush for memory they never ran out of is the wrong next step;
    # restarting the app re-parents the backend. Covers both the typed
    # BrokenPipeError and a string-wrapped "[Errno 32] Broken pipe".
    for err in (
        BrokenPipeError(32, "Broken pipe"),
        RuntimeError("model.generate failed: [Errno 32] Broken pipe"),
    ):
        with pytest.raises(RuntimeError) as ei:
            _oom_friendly_reraise(err)
        msg = str(ei.value)
        assert "pipe" in msg.lower()
        assert "Restart the app" in msg
        assert "ran out of memory" not in msg


def test_no_kernel_image_is_an_unsupported_gpu_not_oom():
    # #756: a GPU whose compute capability isn't in the torch build's arch list
    # (Pascal sm_61 on new wheels, Blackwell sm_120 on old wheels) raises "CUDA
    # error: no kernel image is available for execution". That's NOT OOM and Flush
    # won't help — point at CPU / a matching torch.
    err = RuntimeError(
        "CUDA error: no kernel image is available for execution on the device"
    )
    with pytest.raises(RuntimeError) as ei:
        _oom_friendly_reraise(err)
    msg = str(ei.value)
    assert "GPU isn't supported" in msg or "isn't supported by the installed" in msg
    assert "CPU" in msg
    assert "ran out of memory" not in msg


def test_winerror_193_is_a_corrupt_binary_not_oom():
    # #705: a corrupt / wrong-architecture native component (torch, ffmpeg, an
    # engine binary) fails on Windows with "[WinError 193] %1 is not a valid
    # Win32 application". That is NOT OOM and Flush won't help — say so.
    err = RuntimeError(
        "TTS engine stopped mid-generation: [WinError 193] %1 is not a valid "
        "Win32 application"
    )
    with pytest.raises(RuntimeError) as ei:
        _oom_friendly_reraise(err)
    msg = str(ei.value)
    assert "WinError 193" in msg
    assert "corrupt" in msg or "wrong architecture" in msg
    assert "ran out of memory" not in msg
