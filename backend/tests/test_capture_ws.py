"""Tests for the streaming ASR WebSocket helpers.

Only tests the pure-Python helper functions (no GPU needed).
The WebSocket endpoint itself requires the full app, which we
skip in CI — it's integration-tested via the browser.
"""
import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub heavy deps
import types
for mod_name in ["services.model_manager", "services.asr_backend", "services.ffmpeg_utils"]:
    if mod_name not in sys.modules:
        sys.modules[mod_name] = types.ModuleType(mod_name)

from api.routers.capture_ws import _chunks_to_wav, MIN_BUFFER_BYTES


class TestChunksToWav:
    def test_empty_returns_none(self):
        assert _chunks_to_wav([]) is None

    def test_tiny_returns_none(self):
        assert _chunks_to_wav([b"\x00" * 10]) is None

    def test_below_100_bytes_returns_none(self):
        assert _chunks_to_wav([b"\x00" * 99]) is None


class TestConstants:
    def test_min_buffer_bytes_reasonable(self):
        """MIN_BUFFER_BYTES should be at least 0.25s of 16-bit mono 16kHz."""
        # 16kHz * 2 bytes * 0.25s = 8000
        assert MIN_BUFFER_BYTES >= 8000

    def test_partial_interval_positive(self):
        from api.routers.capture_ws import PARTIAL_INTERVAL_S
        assert PARTIAL_INTERVAL_S > 0

    def test_silence_timeout_positive(self):
        from api.routers.capture_ws import SILENCE_TIMEOUT_S
        assert SILENCE_TIMEOUT_S > 0
