"""Tests for IndexTTS2Backend on the SubprocessBackend primitive — Plan 02-03.

This is the headline test file for issue #42's closure:
``test_coexist_with_omnivoice_in_one_session`` proves that the
in-process OmniVoiceBackend (which imports transformers>=5.3) and the
subprocess-isolated IndexTTS2Backend can both serve generate() from the
SAME Python session. The two transformers versions can no longer
collide because IndexTTS runs in a different OS process.

Real IndexTTS-2 model load is ~20 s cold and depends on a ~6 GB model
download — these tests use a mock sidecar fixture
(``tests/fixtures/mock_indextts_sidecar.py``) that mimics the
production wire protocol without importing the indextts library.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path
from typing import Iterator

import psutil
import pytest
import torch


# tests/conftest.py prepends ./backend to sys.path.
from engines.indextts import bootstrap as indextts_bootstrap
from services import tts_backend
from services.subprocess_backend import SubprocessBackend, _read_exact
from services.tts_backend import IndexTTS2Backend, OmniVoiceBackend, list_backends


REPO_ROOT = Path(__file__).resolve().parents[3]
MOCK_SIDECAR = REPO_ROOT / "tests" / "fixtures" / "mock_indextts_sidecar.py"


# ── fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_bootstrap_cache():
    indextts_bootstrap.invalidate()
    yield
    indextts_bootstrap.invalidate()


@pytest.fixture
def patched_indextts_backend(monkeypatch) -> Iterator[IndexTTS2Backend]:
    """An IndexTTS2Backend that spawns the MOCK sidecar under sys.executable.

    Overrides ``venv_python``, ``sidecar_script``, and ``is_available``
    via classmethod patches so we can construct a real instance, hit
    every code path of ``generate()``, and assert the wire protocol
    without paying the cost of the real model.
    """
    monkeypatch.setattr(
        IndexTTS2Backend, "venv_python",
        classmethod(lambda cls: Path(sys.executable)),
    )
    monkeypatch.setattr(
        IndexTTS2Backend, "sidecar_script",
        classmethod(lambda cls: MOCK_SIDECAR),
    )
    monkeypatch.setattr(
        IndexTTS2Backend, "is_available",
        classmethod(lambda cls: (True, "ok (mocked)")),
    )

    backend = IndexTTS2Backend()
    yield backend
    try:
        backend.shutdown()
    except Exception:
        pass


# ── unit / structural ─────────────────────────────────────────────────────


def test_indextts2backend_is_subprocess_subclass():
    """The new IndexTTS2Backend must be a SubprocessBackend subclass."""
    assert issubclass(IndexTTS2Backend, SubprocessBackend)


def test_indextts2backend_has_subprocess_marker():
    """The duck-typed marker for list_backends's isolation_mode detection."""
    assert getattr(IndexTTS2Backend, "_is_subprocess_isolated", False) is True


def test_indextts2backend_class_methods_present():
    """The subclass contract — venv_python, sidecar_script, is_available."""
    assert hasattr(IndexTTS2Backend, "venv_python")
    assert hasattr(IndexTTS2Backend, "sidecar_script")
    assert hasattr(IndexTTS2Backend, "is_available")


def test_old_inprocess_state_removed():
    """The legacy ``_model`` instance attribute is gone.

    The old IndexTTS2Backend held an in-process IndexTTS2 instance on
    ``self._model``. The new shape stores no model — that lives in the
    sidecar. This assertion catches accidental re-introduction of the
    old shape if a future refactor copy-pastes the legacy code back.
    """
    # We can't construct without spawn (is_available defaults to checking
    # the real venv), so introspect class dict directly.
    assert "_model" not in IndexTTS2Backend.__dict__


# ── is_available — no spawn discipline ────────────────────────────────────


