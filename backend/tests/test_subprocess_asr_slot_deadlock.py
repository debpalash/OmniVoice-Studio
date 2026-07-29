"""Regression: SubprocessASRBackend.transcribe() must not self-deadlock when
called from a gpu-pool worker.

run_transcribe_guarded dispatches transcribe() via loop.run_in_executor on the
GPU pool, i.e. already on a pool worker. transcribe() used to unconditionally
submit a no-op to the same pool to "acquire a slot"; on a 1-worker pool (MPS)
that queued behind the very job running it and result(timeout=10) raised before
the sidecar spawned. This test reproduces that dispatch shape.
"""
import json
import struct
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest

from services.subprocess_asr import SubprocessASRBackend

STUB_SIDECAR = r'''
import sys, json, struct

def _send(o):
    b = json.dumps(o, separators=(",", ":")).encode()
    sys.stdout.buffer.write(struct.pack("!I", len(b)) + b)
    sys.stdout.buffer.flush()

def _recv():
    h = sys.stdin.buffer.read(4)
    if len(h) < 4:
        return None
    (n,) = struct.unpack("!I", h)
    body = bytearray()
    while len(body) < n:
        c = sys.stdin.buffer.read(n - len(body))
        if not c:
            return None
        body.extend(c)
    return json.loads(bytes(body).decode())

_send({"op": "ready", "engine": "stub-asr", "sample_rate": 16000})
while True:
    m = _recv()
    if m is None:
        sys.exit(0)
    op = m.get("op")
    if op == "ping":
        _send({"op": "pong", "vram_mb": 0.0})
    elif op == "shutdown":
        sys.exit(0)
    elif op == "transcribe":
        _send({"op": "segments", "result": {"segments": [], "language": "en"}})
    else:
        _send({"op": "error", "stage": "dispatch", "message": "unknown op %r" % op})
'''


class _StubASR(SubprocessASRBackend):
    id = "stub-asr"
    display_name = "stub-asr"
    gpu_compat = ("cuda", "mps", "cpu")

    @classmethod
    def is_available(cls):
        return True, "ok"

    @classmethod
    def venv_python(cls):
        return Path(sys.executable)

    @classmethod
    def sidecar_script(cls):
        raise NotImplementedError  # patched per-test

    def _device(self):
        return "cpu"

    @property
    def sample_rate(self):
        return 16000

    @property
    def supported_languages(self):
        return ["multi"]


def test_transcribe_on_pool_worker_does_not_deadlock(tmp_path, monkeypatch):
    stub = tmp_path / "stub_asr.py"
    stub.write_text(STUB_SIDECAR)
    monkeypatch.setattr(_StubASR, "sidecar_script",
                        classmethod(lambda cls: stub))

    import services.model_manager as mm
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu-pool")
    monkeypatch.setattr(mm, "_get_gpu_pool", lambda: pool)

    b = _StubASR()
    try:
        fut = pool.submit(lambda: b.transcribe("/fake.wav"))
        result = fut.result(timeout=30)  # pre-fix: raised ~10s slot timeout
        assert "segments" in result
    finally:
        b.shutdown()
        pool.shutdown(wait=False)
