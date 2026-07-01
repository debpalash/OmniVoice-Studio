"""Confucius4-TTS sidecar unit tests (#590 — finalization).

The upstream synthesis API (``confuciustts.cli.inference.ConfuciusTTS`` →
``generate(text, lang, prompt_wav)`` → tensor, ``model.sample_rate``) is
validated against the netease-youdao/Confucius4-TTS repo. Actual audio
generation needs a CUDA 12.6 GPU + the ~2-4 GB checkpoint (Amphion/MaskGCT
codec + w2v-bert-2.0), so it can't run in CI — but the sidecar's *pure* logic
(language normalization, tensor→PCM, config-path resolution, wire framing) and
the bootstrap probe are fully testable here, with the model mocked. These pin
that logic so a real GPU run only has to confirm the model call itself.

The sidecar is stdlib-only at import time (the model/torch imports are lazy),
so we import it directly without spawning the engine venv.
"""
from __future__ import annotations

import base64
import importlib.util
import io
import os
import struct
from pathlib import Path

import numpy as np
import pytest

_SIDECAR = (
    Path(__file__).resolve().parent.parent
    / "backend" / "engines" / "confucius4" / "main.py"
)


def _load_sidecar():
    spec = importlib.util.spec_from_file_location("confucius4_sidecar_main", _SIDECAR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def sc():
    return _load_sidecar()


# ── Language normalization ────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("en", "en"), ("EN", "en"), ("zh", "zh"), ("zh-CN", "zh"),
    ("ja", "ja"), ("", "en"), ("auto", "en"), ("AUTO", "en"),
    (None, "en"), ("Vietnamese", "vi"), ("  fr ", "fr"),
])
def test_normalize_language(sc, raw, expected):
    assert sc._normalize_language(raw) == expected


# ── Tensor → PCM base64 ───────────────────────────────────────────────────

def test_pcm_roundtrip_mono(sc):
    import torch
    t = torch.tensor([0.0, 0.5, -0.5, 1.0, -1.0])
    b64, sr, n = sc._tensor_to_pcm_b64(t, 24000)
    pcm = np.frombuffer(base64.b64decode(b64), dtype=np.int16)
    assert (sr, n) == (24000, 5)
    assert pcm.max() == 32767 and pcm.min() == -32767   # full-scale clamp


def test_pcm_clips_out_of_range(sc):
    import torch
    t = torch.tensor([2.0, -3.0])          # beyond [-1, 1]
    b64, _sr, n = sc._tensor_to_pcm_b64(t, 24000)
    pcm = np.frombuffer(base64.b64decode(b64), dtype=np.int16)
    assert n == 2 and pcm.max() == 32767 and pcm.min() == -32767


def test_pcm_downmixes_stereo(sc):
    import torch
    stereo = torch.tensor([[0.2, 0.4], [0.6, 0.8]])   # (2, 2)
    _b64, _sr, n = sc._tensor_to_pcm_b64(stereo, 24000)
    assert n == 2   # mean over channel dim → 2 samples


def test_pcm_accepts_numpy(sc):
    arr = np.array([0.1, -0.1, 0.0], dtype=np.float32)
    _b64, sr, n = sc._tensor_to_pcm_b64(arr, 16000)
    assert (sr, n) == (16000, 3)


# ── Config path resolution ────────────────────────────────────────────────

def test_config_path_explicit_override(sc, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_CONFUCIUS4_CONFIG", "/x/custom.yaml")
    assert sc._config_path() == "/x/custom.yaml"


def test_config_path_from_clone_dir(sc, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_CONFUCIUS4_CONFIG", raising=False)
    monkeypatch.setenv("OMNIVOICE_CONFUCIUS4_TTS_DIR", "/clone")
    assert sc._config_path() == os.path.join("/clone", "config", "inference_config.yaml")


# ── Wire framing (length-prefixed JSON) ───────────────────────────────────

def test_send_recv_roundtrip(sc):
    buf = io.BytesIO()
    sc._send(buf, {"op": "ready", "engine": "confucius4-tts"})
    buf.seek(0)
    assert sc._recv(buf) == {"op": "ready", "engine": "confucius4-tts"}


def test_recv_eof_returns_none(sc):
    assert sc._recv(io.BytesIO(b"")) is None


def test_recv_rejects_oversize_frame(sc):
    hdr = struct.pack("!I", sc.MAX_FRAME_BYTES + 1)
    with pytest.raises(IOError):
        sc._recv(io.BytesIO(hdr))


# ── synthesize dispatch (model mocked — no GPU/weights) ───────────────────

def test_synthesize_calls_generate_and_emits_audio(sc, monkeypatch):
    import torch

    class _FakeModel:
        sample_rate = 22050

        def generate(self, **kw):
            _FakeModel.last_kwargs = kw
            return torch.tensor([0.0, 1.0, -1.0])

    monkeypatch.setattr(sc, "_load_model", lambda stdout: _FakeModel())
    out = io.BytesIO()
    sc._handle_synthesize(
        {"text": "hello", "language": "AUTO", "ref_audio": "/ref.wav"}, out,
    )
    out.seek(0)
    frame = sc._recv(out)
    assert frame["op"] == "audio"
    assert frame["sample_rate"] == 22050        # read from model.sample_rate
    assert frame["n_samples"] == 3
    # language normalized, ref audio forwarded as prompt_wav
    assert _FakeModel.last_kwargs == {"text": "hello", "lang": "en", "prompt_wav": "/ref.wav"}


def test_synthesize_rejects_empty_text(sc):
    with pytest.raises(ValueError, match="text"):
        sc._handle_synthesize({"text": ""}, io.BytesIO())
