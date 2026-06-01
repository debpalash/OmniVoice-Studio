"""Tests for the streaming ASR WebSocket helpers.

Only tests the pure-Python helper functions (no GPU needed).
The WebSocket endpoint itself requires the full app, which we
skip in CI — it's integration-tested via the browser.
"""
import os
import sys

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


class TestLoopbackGuard:
    """Source-level guard against regressing the WS loopback contract.

    Same shape as tests/test_bind_host.py: these don't run the endpoint
    (which needs the full app + a WebSocket client). They read the source
    and assert the guard is present. If a future refactor removes the inline
    check, this test fails with a pointer to the security rationale.

    Why a source-level guard: the /ws/transcribe socket streams the user's
    live microphone audio. Any local process opening this WS without an
    origin check could exfiltrate dictation in real time. HTTP routers use
    Depends(require_loopback) at router level; WebSocket dependency
    injection is brittle across FastAPI versions, so the guard is inlined.
    """

    def _src(self):
        from pathlib import Path
        return (
            Path(__file__).resolve().parent.parent
            / "api" / "routers" / "capture_ws.py"
        ).read_text(encoding="utf-8")

    def test_ws_transcribe_references_loopback_hosts(self):
        assert "_LOOPBACK_HOSTS" in self._src(), (
            "capture_ws.py no longer references _LOOPBACK_HOSTS — the WS "
            "loopback guard has been removed. Reinstate it before accept()."
        )

    def test_ws_transcribe_closes_non_loopback_with_1008(self):
        assert "websocket.close(code=1008" in self._src(), (
            "capture_ws.py must close non-loopback connections with code "
            "1008 (Policy Violation) before calling websocket.accept(). "
            "Otherwise any local process can stream the user's microphone."
        )

    def test_guard_runs_before_accept(self):
        src = self._src()
        # The close() call must appear before the first accept() in the
        # ws_transcribe handler, otherwise an attacker gets a window where
        # the WS is open and can send audio frames.
        close_idx = src.find("websocket.close(code=1008")
        accept_idx = src.find("await websocket.accept()")
        assert 0 <= close_idx < accept_idx, (
            "websocket.close(code=1008) must appear before "
            "websocket.accept() — the guard runs *before* the handshake "
            "completes so non-loopback origins never see an open socket."
        )
