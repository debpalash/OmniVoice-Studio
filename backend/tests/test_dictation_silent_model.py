"""A dictation model that decodes NOTHING must fall back, not fail silently.

Found on Windows with `sherpa-parakeet-tdt-v3`: the model
downloads, loads with zero errors, and is correctly detected as a TDT model
(`num_durations: 5`) — then returns an empty token list for clear speech.
Measured against the same 18.9s WAV, on the same machine, same sherpa-onnx:

    sherpa-whisper-tiny     -> "Alright, here we are. I hope that's all..."
    sherpa-zipformer-en-20m -> "ANTS BOTH IN WHAT DISGUISED THIS THAT..."
    parakeet-tdt-v3 (int8)  -> ''
    parakeet-tdt-v3 (fp32)  -> ''
    parakeet-tdt-v2 (int8)  -> ''

Ruled out as causes: quantisation (fp32 fails too), sherpa-onnx version
(1.13.3 and 1.13.4 both fail), decoding method (greedy and modified_beam both
fail), and `model_type` (explicit and auto-detect both fail). The failure is
inside sherpa-onnx's NeMo-TDT decoder, so the app cannot fix it by config —
but it must never present it to the user as "dictation is just broken".

`is_model_silent` is the guard: it separates "the user said nothing" (stay
quiet) from "the model produced nothing despite speech" (fall back to the
capture ASR engine for that session and tell the user which model failed).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from api.routers.capture_ws import MIN_FINAL_BUFFER_BYTES, is_model_silent  # noqa: E402

BIG = MIN_FINAL_BUFFER_BYTES + 1


def test_speech_in_no_text_out_is_a_silent_model():
    """The parakeet-TDT case: real speech went in, nothing came back."""
    assert is_model_silent("", heard_speech=True, pcm_bytes=BIG) is True


def test_quiet_user_is_not_a_silent_model():
    """No speech-level audio => the user just didn't say anything. Falling back
    here would burn the capture engine on silence and emit a bogus warning."""
    assert is_model_silent("", heard_speech=False, pcm_bytes=BIG) is False


def test_a_working_model_never_triggers_fallback():
    assert is_model_silent("hello world", heard_speech=True, pcm_bytes=BIG) is False


def test_whitespace_only_counts_as_no_text():
    """polish_text can hand back blanks; that is still 'produced nothing'."""
    assert is_model_silent("   \n ", heard_speech=True, pcm_bytes=BIG) is True


def test_too_little_audio_does_not_trigger_fallback():
    """A stray blip shorter than the final-transcribe floor isn't evidence the
    model is broken — don't cry wolf on a hotkey mis-tap."""
    assert is_model_silent("", heard_speech=True, pcm_bytes=MIN_FINAL_BUFFER_BYTES) is False
