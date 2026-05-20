"""Unit + integration tests for backend/engines/omnivoice_gguf (Plan 04-01).

Behavioural coverage matches the plan's <verify> bullets:

  * quant_map.json round-trips through json.load(), schema_version is 1,
    every compute class has base+tokenizer keys with valid filenames,
    and _meta.source_commit_sha / _meta.runtime_commit_sha are real
    40-char hex SHAs.
  * is_available() returns (False, reason) when the binary is missing.
  * is_available() returns (False, reason) on SHA-256 mismatch against
    bin/checksums.sha256.
  * probe_load() raises subprocess.TimeoutExpired when the binary hangs
    past the timeout.
  * generate() with a stubbed subprocess that writes a known 3-second
    24 kHz WAV returns a torch.Tensor of shape (1, 72000).
  * select_default_engine() returns "omnivoice-gguf" when probe succeeds
    and "omnivoice" when it fails (mocked).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest


QUANT_FILENAME_RE = re.compile(
    r"omnivoice-(base|tokenizer)-(Q4_K_M|Q8_0|BF16|F32)\.gguf"
)


def test_quant_map_valid():
    """GGUF-02 — quant_map.json is well-formed and pinned to real SHAs."""
    from engines.omnivoice_gguf.backend import _PKG_DIR  # type: ignore[attr-defined]

    quant_map_path = _PKG_DIR / "quant_map.json"
    assert quant_map_path.is_file(), quant_map_path

    with quant_map_path.open() as f:
        data = json.load(f)

    meta = data.get("_meta")
    assert isinstance(meta, dict), "quant_map.json must have _meta block"
    assert meta["schema_version"] == 1
    assert meta["source_model"] == "Serveurperso/OmniVoice-GGUF"
    assert meta["runtime"] == "omnivoice.cpp"

    for key in ("source_commit_sha", "runtime_commit_sha"):
        sha = meta[key]
        assert isinstance(sha, str)
        assert re.fullmatch(r"[0-9a-fA-F]{40}", sha), (
            f"{key} must be a 40-char hex SHA (ADR requires real pin); got {sha!r}"
        )

    for compute_class in ("cpu", "low-vram", "mid-vram", "high-vram"):
        assert compute_class in data, f"missing compute class: {compute_class}"
        entry = data[compute_class]
        assert isinstance(entry, dict)
        for k in ("base", "tokenizer"):
            assert k in entry
            assert QUANT_FILENAME_RE.fullmatch(entry[k]), (
                f"{compute_class}.{k} = {entry[k]!r} doesn't match quant filename pattern"
            )

    # Any _extras override-only entries (e.g. F32) must follow the same
    # filename pattern so the allow-list stays defensible against
    # T-04-05 freeform paths.
    if "_extras" in data:
        for sub_key, sub_entry in data["_extras"].items():
            if not isinstance(sub_entry, dict) or "base" not in sub_entry:
                continue
            for k in ("base", "tokenizer"):
                assert QUANT_FILENAME_RE.fullmatch(sub_entry[k]), (
                    f"_extras.{sub_key}.{k} = {sub_entry[k]!r} doesn't match pattern"
                )


def test_is_available_when_binary_missing(monkeypatch, tmp_path):
    """GGUF-03 — engine reports unavailable cleanly when the binary file
    is absent on this platform."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()

    # Point _binary_path at a non-existent file.
    monkeypatch.setattr(
        gguf_backend,
        "_binary_path",
        lambda slug=None: tmp_path / "does-not-exist",
    )
    ok, reason = cls.is_available()
    assert ok is False
    assert "missing" in reason.lower()


def test_is_available_when_sha_mismatch(monkeypatch, tmp_path):
    """T-04-01 — bundled-binary tampering detection."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()

    # Create a fake binary on disk with known contents.
    fake_bin = tmp_path / "omnivoice-tts-linux-x86_64"
    fake_bin.write_bytes(b"hello world")
    monkeypatch.setattr(gguf_backend, "_binary_path", lambda slug=None: fake_bin)

    # Force the manifest loader to return a WRONG checksum.
    monkeypatch.setattr(
        gguf_backend,
        "_load_checksum_manifest",
        lambda: {"omnivoice-tts-linux-x86_64": "0" * 64},
    )
    # macOS quarantine detection is no-op on non-darwin; on darwin we
    # also need to short-circuit it for this test.
    monkeypatch.setattr(gguf_backend, "_is_macos_quarantined", lambda p: False)

    ok, reason = cls.is_available()
    assert ok is False
    assert "checksum mismatch" in reason.lower()


def test_is_available_passes_when_manifest_absent(monkeypatch, tmp_path):
    """When checksums.sha256 is missing we still report ready — the manifest
    is an integrity check, not a hard requirement (binaries are bundled
    via the installer, not by `pip`)."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()

    fake_bin = tmp_path / "omnivoice-tts-linux-x86_64"
    fake_bin.write_bytes(b"placeholder")
    monkeypatch.setattr(gguf_backend, "_binary_path", lambda slug=None: fake_bin)
    monkeypatch.setattr(gguf_backend, "_load_checksum_manifest", lambda: {})
    monkeypatch.setattr(gguf_backend, "_is_macos_quarantined", lambda p: False)

    ok, reason = cls.is_available()
    assert ok is True, reason


