"""FDL-09: the segmented (multi-connection) downloader is ON by default.

The app forces the legacy-LFS path (HF_HUB_DISABLE_XET=1) for clear progress,
which is single-stream and slow. The segmented accelerator restores parallel
byte-range speed with a safe fallback to snapshot_download — so it ships ON by
default for fast first-run downloads. This pins the default so it can't silently
regress to opt-in, and that the env override still disables it.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from api.routers.setup.download import _segmented_enabled  # noqa: E402


def test_segmented_is_on_by_default(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_SEGMENTED_DOWNLOAD", raising=False)
    assert _segmented_enabled() is True


def test_env_override_can_disable(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_SEGMENTED_DOWNLOAD", "0")
    assert _segmented_enabled() is False


def test_env_override_truthy_keeps_it_on(monkeypatch):
    for val in ("1", "true", "on", "yes"):
        monkeypatch.setenv("OMNIVOICE_SEGMENTED_DOWNLOAD", val)
        assert _segmented_enabled() is True
