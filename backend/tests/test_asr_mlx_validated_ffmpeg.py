import sys
import types
import wave

# conftest.py puts `backend/` on sys.path and points OMNIVOICE_DATA_DIR at a
# throwaway tmpdir before this module imports the REAL core.config.
from services.asr_backend import MLXWhisperBackend  # noqa: E402


def _silent_wav(path, seconds=0.2, rate=16000):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return str(path)


def test_mlx_decodes_the_audio_instead_of_handing_over_a_path(monkeypatch, tmp_path):
    """A path sends mlx_whisper to a bare "ffmpeg" that need not exist.

    Given a path, mlx_whisper calls whisper.audio.load_audio, which shells out
    to a literal "ffmpeg" on PATH. That is the lookup WhisperX was moved off in
    #479: it cannot find the bundled imageio-ffmpeg binary, whose filename is
    ffmpeg-<plat>-vN. On a from-source install with no system ffmpeg the whole
    request fails with [Errno 2] No such file or directory: ffmpeg -- even
    though the app ships a working binary and resolves it everywhere else.

    Before the fix this asserted on a str and failed.
    """
    seen = {}

    def fake_transcribe(audio, **kw):
        seen["audio"] = audio
        return {
            "language": "en",
            "segments": [{"text": "test", "start": 0.0, "end": 0.2}],
        }

    def fake_forced_align(segments, audio, language_code, device=None):
        seen["aligned_audio"] = audio
        return segments

    monkeypatch.setitem(
        sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=fake_transcribe)
    )
    monkeypatch.setattr("services.asr_backend.forced_align", fake_forced_align)

    backend = MLXWhisperBackend.__new__(MLXWhisperBackend)
    backend._model_name = "mlx-community/whisper-large-v3-mlx"
    backend.transcribe(_silent_wav(tmp_path / "a.wav"), word_timestamps=True)

    audio = seen["audio"]
    assert not isinstance(audio, (str, bytes)), (
        "mlx_whisper was handed a path, so it will resolve ffmpeg itself via a "
        "bare PATH lookup instead of the validated binary find_ffmpeg() returns"
    )
    assert hasattr(audio, "__len__") and len(audio) > 0, "decoded audio is empty"
    assert seen["aligned_audio"] is audio
