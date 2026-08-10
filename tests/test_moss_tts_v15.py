"""Tests for the MOSS-TTS-v1.5 engine (issue #498).

MOSS-TTS-v1.5 runs in a dedicated subprocess venv (transformers==5.0.0),
isolated from the parent's transformers>=5.3 — so these tests never import
MOSS itself. They exercise the parent-side wiring that ships in the default
install: registry resolution, subprocess isolation, hardware honesty, the
not-installed gate, and the generate() kwarg arbitration. No network, no
optional deps, no subprocess spawn.
"""
from __future__ import annotations

import importlib
import sys

import pytest


# ── registry wiring ────────────────────────────────────────────────────────


def test_registry_contains_moss_tts_v15():
    """``_REGISTRY["moss-tts-v15"]`` resolves to ``MossTTSV15Backend`` and is
    flagged subprocess-isolated."""
    from services.tts_backend import _REGISTRY, get_backend_class

    assert "moss-tts-v15" in _REGISTRY, (
        "_REGISTRY is missing 'moss-tts-v15'; check _LAZY_REGISTRY in "
        "services/tts_backend.py"
    )
    cls = _REGISTRY["moss-tts-v15"]
    assert cls.__name__ == "MossTTSV15Backend"
    assert get_backend_class("moss-tts-v15") is cls
    # Duck-typed marker survives sys.modules['services.*'] purges (the same
    # reason list_backends/test_supertonic3 rely on it instead of issubclass).
    assert getattr(cls, "_is_subprocess_isolated", False), (
        "MossTTSV15Backend should be subprocess-isolated"
    )
    for name in ("is_available", "generate", "sample_rate", "supported_languages"):
        assert hasattr(cls, name), f"MossTTSV15Backend missing {name!r}"


def test_pep562_lazy_import():
    """The lazy registry resolves the class on first access."""
    mod = importlib.import_module("services.tts_backend")
    cls = mod._REGISTRY["moss-tts-v15"]
    assert cls.__name__ == "MossTTSV15Backend"


def test_install_hint_present():
    """A Settings tooltip points users at the clone + env var."""
    from services.tts_backend import _INSTALL_HINTS

    hint = _INSTALL_HINTS.get("moss-tts-v15", "")
    assert "OMNIVOICE_MOSS_TTS_V15_DIR" in hint
    assert "OpenMOSS" in hint


def test_sidecar_script_ships():
    """The sidecar entrypoint ships with the install (the parent spawns it)."""
    from engines.moss_tts_v15.bootstrap import MOSS_TTS_V15_SIDECAR_SCRIPT

    assert MOSS_TTS_V15_SIDECAR_SCRIPT.name == "main.py"
    assert MOSS_TTS_V15_SIDECAR_SCRIPT.is_file()


def test_default_model_source_is_pinned(monkeypatch):
    from engines.moss_tts_v15 import main
    monkeypatch.delenv("OMNIVOICE_MOSS_TTS_V15_MODEL", raising=False)
    assert main._model_source() == (main._DEFAULT_REPO, main._DEFAULT_REVISION)


def test_default_model_revision_matches_the_central_reviewed_pin():
    from engines.moss_tts_v15 import main
    from services.hf_revisions import revision_for

    assert main._DEFAULT_REVISION == revision_for(main._DEFAULT_REPO)


def test_custom_remote_code_is_rejected_without_explicit_opt_in(monkeypatch):
    from engines.moss_tts_v15 import main
    monkeypatch.setenv("OMNIVOICE_MOSS_TTS_V15_MODEL", "someone/custom-model")
    monkeypatch.delenv("OMNIVOICE_MOSS_TTS_V15_TRUST_REMOTE_CODE", raising=False)
    monkeypatch.setenv("OMNIVOICE_MOSS_TTS_V15_REVISION", "a" * 40)
    with pytest.raises(RuntimeError, match="after auditing"):
        main._model_source()


def test_custom_remote_code_requires_immutable_revision(monkeypatch):
    from engines.moss_tts_v15 import main
    monkeypatch.setenv("OMNIVOICE_MOSS_TTS_V15_MODEL", "someone/custom-model")
    monkeypatch.setenv("OMNIVOICE_MOSS_TTS_V15_TRUST_REMOTE_CODE", "1")
    monkeypatch.setenv("OMNIVOICE_MOSS_TTS_V15_REVISION", "main")
    with pytest.raises(RuntimeError, match="40-character commit SHA"):
        main._model_source()


