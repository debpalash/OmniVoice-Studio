"""Mock IndexTTS sidecar — test fixture for Plan 02-03 Task 2.

Mimics ``backend/engines/indextts/main.py`` without importing the
indextts library. Used by ``tests/backend/services/test_indextts_sidecar.py``
to exercise the SubprocessBackend round-trip and the coexistence-with-
OmniVoice integration test without paying the 6 GB / 20 s cost of
loading the real IndexTTS-2 model.

Wire protocol: length-prefixed JSON over stdin/stdout, identical to the
production sidecar. Stdlib only — runs under the system Python that the
test harness uses.

Op flow (subset of production):
    1. emit {"op": "ready", "engine": "indextts2", "sample_rate": 24000}
    2. parent → {"op": "ping"} → reply {"op": "pong"}
    3. parent → {"op": "synthesize", "text": "...", "ref_audio": "...",
                  ...} → emit {"op": "audio", "audio_pcm_b64": <1 s of
                  0.5-amplitude sine wave>, "sample_rate": 24000,
                  "n_samples": 24000, "forwarded_kwargs": {...}}
    4. parent → {"op": "shutdown"} → exit 0
    5. parent → {"op": "probe_env"} (test-only) → emit
       {"op": "probe_env_result", "keys": {HF_TOKEN, HF_HOME,
        HF_ENDPOINT, HF_HUB_CACHE}}

The audio frame includes ``forwarded_kwargs`` so the parent test can
assert that emotion/duration kwargs survived the JSON round-trip.
``probe_env_result`` is NOT in the parent's PARENT_INBOUND_OPS
allowlist by design — it has to be read off the raw pipe (the
test does that).
"""
from __future__ import annotations

import base64
import json
import math
import os
import struct
import sys
import traceback


MAX_FRAME_BYTES = 64 * 1024 * 1024
SAMPLE_RATE = 24000


def _send(stream, obj):
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("!I", len(body)))
    stream.write(body)
    stream.flush()


def _recv(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    (n,) = struct.unpack("!I", header)
    if n > MAX_FRAME_BYTES:
        raise IOError(f"frame too large: {n}")
    body = bytearray()
    while len(body) < n:
        chunk = stream.read(n - len(body))
        if not chunk:
            raise IOError("short read")
        body.extend(chunk)
    return json.loads(bytes(body).decode("utf-8"))


def _sine_pcm_b64(sample_rate: int = SAMPLE_RATE) -> tuple[str, int]:
    """Return base64-encoded 1 s of 0.5-amplitude 440 Hz sine, int16 PCM.

    Amplitude 0.5 → ``abs(tensor).max() > 0.3`` assertion in the test.
    No numpy dependency — keeps the mock sidecar stdlib-only.
    """
    n = int(sample_rate)
    amp = 0.5
    freq = 440.0
    two_pi_f_over_sr = 2.0 * math.pi * freq / sample_rate
    out = bytearray()
    for i in range(n):
        v = amp * math.sin(two_pi_f_over_sr * i)
        s16 = max(-32768, min(32767, int(v * 32767.0)))
        out += struct.pack("<h", s16)
    return base64.b64encode(bytes(out)).decode("ascii"), n


def main() -> int:
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    _send(stdout, {
        "op": "ready",
        "engine": "indextts2",
        "sample_rate": SAMPLE_RATE,
    })

    while True:
        try:
            msg = _recv(stdin)
        except Exception as exc:
            _send(stdout, {
                "op": "error",
                "stage": "recv",
                "message": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            })
            return 1
        if msg is None:
            return 0

        op = msg.get("op") if isinstance(msg, dict) else None
        try:
            if op == "ping":
                _send(stdout, {"op": "pong"})
            elif op == "synthesize":
                pcm_b64, n_samples = _sine_pcm_b64(SAMPLE_RATE)
                # Echo back the kwargs so the test can assert they were
                # forwarded through the parent's emotion arbitration.
                forwarded = {k: v for k, v in msg.items() if k != "op"}
                _send(stdout, {
                    "op": "audio",
                    "audio_pcm_b64": pcm_b64,
                    "sample_rate": SAMPLE_RATE,
                    "n_samples": n_samples,
                    "forwarded_kwargs": forwarded,
                })
            elif op == "shutdown":
                return 0
            elif op == "probe_env":
                _send(stdout, {
                    "op": "probe_env_result",
                    "keys": {
                        "HF_TOKEN": os.environ.get("HF_TOKEN"),
                        "HF_HOME": os.environ.get("HF_HOME"),
                        "HF_ENDPOINT": os.environ.get("HF_ENDPOINT"),
                        "HF_HUB_CACHE": os.environ.get("HF_HUB_CACHE"),
                    },
                })
            else:
                _send(stdout, {
                    "op": "error",
                    "stage": "dispatch",
                    "message": f"unknown op: {op!r}",
                })
        except Exception as exc:
            _send(stdout, {
                "op": "error",
                "stage": op or "unknown",
                "message": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            })


if __name__ == "__main__":
    sys.exit(main())