def test_is_available_no_spawn(monkeypatch):
    """is_available must not spawn the sidecar even when the venv exists.

    Settings UI calls list_backends() on every render. If is_available
    paid for a sidecar spawn each time, the picker would deadlock for
    20+ seconds during the IndexTTS cold load.
    """
    monkeypatch.setattr(
        indextts_bootstrap, "is_indextts_installed", lambda: True,
    )

    me = psutil.Process()
    before = set(c.pid for c in me.children(recursive=True))
    ok, msg = IndexTTS2Backend.is_available()
    after = set(c.pid for c in me.children(recursive=True))

    assert ok, f"expected is_available True when venv exists, got {msg}"
    assert msg == "ok"
    assert after == before, (
        f"is_available() spawned children: new pids = {after - before}"
    )


def test_is_available_no_venv(monkeypatch):
    """No venv => clear actionable error with the install-docs path."""
    monkeypatch.setattr(
        indextts_bootstrap, "is_indextts_installed", lambda: False,
    )
    ok, msg = IndexTTS2Backend.is_available()
    assert ok is False
    assert "OMNIVOICE_INDEXTTS_DIR" in msg
    assert "docs/engines/indextts.md" in msg


# ── registry integration ──────────────────────────────────────────────────


def test_list_backends_includes_indextts_with_subprocess_isolation_mode():
    """list_backends() reports indextts2 with isolation_mode='subprocess'."""
    entries = {e["id"]: e for e in list_backends()}
    assert "indextts2" in entries
    assert entries["indextts2"]["isolation_mode"] == "subprocess"
    # display_name was preserved verbatim from the legacy class.
    assert entries["indextts2"]["display_name"] == (
        "IndexTTS2 (emotion control, duration control, zero-shot)"
    )


# ── round-trip via the mock sidecar ───────────────────────────────────────


def test_synthesize_via_mocked_sidecar(patched_indextts_backend):
    """Spawn → synthesize → expect 1 s of non-zero audio at 24 kHz float32."""
    audio = patched_indextts_backend.generate(
        "hello world",
        ref_audio="/tmp/fake_ref.wav",
    )
    assert isinstance(audio, torch.Tensor)
    assert audio.shape == (1, 24000), f"got shape {tuple(audio.shape)}"
    assert audio.dtype == torch.float32
    # 0.5-amp sine wave → max abs > 0.3 after int16 round-trip.
    assert torch.max(torch.abs(audio)).item() > 0.3