def test_probe_load_timeout(monkeypatch, tmp_path):
    """T-04-06 — a hung binary surfaces as subprocess.TimeoutExpired."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()

    fake_bin = tmp_path / "omnivoice-tts-linux-x86_64"
    fake_bin.write_bytes(b"placeholder")
    monkeypatch.setattr(gguf_backend, "_binary_path", lambda slug=None: fake_bin)
    monkeypatch.setattr(gguf_backend, "_load_checksum_manifest", lambda: {})
    monkeypatch.setattr(gguf_backend, "_is_macos_quarantined", lambda p: False)

    def _hang(*a, **kw):
        raise subprocess.TimeoutExpired(cmd=a[0] if a else "x", timeout=0.1)

    monkeypatch.setattr(subprocess, "run", _hang)

    with pytest.raises(subprocess.TimeoutExpired):
        cls.probe_load(timeout=0.1)


def test_probe_load_filenotfound(monkeypatch, tmp_path):
    """A missing binary surfaces as RuntimeError from is_available
    (not FileNotFoundError) because is_available short-circuits first."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()
    monkeypatch.setattr(
        gguf_backend,
        "_binary_path",
        lambda slug=None: tmp_path / "missing",
    )
    with pytest.raises(RuntimeError):
        cls.probe_load(timeout=1.0)


def _write_3s_wav(out_path: Path, sr: int = 24_000) -> None:
    """Write a 3-second 24 kHz mono WAV of low-amplitude sine to ``out_path``."""
    import math
    import struct
    import wave

    n = sr * 3  # 3 seconds
    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit PCM
        w.setframerate(sr)
        for i in range(n):
            sample = int(1000 * math.sin(2 * math.pi * 440 * i / sr))
            w.writeframesraw(struct.pack("<h", sample))


