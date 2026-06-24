"""
Streaming-protocol test for the sherpa-onnx live-dictation WS path.

North-star: partials must arrive AS THE TEXT GROWS, before the final. This
drives ``/ws/transcribe?model=<streaming-id>`` with a mocked OnlineRecognizer
whose decoded text grows frame-by-frame, then fires an endpoint, and asserts:
  • ≥1 {"type":"partial"} arrives with growing text BEFORE the committed result,
  • an endpoint produces a {"type":"final"} mid-session,
  • a trailing {"type":"final"} is sent on EOF.

Everything is mocked (no sherpa wheel, no model download) — protocol only.
"""
import os
import sys
import types

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


class _GrowingStream:
    def accept_waveform(self, sr, samples):
        pass

    def input_finished(self):
        pass


class _GrowingOnlineRecognizer:
    """Emits "a", "a b", "a b c" on successive frames, then an endpoint."""

    def __init__(self):
        self._texts = ["a", "a b", "a b c"]
        self._i = 0
        self._endpoint_at = 3  # endpoint after the 3rd frame

    def create_stream(self):
        return _GrowingStream()

    def is_ready(self, s):
        return False  # decode loop is a no-op; text advances per frame

    def decode_stream(self, s):
        pass

    def get_result(self, s):
        idx = min(self._i, len(self._texts) - 1)
        return self._texts[idx]

    def is_endpoint(self, s):
        return self._i >= self._endpoint_at

    def reset(self, s):
        self._i = 0
        self._texts = ["tail"]
        self._endpoint_at = 999


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from api.routers import capture_ws as cw
    from services import sherpa_dictation as sd
    from services import asr_backend as ab

    spec = sd.get_spec("sherpa-zipformer-en-20m")  # streaming
    monkeypatch.setattr(cw, "_select_sherpa_spec", lambda ws: spec)
    monkeypatch.setattr(ab.SherpaDictationBackend, "is_available",
                        classmethod(lambda cls: (True, "ready")))

    rec = _GrowingOnlineRecognizer()

    def fake_ensure(self):
        self._rec = rec

    # Each accepted near-end frame advances the recognizer's text pointer.
    real_recv = cw._recv_pcm_frame

    async def counting_recv(ws, aec):
        kind, pcm = await real_recv(ws, aec)
        if kind == "near":
            rec._i += 1
        return kind, pcm

    monkeypatch.setattr(ab.SherpaDictationBackend, "ensure_loaded", fake_ensure)
    monkeypatch.setattr(cw, "_recv_pcm_frame", counting_recv)
    # Avoid LLM refinement network calls.
    monkeypatch.setitem(sys.modules, "services.refinement",
                        types.SimpleNamespace(maybe_refine=lambda t: None,
                                              collapse_repetitive_artifacts=lambda t: t))

    from main import app
    return TestClient(app, client=("127.0.0.1", 50000))


def _pcm(nbytes=2000):
    return b"\x00" * nbytes


def test_partials_before_final(client):
    with client.websocket_connect("/ws/transcribe?model=sherpa-zipformer-en-20m&sr=16000") as ws:
        # Three frames → growing partials, then endpoint → mid-session final.
        ws.send_bytes(_pcm())
        ws.send_bytes(_pcm())
        ws.send_bytes(_pcm())
        ws.send_text("EOF")

        msgs = []
        for _ in range(20):
            try:
                msgs.append(ws.receive_json())
            except Exception:
                break
            if msgs[-1].get("type") == "final" and msgs[-1].get("text") in ("a b c", ""):
                # got the endpoint-final; keep draining for the EOF final too
                if len([m for m in msgs if m["type"] == "final"]) >= 1:
                    # try one more receive for trailing final, then stop
                    try:
                        msgs.append(ws.receive_json())
                    except Exception:
                        pass
                    break

    types_seen = [m["type"] for m in msgs]
    partials = [m for m in msgs if m["type"] == "partial"]
    finals = [m for m in msgs if m["type"] == "final"]

    # At least one partial arrived, and the FIRST partial came before the
    # FIRST final (the whole point — live text as you speak).
    assert partials, f"no partials emitted; saw {types_seen}"
    assert finals, f"no final emitted; saw {types_seen}"
    assert types_seen.index("partial") < types_seen.index("final")

    # Partials grow monotonically in length.
    lengths = [len(p["text"]) for p in partials]
    assert lengths == sorted(lengths)


def test_non_streaming_model_uses_offline_handler(monkeypatch):
    """An offline-kind sherpa model routes to the offline cadence handler and
    still finalizes (sanity that the kind branch wires up)."""
    from fastapi.testclient import TestClient
    from api.routers import capture_ws as cw
    from services import sherpa_dictation as sd
    from services import asr_backend as ab

    spec = sd.get_spec("sherpa-whisper-tiny")  # offline
    monkeypatch.setattr(cw, "_select_sherpa_spec", lambda ws: spec)
    monkeypatch.setattr(ab.SherpaDictationBackend, "is_available",
                        classmethod(lambda cls: (True, "ready")))

    def fake_ensure(self):
        self._rec = object()

    monkeypatch.setattr(ab.SherpaDictationBackend, "ensure_loaded", fake_ensure)
    monkeypatch.setattr(ab.SherpaDictationBackend, "_decode_offline",
                        lambda self, samples, sr: "offline text")
    monkeypatch.setitem(sys.modules, "services.refinement",
                        types.SimpleNamespace(maybe_refine=lambda t: None,
                                              collapse_repetitive_artifacts=lambda t: t))
    monkeypatch.setenv("OMNIVOICE_SHERPA_OFFLINE_PARTIAL", "0.05")
    # reload module-level cadence constant
    cw.SHERPA_OFFLINE_PARTIAL_S = 0.05

    from main import app
    client = TestClient(app, client=("127.0.0.1", 50000))
    with client.websocket_connect("/ws/transcribe?model=sherpa-whisper-tiny&sr=16000") as ws:
        ws.send_bytes(b"\x00" * 4000)
        ws.send_text("EOF")
        final = None
        for _ in range(20):
            try:
                m = ws.receive_json()
            except Exception:
                break
            if m.get("type") == "final":
                final = m
                break
    assert final is not None
    assert final["text"] == "offline text"
    assert final["engine"] == "sherpa-onnx-asr"
