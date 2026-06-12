"""Crash-isolated faster-whisper ASR sidecar (Wave 4.2 / Spec 7).

Runs faster-whisper in a child process so a CTranslate2 GPU-teardown segfault
becomes a failed job, not a dead backend. Speaks the SubprocessBackend wire
protocol (length-prefixed JSON over stdin/stdout):

    on start          → {"op":"ready","engine":"faster-whisper-isolated"}
    {"op":"ping"}     → {"op":"pong"}
    {"op":"transcribe","audio_path":...,"word_timestamps":bool}
                      → {"op":"segments","result":{"segments":[...],"language":...}}
    {"op":"shutdown"} → exit 0
    error             → {"op":"error","message":...}

Runs under the PARENT venv (faster-whisper is already a dependency) — only the
process boundary is new. torch/CTranslate2 import lazily inside transcribe so
the ready handshake fits the spawn timeout.
"""
from __future__ import annotations

import json
import os
import struct
import sys
import traceback

MAX_FRAME_BYTES = 64 * 1024 * 1024
_model = None


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


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        name = os.environ.get("ASR_MODEL_FW", "large-v3")
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
        compute = "float16" if device == "cuda" else "int8"
        _model = WhisperModel(name, device=device, compute_type=compute)
    return _model


def _transcribe(audio_path, word_timestamps):
    model = _get_model()
    segments, info = model.transcribe(audio_path, word_timestamps=word_timestamps)
    out = []
    for s in segments:
        seg = {"start": float(s.start), "end": float(s.end), "text": s.text}
        if word_timestamps and getattr(s, "words", None):
            seg["words"] = [
                {"word": w.word, "start": float(w.start), "end": float(w.end),
                 "probability": float(getattr(w, "probability", 0.0))}
                for w in s.words
            ]
        out.append(seg)
    return {
        "segments": out,
        "text": " ".join(s["text"].strip() for s in out).strip(),
        "language": getattr(info, "language", "unknown"),
    }


def main() -> int:
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    _send(stdout, {"op": "ready", "engine": "faster-whisper-isolated"})
    while True:
        try:
            msg = _recv(stdin)
        except Exception as exc:
            _send(stdout, {"op": "error", "stage": "recv", "message": f"{type(exc).__name__}: {exc}"})
            return 1
        if msg is None:
            return 0
        op = msg.get("op")
        try:
            if op == "ping":
                _send(stdout, {"op": "pong"})
            elif op == "transcribe":
                result = _transcribe(msg.get("audio_path"), bool(msg.get("word_timestamps", True)))
                _send(stdout, {"op": "segments", "result": result})
            elif op == "shutdown":
                return 0
            else:
                _send(stdout, {"op": "error", "stage": "dispatch", "message": f"unknown op: {op!r}"})
        except Exception as exc:
            _send(stdout, {
                "op": "error", "stage": "handler",
                "message": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            })
    return 0


if __name__ == "__main__":
    sys.exit(main())
