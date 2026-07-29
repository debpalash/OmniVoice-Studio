"""Regression: SubprocessBackend.generate() must not self-deadlock when called
from a gpu-pool worker.

/v1/audio/speech and /generate dispatch backend.generate() via
run_on_gpu_pool_guarded, i.e. already ON a gpu-pool worker. generate() used to
unconditionally submit a no-op to the same pool to "acquire a slot"; on a
1-worker pool (MPS) that submit queued behind the very job running it and
result(timeout=10) raised before the sidecar spawned. This test reproduces that
dispatch shape (generate on a pool worker) against a stub sidecar.
"""
import base64
import json
import math
import array
import sys
from pathlib import Path

import pytest

from services.subprocess_backend import SubprocessBackend

# Model-free stub sidecar: speaks the length-prefixed-JSON protocol and returns
# a 1s sine wave for any synthesize.
STUB_SIDECAR = r'''
import sys, json, struct, math, array, base64

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

_send({"op": "ready", "engine": "stub", "sample_rate": 24000})
while True:
    m = _recv()
    if m is None:
        sys.exit(0)
    op = m.get("op")
    if op == "ping":
        _send({"op": "pong", "vram_mb": 0.0})
    elif op == "shutdown":
        sys.exit(0)
    elif op == "synthesize":
        sr = 24000
        pcm = array.array("h", (int(32767 * math.sin(2 * math.pi * 440 * i / sr)) for i in range(sr)))
        _send({"op": "audio", "audio_pcm_b64": base64.b64encode(pcm.tobytes()).decode(),
               "sample_rate": sr, "n_samples": sr})
    else:
        _send({"op": "error", "stage": "dispatch", "message": "unknown op %r" % op})
'''


class _StubSubprocessBackend(SubprocessBackend):
    """Minimal concrete SubprocessBackend pointing at the stub sidecar."""
    id = "stub-subprocess"
    display_name = "stub"
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

    @property
    def sample_rate(self):
        return 24000

    @property
    def supported_languages(self):
        return ["multi"]


def test_generate_on_pool_worker_does_not_deadlock(tmp_path, monkeypatch):
    # Mirror /v1/audio/speech + /generate: dispatch generate() ON a gpu-pool
    # worker. Force a 1-worker pool so the self-deadlock reproduces
    # deterministically regardless of host (the ambient pool may have >1
    # worker): pre-fix, generate()'s inner slot-submit queued behind this very
    # job and slot_future.result(timeout=10) raised at ~10s, before the sidecar
    # spawned.
    stub = tmp_path / "stub_sidecar.py"
    stub.write_text(STUB_SIDECAR)
    monkeypatch.setattr(_StubSubprocessBackend, "sidecar_script",
                        classmethod(lambda cls: stub))

    from concurrent.futures import ThreadPoolExecutor
    import services.model_manager as mm
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu-pool")
    monkeypatch.setattr(mm, "_get_gpu_pool", lambda: pool)

    b = _StubSubprocessBackend()
    try:
        fut = pool.submit(lambda: b.generate("on-pool"))
        tensor = fut.result(timeout=30)  # pre-fix: raised ~10s slot timeout
        assert tensor.shape[1] == 24000
    finally:
        b.shutdown()
        pool.shutdown(wait=False)