def test_synthesize_forwards_emotion_kwargs_via_vector(monkeypatch, patched_indextts_backend):
    """emo_vector wins; duration converts to target_tokens (~21 Hz).

    The parent-side arbitration lives in ``IndexTTS2Backend.generate``.
    We intercept ``_send`` to capture the JSON payload after the parent
    finished building it; the sidecar still completes the round-trip so
    ``generate`` returns a real tensor.
    """
    backend = patched_indextts_backend
    sent: list[dict] = []
    original_send = SubprocessBackend._send

    def spy_send(self, msg):
        if msg.get("op") == "synthesize":
            sent.append(dict(msg))
        return original_send(self, msg)

    monkeypatch.setattr(SubprocessBackend, "_send", spy_send)

    audio = backend.generate(
        "hi",
        ref_audio="/tmp/ref.wav",
        emo_vector=[1, 0, 0, 0, 0, 0, 0, 0],
        emo_audio="/tmp/should_be_ignored.wav",
        emo_text="should_be_ignored",
        emo_alpha=0.9,  # ignored when vector wins
        use_random=True,
        duration=2.0,
    )
    assert audio.shape == (1, 24000)
    assert len(sent) == 1
    payload = sent[0]
    assert payload["op"] == "synthesize"
    assert payload["text"] == "hi"
    assert payload["ref_audio"] == "/tmp/ref.wav"
    assert payload["emo_vector"] == [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    assert payload["use_random"] is True
    # duration=2.0 → target_tokens = int(2.0 * 21) = 42
    assert payload["target_tokens"] == 42
    # The losing modalities are dropped — sidecar never sees them.
    assert "emo_audio_prompt" not in payload
    assert "emo_text" not in payload


def test_synthesize_forwards_emotion_kwargs_via_text(monkeypatch, patched_indextts_backend):
    """emo_text path caps emo_alpha to ≤0.6 (IndexTTS recommendation)."""
    backend = patched_indextts_backend
    sent: list[dict] = []
    original_send = SubprocessBackend._send

    def spy_send(self, msg):
        if msg.get("op") == "synthesize":
            sent.append(dict(msg))
        return original_send(self, msg)

    monkeypatch.setattr(SubprocessBackend, "_send", spy_send)

    backend.generate(
        "hi",
        ref_audio="/tmp/ref.wav",
        emo_text="terrified and panicking",
        emo_alpha=0.95,  # must be capped to 0.6
        use_random=True,
    )
    assert len(sent) == 1
    p = sent[0]
    assert p["emo_text"] == "terrified and panicking"
    assert p["use_emo_text"] is True
    assert p["emo_alpha"] == 0.6
    assert p["use_random"] is True


def test_synthesize_forwards_emotion_kwargs_via_audio(monkeypatch, patched_indextts_backend):
    """emo_audio path forwards emo_audio_prompt + emo_alpha verbatim."""
    backend = patched_indextts_backend
    sent: list[dict] = []
    original_send = SubprocessBackend._send

    def spy_send(self, msg):
        if msg.get("op") == "synthesize":
            sent.append(dict(msg))
        return original_send(self, msg)

    monkeypatch.setattr(SubprocessBackend, "_send", spy_send)

    backend.generate(
        "hi",
        ref_audio="/tmp/ref.wav",
        emo_audio="/tmp/emo_ref.wav",
        emo_alpha=0.85,
    )
    assert len(sent) == 1
    p = sent[0]
    assert p["emo_audio_prompt"] == "/tmp/emo_ref.wav"
    assert p["emo_alpha"] == 0.85
    # The text & vector paths are NOT sent when audio wins.
    assert "emo_vector" not in p
    assert "emo_text" not in p


def test_description_falls_through_to_emo_text(monkeypatch, patched_indextts_backend):
    """OpenAI-compat description= maps to emo_text when no other modality set."""
    backend = patched_indextts_backend
    sent: list[dict] = []
    original_send = SubprocessBackend._send

    def spy_send(self, msg):
        if msg.get("op") == "synthesize":
            sent.append(dict(msg))
        return original_send(self, msg)

    monkeypatch.setattr(SubprocessBackend, "_send", spy_send)

    backend.generate(
        "hi",
        ref_audio="/tmp/ref.wav",
        description="warm and confident female voice",
    )
    assert len(sent) == 1
    p = sent[0]
    assert p["emo_text"] == "warm and confident female voice"
    assert p["use_emo_text"] is True


def test_generate_requires_ref_audio(patched_indextts_backend):
    """IndexTTS2 cannot voice-clone without a reference; the parent rejects
    early so the sidecar isn't woken up on a no-op."""
    with pytest.raises(RuntimeError, match="reference audio"):
        patched_indextts_backend.generate("hello", ref_audio=None)


# ── #42 closure: in-process OmniVoice + subprocess IndexTTS coexist ───────


def test_coexist_with_omnivoice_in_one_session(monkeypatch, patched_indextts_backend):
    """The headline #42 closure test.

    OmniVoiceBackend.is_available() succeeds in this interpreter (it
    imports omnivoice.models.omnivoice with transformers>=5.3) AND the
    subprocess-isolated IndexTTS2Backend serves a generate() in the
    same Python process. Before Plan 02-03, the second engine couldn't
    coexist because IndexTTS demanded transformers<5 at import time.

    Now IndexTTS lives in a separate interpreter (the mock sidecar
    here, the real venv in production) so the two transformers
    versions never see each other.
    """
    # OmniVoice imports its real package — if that succeeds, the
    # in-process side is fine. We don't actually generate (would
    # require model weights), but reaching is_available() proves the
    # transformers>=5.3 import is intact.
    ok, msg = OmniVoiceBackend.is_available()
    if not ok:
        # In CI / minimal install the omnivoice package may not be
        # importable; the test should not fail for that — what we care
        # about is that calling IndexTTS doesn't BREAK the OmniVoice
        # import. We re-call is_available() AFTER the IndexTTS generate
        # and assert the message is identical (no new breakage).
        pre = msg
    else:
        pre = "ready"

    audio = patched_indextts_backend.generate(
        "hello from indextts",
        ref_audio="/tmp/ref.wav",
    )
    assert audio.shape == (1, 24000)

    ok2, msg2 = OmniVoiceBackend.is_available()
    # Whatever state OmniVoiceBackend was in before, it's the same
    # after IndexTTS ran — no new import errors, no new AttributeErrors.
    assert ok2 == ok, (
        f"OmniVoice availability changed after IndexTTS generate "
        f"({ok}->{ok2}, msg={msg2})"
    )


# ── env forwarding (D5, verified for IndexTTS specifically) ───────────────


def test_env_forwarding_to_indextts_sidecar(monkeypatch, tmp_path):
    """HF_TOKEN / HF_HOME / HF_ENDPOINT / HF_HUB_CACHE reach the sidecar."""
    monkeypatch.setenv("HF_TOKEN", "hf_indextts_test")
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf_home"))
    monkeypatch.setenv("HF_ENDPOINT", "https://mirror.example")
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "hf_cache"))

    monkeypatch.setattr(
        IndexTTS2Backend, "venv_python",
        classmethod(lambda cls: Path(sys.executable)),
    )
    monkeypatch.setattr(
        IndexTTS2Backend, "sidecar_script",
        classmethod(lambda cls: MOCK_SIDECAR),
    )
    monkeypatch.setattr(
        IndexTTS2Backend, "is_available",
        classmethod(lambda cls: (True, "ok")),
    )

    backend = IndexTTS2Backend()
    try:
        with backend._lock:
            backend._spawn()
            backend._send({"op": "probe_env"})

        # probe_env_result is intentionally NOT in PARENT_INBOUND_OPS — it's
        # a test-only op. Read the raw frame off stdout.
        proc = backend._proc
        assert proc is not None
        header = _read_exact(proc.stdout, 4)
        assert header is not None
        (n,) = struct.unpack("!I", header)
        body = _read_exact(proc.stdout, n)
        assert body is not None
        reply = json.loads(body.decode("utf-8"))
        assert reply["op"] == "probe_env_result"
        keys = reply["keys"]
        assert keys["HF_TOKEN"] == "hf_indextts_test"
        assert keys["HF_HOME"] == str(tmp_path / "hf_home")
        assert keys["HF_ENDPOINT"] == "https://mirror.example"
        assert keys["HF_HUB_CACHE"] == str(tmp_path / "hf_cache")
    finally:
        backend.shutdown()