def test_audited_custom_remote_code_requires_both_opt_ins(monkeypatch):
    from engines.moss_tts_v15 import main
    revision = "b" * 40
    monkeypatch.setenv("OMNIVOICE_MOSS_TTS_V15_MODEL", "someone/custom-model")
    monkeypatch.setenv("OMNIVOICE_MOSS_TTS_V15_TRUST_REMOTE_CODE", "true")
    monkeypatch.setenv("OMNIVOICE_MOSS_TTS_V15_REVISION", revision)
    assert main._model_source() == ("someone/custom-model", revision)


# ── hardware honesty (cross-platform rule) ─────────────────────────────────


def test_gpu_compat_cuda_cpu_no_mps():
    """MPS is undocumented/untested upstream — we must not claim it."""
    from engines.moss_tts_v15 import MossTTSV15Backend

    assert MossTTSV15Backend.gpu_compat == ("cuda", "cpu"), (
        f"expected ('cuda', 'cpu'), got {MossTTSV15Backend.gpu_compat!r}"
    )


def test_is_available_not_installed_is_honest(monkeypatch):
    """When the venv isn't present, is_available() gates cleanly with an
    actionable hint and never claims MPS."""
    monkeypatch.setattr(
        "engines.moss_tts_v15.bootstrap.is_moss_tts_v15_installed",
        lambda: False,
    )
    from engines.moss_tts_v15 import MossTTSV15Backend

    ok, msg = MossTTSV15Backend.is_available()
    assert ok is False
    assert "OMNIVOICE_MOSS_TTS_V15_DIR" in msg
    assert "docs/engines/moss-tts-v15.md" in msg  # actionable pointer
    # Honesty on hardware is enforced by gpu_compat (no 'mps' entry); the
    # message is free to *disclaim* MPS ("no MPS"), which is the opposite of
    # claiming it.


def test_sample_rate_and_languages():
    from engines.moss_tts_v15 import MossTTSV15Backend

    b = MossTTSV15Backend()
    assert b.sample_rate == 24000
    assert b.supported_languages == ["multi"]


# ── generate() parent-side arbitration ─────────────────────────────────────


def test_duration_maps_to_tokens(monkeypatch):
    """``duration`` (seconds) → ``tokens`` at 12.5 tokens/sec; engine-specific
    kwargs are forwarded and the generic ``num_step`` is dropped."""
    captured: dict = {}

    def fake_super_generate(self, text, **kw):
        import torch
        captured["text"] = text
        captured.update(kw)
        return torch.zeros(1, 8)

    from engines.moss_tts_v15 import MossTTSV15Backend
    # Patch the exact SubprocessBackend in this backend's MRO (not via a
    # module-path string): survives the sys.modules['services.*'] reloads
    # other tests perform, so super().generate() hits the fake instead of
    # dispatching to the real class and trying to spawn a sidecar. (#498)
    _sub = next(c for c in MossTTSV15Backend.__mro__ if c.__name__ == "SubprocessBackend")
    monkeypatch.setattr(_sub, "generate", fake_super_generate)

    MossTTSV15Backend().generate(
        "hello world",
        ref_audio="/tmp/spk.wav",
        language="fr",
        duration=26.0,
        num_step=16,           # generic kwarg MOSS doesn't use
        max_new_tokens=2048,
    )
    assert captured["text"] == "hello world"
    assert captured["ref_audio"] == "/tmp/spk.wav"
    assert captured["language"] == "fr"
    assert captured["tokens"] == int(26.0 * 12.5)  # 325
    assert captured["max_new_tokens"] == 2048
    assert "num_step" not in captured  # not part of MOSS's surface


def test_generate_without_ref_audio_omits_reference(monkeypatch):
    """No ref_audio → plain TTS: neither ref_audio nor tokens leak in."""
    captured: dict = {}

    def fake_super_generate(self, text, **kw):
        import torch
        captured.update(kw)
        return torch.zeros(1, 8)

    from engines.moss_tts_v15 import MossTTSV15Backend
    # Patch the exact SubprocessBackend in this backend's MRO (not via a
    # module-path string): survives the sys.modules['services.*'] reloads
    # other tests perform, so super().generate() hits the fake instead of
    # dispatching to the real class and trying to spawn a sidecar. (#498)
    _sub = next(c for c in MossTTSV15Backend.__mro__ if c.__name__ == "SubprocessBackend")
    monkeypatch.setattr(_sub, "generate", fake_super_generate)

    MossTTSV15Backend().generate("just text")
    assert "ref_audio" not in captured
    assert "tokens" not in captured
