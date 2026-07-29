"""Regression: an off-pool SubprocessBackend.generate() must HOLD its GPU-pool
slot for the whole synthesis, not just queue-wait.

Pre-fix, the slot was a bare no-op that completed the instant a worker picked
it up, releasing the worker before _spawn(). So an off-pool caller (engine
self-test, diagnostics) could synthesize concurrently with an in-flight pool
job and over-subscribe a 1-worker GPU. This test reproduces that: while an
off-pool generate is mid-synthesis, a second pool job must stay blocked.
"""
import base64
import json
import math
import array
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from services.subprocess_backend import SubprocessBackend

# Stub sidecar that SLEEPS during synthesize so the test can observe whether
# the slot is held for the synth duration.
STUB_SIDECAR = r'''
import sys, json, struct, math, array, base64, time

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
        time.sleep(2)  # hold the synth so the test can inspect the held slot
        sr = 24000
        pcm = array.array("h", (int(32767 * math.sin(2 * math.pi * 440 * i / sr)) for i in range(sr)))
        _send({"op": "audio", "audio_pcm_b64": base64.b64encode(pcm.tobytes()).decode(),
               "sample_rate": sr, "n_samples": sr})
    else:
        _send({"op": "error", "stage": "dispatch", "message": "unknown op %r" % op})
'''


class _StubBackend(SubprocessBackend):
    id = "stub-hold"
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


def test_off_pool_generate_holds_slot_for_synthesis(tmp_path, monkeypatch):
    stub = tmp_path / "stub_sidecar.py"
    stub.write_text(STUB_SIDECAR)
    monkeypatch.setattr(_StubBackend, "sidecar_script",
                        classmethod(lambda cls: stub))

    import services.model_manager as mm
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu-pool")
    monkeypatch.setattr(mm, "_get_gpu_pool", lambda: pool)

    b = _StubBackend()
    box = {}

    def _gen():
        try:
            b.generate("off-pool")
        except Exception as exc:  # noqa: BLE001
            box["error"] = exc

    gen_thread = threading.Thread(target=_gen, name="off-pool-caller", daemon=True)
    gen_thread.start()
    time.sleep(0.8)  # let it acquire the slot and reach the stub's sleep

    # A second pool job must NOT run while the off-pool generate holds the
    # 1-worker pool's slot. Pre-fix (bare no-op), the worker was already free
    # and this would complete immediately.
    marker = pool.submit(lambda: "ran")
    time.sleep(0.5)
    assert not marker.done(), "pool job ran during the off-pool synth (slot was not held)"

    gen_thread.join(timeout=30)
    assert "error" not in box, f"generate failed: {box.get('error')}"
    assert marker.result(timeout=5) == "ran"  # ran once the slot was released

    b.shutdown()
    pool.shutdown(wait=False)