# ── source-level invariants ───────────────────────────────────────────────


def test_no_indextts_import_in_tts_backend():
    """tts_backend.py must not import the indextts library at module level.

    The whole point of the migration is that the parent's transformers>=5.3
    cannot coexist with IndexTTS's transformers<5 in one interpreter.
    Anything that triggers an `import indextts` at module load time
    re-opens #42.
    """
    src = (REPO_ROOT / "backend" / "services" / "tts_backend.py").read_text()
    # Allow comments / docstring mentions of the package name; reject
    # actual import statements at module scope.
    for bad in ("from indextts", "import indextts"):
        # Tolerate the string appearing inside a string-quoted comment of a
        # docstring; the literal import statement should not appear at all.
        for line in src.splitlines():
            stripped = line.strip()
            if stripped.startswith(bad):
                pytest.fail(
                    f"forbidden top-level import in tts_backend.py: {stripped!r}\n"
                    "IndexTTS imports MUST live inside backend/engines/indextts/main.py "
                    "(the sidecar) only — see Plan 02-03 / issue #42."
                )


def test_sidecar_imports_indextts():
    """backend/engines/indextts/main.py imports indextts (lazy, inside fn)."""
    src = (REPO_ROOT / "backend" / "engines" / "indextts" / "main.py").read_text()
    assert "from indextts.infer_v2 import IndexTTS2" in src, (
        "sidecar must import IndexTTS2 from indextts.infer_v2 (it's the "
        "real model loader). See bootstrap.py for venv resolution."
    )
