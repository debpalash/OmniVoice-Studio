"""
Tests for the streaming-ASR WebSocket endpoint.

Focus: the EOF text-frame protocol (added so the React `CaptureButton` can
treat the WS `final` message as the source of truth and skip the duplicate
HTTP POST that used to run on every dictation). Ground truth: an EOF text
frame must let the server deliver `final` over the still-open socket
*without* the client having to disconnect first.

The ASR backends are mocked — we're testing protocol, not transcription
quality.
"""
import os
import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")
# Tighten the partial-tick so the test doesn't sit waiting 2 s for the
# silence path.
os.environ["OMNIVOICE_STREAM_INTERVAL"] = "0.1"
os.environ["OMNIVOICE_STREAM_SILENCE"] = "0.2"


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    # Stub the heavy transcription helpers so the test stays in-process.
    from api.routers import capture_ws as cw

    async def fake_partial(_chunks):
        return "hello"

    async def fake_full(_chunks):
        return {
            "text": "hello world",
            "segments": [{"start": 0.0, "end": 1.0, "text": "hello world"}],
            "language": "en",
            "duration_s": 1.0,
            "transcription_time_s": 0.01,
            "engine": "stub",
        }

    monkeypatch.setattr(cw, "_transcribe_buffer", fake_partial)
    monkeypatch.setattr(cw, "_transcribe_buffer_full", fake_full)

    from main import app
    return TestClient(app)


def _audio_chunk(n_bytes: int = 20_000) -> bytes:
    # MIN_BUFFER_BYTES is 16_000 — give the server enough to trigger a partial
    # AND a final.
    return b"\x00" * n_bytes


def test_eof_text_frame_triggers_final_without_disconnect(client):
    """Client sends audio + 'EOF' text frame, expects `final` over open socket."""
    with client.websocket_connect("/ws/transcribe") as ws:
        ws.send_bytes(_audio_chunk())
        ws.send_text("EOF")
        # Drain whatever the server sends (partials may or may not arrive
        # depending on timing). The first message we care about is `final`.
        final = None
        for _ in range(10):
            msg = ws.receive_json()
            if msg.get("type") == "final":
                final = msg
                break
        assert final is not None, "server never delivered final after EOF"
        assert final["text"] == "hello world"
        assert final["engine"] == "stub"


def test_legacy_disconnect_still_finalizes(client):
    """Closing the socket without EOF should still deliver final (legacy path)."""
    # Even if the client closes, the server runs final and *attempts* to send
    # before the close handshake completes. Whether the test client receives
    # it is timing-dependent — we mostly care that no exception bubbles up
    # and the server doesn't deadlock.
    with client.websocket_connect("/ws/transcribe") as ws:
        ws.send_bytes(_audio_chunk())
        # Just close — don't wait. Endpoint should clean up gracefully.


def test_empty_binary_frame_acts_as_eof(client):
    """An empty binary frame is the same end-of-audio signal as 'EOF' text."""
    with client.websocket_connect("/ws/transcribe") as ws:
        ws.send_bytes(_audio_chunk())
        ws.send_bytes(b"")
        final = None
        for _ in range(10):
            msg = ws.receive_json()
            if msg.get("type") == "final":
                final = msg
                break
        assert final is not None
        assert final["engine"] == "stub"