def test_generate_returns_tensor_from_stub_wav(monkeypatch, tmp_path):
    """T-04 happy path: a stubbed subprocess writes a 3-second 24 kHz WAV
    to the `-o` path, the backend reads it back as a (1, 72000) float32
    tensor."""
    from engines.omnivoice_gguf import backend as gguf_backend
    import torch

    cls = gguf_backend._make_backend_class()
    backend = cls()

    # Avoid touching huggingface_hub — fake the path resolver.
    fake_base = tmp_path / "omnivoice-base-Q8_0.gguf"
    fake_tok = tmp_path / "omnivoice-tokenizer-Q8_0.gguf"
    fake_base.write_bytes(b"x")
    fake_tok.write_bytes(b"x")
    monkeypatch.setattr(
        backend,
        "_resolve_quant_paths",
        lambda: (fake_base, fake_tok, {"base": "omnivoice-base-Q8_0.gguf",
                                       "tokenizer": "omnivoice-tokenizer-Q8_0.gguf"}),
    )

    # Stub the binary path itself — we won't spawn anything.
    monkeypatch.setattr(
        gguf_backend, "_binary_path", lambda slug=None: tmp_path / "fake-omnivoice-tts",
    )

    # Stub subprocess.run: extract the `-o` arg from argv, write a real
    # 3-second WAV to it, return success.
    captured: dict = {}

    def _stub_run(argv, *, input=None, text=None, capture_output=None,
                  timeout=None, check=None, **_kw):
        # Find the -o arg and write a WAV there.
        for i, a in enumerate(argv):
            if a == "-o":
                _write_3s_wav(Path(argv[i + 1]))
                break
        captured["argv"] = argv
        captured["stdin"] = input
        return subprocess.CompletedProcess(args=argv, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", _stub_run)

    tensor = backend.generate("hello world")
    assert isinstance(tensor, torch.Tensor)
    assert tensor.shape == (1, 72_000), tensor.shape
    assert tensor.dtype == torch.float32

    # Sanity-check the argv shape — uses --model, --codec, -o, no shell.
    argv = captured["argv"]
    assert "--model" in argv
    assert "--codec" in argv
    assert "-o" in argv
    assert captured["stdin"] == "hello world"


def test_generate_blocks_freeform_ref_audio(monkeypatch, tmp_path):
    """T-04-02 — ref_audio path that doesn't exist is rejected before
    spawning the subprocess."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()
    backend = cls()

    fake_base = tmp_path / "b.gguf"
    fake_tok = tmp_path / "t.gguf"
    fake_base.write_bytes(b"x")
    fake_tok.write_bytes(b"x")
    monkeypatch.setattr(
        backend,
        "_resolve_quant_paths",
        lambda: (fake_base, fake_tok, {"base": "b", "tokenizer": "t"}),
    )
    monkeypatch.setattr(
        gguf_backend, "_binary_path", lambda slug=None: tmp_path / "fake",
    )

    # subprocess.run would never be called if validation works; if it
    # does run we'd FAIL.
    def _explode(*a, **kw):
        raise AssertionError("subprocess.run should not have been called")

    monkeypatch.setattr(subprocess, "run", _explode)

    with pytest.raises(FileNotFoundError):
        backend.generate("hi", ref_audio="/etc/shadow")


def test_select_default_returns_gguf_on_success(monkeypatch):
    """GGUF-05 happy path — probe + load succeed → "omnivoice-gguf" wins."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()
    monkeypatch.setattr(cls, "is_available", classmethod(lambda c: (True, "ready")))
    monkeypatch.setattr(cls, "probe_load", classmethod(lambda c, **k: None))

    assert gguf_backend.select_default_engine() == "omnivoice-gguf"


def test_select_default_falls_back_on_probe_failure(monkeypatch):
    """GGUF-05 fallback — probe failure → in-process "omnivoice"."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()
    monkeypatch.setattr(cls, "is_available", classmethod(lambda c: (True, "ready")))

    def _boom(c, **k):
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(cls, "probe_load", classmethod(_boom))
    assert gguf_backend.select_default_engine() == "omnivoice"


def test_select_default_falls_back_when_unavailable(monkeypatch):
    """GGUF-05 fallback — is_available False → in-process "omnivoice"."""
    from engines.omnivoice_gguf import backend as gguf_backend

    cls = gguf_backend._make_backend_class()
    monkeypatch.setattr(
        cls,
        "is_available",
        classmethod(lambda c: (False, "binary missing")),
    )
    assert gguf_backend.select_default_engine() == "omnivoice"


def test_registry_resolves_omnivoice_gguf_lazily():
    """The _LAZY_REGISTRY plumbing should produce the backend class on
    first `_REGISTRY["omnivoice-gguf"]` access without forcing the
    huggingface_hub / torch chain at module-load time."""
    from services.tts_backend import _REGISTRY, _LAZY_REGISTRY

    assert "omnivoice-gguf" in _LAZY_REGISTRY
    cls = _REGISTRY["omnivoice-gguf"]
    assert cls.id == "omnivoice-gguf"
    assert cls.display_name == "OmniVoice (GGUF, hardware-adaptive)"


def test_no_shell_true_in_engine_code():
    """Plan 04-01 verification: no `shell=True` token in the engine
    package's executable source — only in docstring prose that explains
    why we don't use it.

    Use a Python tokenizer so the check is robust against the multiple
    docstrings that legitimately mention the term in prose (e.g.
    "Never uses ``shell=True``").
    """
    import io
    import tokenize

    from engines.omnivoice_gguf.backend import _PKG_DIR

    for path in _PKG_DIR.rglob("*.py"):
        source = path.read_text()
        toks = tokenize.tokenize(io.BytesIO(source.encode("utf-8")).readline)
        prev_name: str | None = None
        prev_op: str | None = None
        for tok in toks:
            if tok.type == tokenize.NAME and tok.string == "shell":
                prev_name = "shell"
                continue
            if prev_name == "shell" and tok.type == tokenize.OP and tok.string == "=":
                prev_op = "="
                prev_name = None
                continue
            if prev_op == "=" and tok.type == tokenize.NAME and tok.string == "True":
                raise AssertionError(
                    f"shell=True found at {path}:{tok.start[0]}"
                )
            prev_name = None
            prev_op = None
