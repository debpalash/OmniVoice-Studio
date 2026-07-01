"""yt-dlp must merge video+audio with OmniVoice's ffmpeg, not just PATH (#712).

The download format selector pulls separate streams, so yt-dlp muxes them via
ffmpeg. yt-dlp only checks PATH and aborts ("you have requested merging of
multiple formats but ffmpeg is not installed") when ffmpeg is a bundled sidecar
/ imageio binary off PATH (common on Windows). yt_download_sync must pass the
resolved ffmpeg as `ffmpeg_location`.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from services import dub_pipeline  # noqa: E402


class _FakeYDL:
    captured: dict = {}

    def __init__(self, opts):
        type(self).captured = dict(opts)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=True):
        raise RuntimeError("stop after capturing opts")

    def prepare_filename(self, info):
        return "unused"


def test_download_passes_resolved_ffmpeg_location(tmp_path, monkeypatch):
    import yt_dlp

    monkeypatch.setattr(dub_pipeline, "find_ffmpeg", lambda: "/opt/omnivoice/ffmpeg")
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYDL)
    with pytest.raises(Exception):
        dub_pipeline.yt_download_sync("https://youtu.be/abc", str(tmp_path))

    assert _FakeYDL.captured.get("ffmpeg_location") == "/opt/omnivoice/ffmpeg", (
        "yt-dlp must merge formats with OmniVoice's resolved ffmpeg, not just PATH (#712)"
    )


def test_download_omits_ffmpeg_location_when_unresolved(tmp_path, monkeypatch):
    # If we can't resolve ffmpeg, don't pin a bogus location — let yt-dlp try
    # PATH as before (no regression for users who have ffmpeg on PATH).
    import yt_dlp

    monkeypatch.setattr(dub_pipeline, "find_ffmpeg", lambda: None)
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYDL)
    with pytest.raises(Exception):
        dub_pipeline.yt_download_sync("https://youtu.be/abc", str(tmp_path))

    assert "ffmpeg_location" not in _FakeYDL.captured
