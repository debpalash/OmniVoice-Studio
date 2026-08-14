"""Regression tests for the lightweight persisted-WAV trust boundary."""
from __future__ import annotations

import struct

from core.audio_validation import is_playable_wav, resolve_regular_file


def test_oversized_declared_wav_payload_is_not_treated_as_playable(tmp_path):
    """A hostile frame count must be bounded and backed by real payload bytes."""
    path = tmp_path / "oversized.wav"
    declared_size = 0xFFFF_FFF0
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        0xFFFF_FFFF,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        24_000,
        48_000,
        2,
        16,
        b"data",
        declared_size,
    )
    path.write_bytes(header + b"\x00\x01")

    assert not is_playable_wav(path)


def test_profile_wav_resolution_rejects_escape_and_symlink(tmp_path, symlinks_supported):
    root = tmp_path / "voices"
    root.mkdir()
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"outside")

    assert resolve_regular_file(root, "../outside.wav") is None
    assert resolve_regular_file(root, str(outside)) is None
    if symlinks_supported:  # Windows needs Developer Mode to create symlinks
        (root / "linked.wav").symlink_to(outside)
        assert resolve_regular_file(root, "linked.wav") is None
