"""yt-dlp must not stamp the download's mtime (#642).

On Windows, yt-dlp stamping the temp file with the video's upload date can raise
`[Errno 22] Invalid argument` from os.utime on an out-of-range timestamp, failing
the whole URL ingest. We download to a throwaway file and never use its mtime, so
`updatetime` must be False.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from services import dub_pipeline  # noqa: E402


def test_download_opts_disable_mtime(tmp_path, monkeypatch):
    import yt_dlp

    captured = {}

    class _FakeYDL:
        def __init__(self, opts):
            captured.update(opts)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def extract_info(self, url, download=True):
            raise RuntimeError("stop after capturing opts")

        def prepare_filename(self, info):
            return "unused"

    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYDL)
    with pytest.raises(Exception):
        dub_pipeline.yt_download_sync("https://youtu.be/abc", str(tmp_path))

    assert captured.get("updatetime") is False, (
        "yt-dlp must set updatetime=False so a bad upload-date timestamp can't "
        "raise [Errno 22] on Windows (#642)"
    )
