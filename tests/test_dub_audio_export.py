"""#119 — audio-only dubbing export.

The audio-only branch of /dub/download builds a simple ffmpeg command that
muxes the dubbed track (optionally mixed with the separated background) into an
audio container — no video input, no video codec/stream-map/subtitle pass.
"""
from __future__ import annotations

from api.routers.dub_export import _build_audio_export_cmd


def _flat(cmd):
    return " ".join(cmd)


def test_wav_track_only_no_video():
    cmd = _build_audio_export_cmd("ffmpeg", "/j/dubbed_de.wav", None, "/j/out.wav", "wav")
    s = _flat(cmd)
    # the dubbed track is the only input; never the source media / a video map
    assert cmd.count("-i") == 1
    assert "/j/dubbed_de.wav" in s
    assert "-map" not in s or "0:v" not in s  # no video stream mapping
    assert "-c:v" not in s                    # no video codec
    assert "pcm_s16le" in s                   # wav → PCM
    assert cmd[-1] == "/j/out.wav"


def test_m4a_uses_aac():
    cmd = _build_audio_export_cmd("ffmpeg", "/j/dubbed_de.wav", None, "/j/out.m4a", "m4a")
    s = _flat(cmd)
    assert "aac" in s
    assert "-c:v" not in s


def test_mp3_uses_lame():
    cmd = _build_audio_export_cmd("ffmpeg", "/j/dubbed_de.wav", None, "/j/out.mp3", "mp3")
    assert "libmp3lame" in _flat(cmd)


def test_background_mix_adds_amix_and_second_input():
    cmd = _build_audio_export_cmd("ffmpeg", "/j/dubbed_de.wav", "/j/no_vocals.wav", "/j/out.m4a", "m4a")
    s = _flat(cmd)
    assert cmd.count("-i") == 2              # track + background
    assert "/j/no_vocals.wav" in s
    assert "amix" in s                       # mixed, not just concatenated
    assert "-filter_complex" in s


def test_unknown_format_falls_back_to_aac_m4a():
    # Defensive: an unexpected format string must not produce a broken command.
    cmd = _build_audio_export_cmd("ffmpeg", "/j/dubbed_de.wav", None, "/j/out.bin", "weird")
    assert "aac" in _flat(cmd)
