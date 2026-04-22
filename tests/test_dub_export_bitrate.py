"""Unit tests for the bitrate clamping logic inside /dub/download-mp3.

The handler accepts `bitrate=192k` / `192` / `"1e5k"` / empty etc. and must
normalize to ffmpeg's `Nk` form clamped between 64 and 320 kbps. Malformed
values fall back to 192.
"""
from __future__ import annotations

import pytest


def _clamp(bitrate):
    """Re-implement the inline clamp from dub_export.py so we can unit-test
    it without standing up a full FastAPI app + ffmpeg subprocess."""
    _br = str(bitrate or "192k").lower().rstrip("k") or "192"
    try:
        _br_int = max(64, min(int(_br), 320))
    except ValueError:
        _br_int = 192
    return f"{_br_int}k"


@pytest.mark.parametrize("raw,expected", [
    ("192k", "192k"),
    ("320k", "320k"),
    ("128",  "128k"),
    ("64k",  "64k"),
    ("64",   "64k"),
    ("256K", "256k"),   # case-insensitive
])
def test_clamp_normal_values_pass_through(raw, expected):
    assert _clamp(raw) == expected


@pytest.mark.parametrize("raw", ["32k", "16", "8", "0"])
def test_clamp_below_floor_snaps_to_64k(raw):
    assert _clamp(raw) == "64k"


@pytest.mark.parametrize("raw", ["512k", "1000k", "800", "99999"])
def test_clamp_above_ceiling_snaps_to_320k(raw):
    assert _clamp(raw) == "320k"


@pytest.mark.parametrize("raw", [None, "", "garbage", "1e5k"])
def test_clamp_malformed_falls_back_to_192k(raw):
    """Non-numeric / empty / scientific-notation values hit the ValueError
    branch and get the 192k default."""
    assert _clamp(raw) == "192k"


def test_clamp_negative_int_clamps_to_floor():
    """Negative values parse as int fine but clamp up to the 64k floor —
    not a ValueError case."""
    assert _clamp("-5k") == "64k"


def test_clamp_defaults_192k_on_empty_str():
    """Empty string should also be treated as default, not crash."""
    assert _clamp("") == "192k"
